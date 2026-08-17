/**
 * Permission decision engine.
 *
 * The evaluation order is a direct port of Zed 1.15.0
 * `crates/agent/src/tool_permissions.rs` (`from_input` at 214-365 and
 * `check_commands` at 378-431), with two omp-toolgate additions:
 *
 * - a rule may carry a `scope`, which is ANDed with its pattern (design D4), and
 * - a symlink escape raises `allow` to `confirm` as a floor that configuration
 *   cannot disable (design D8).
 *
 * Two Zed behaviors are deliberately not ported. Zed's hardcoded `rm -rf /`
 * rules stay with omp's native `bash` tool, which keeps its own critical guard
 * because this extension never shadows it (design D1). Zed's blanket rejection
 * of commands containing `$VAR` / `$(...)` / backticks is a non-goal because
 * omp's `bash` runs under a PTY and uses shell expansion daily; sub-command
 * extraction below covers the injection vector that rejection was guarding, and
 * an expansion is refused only where it stands in the command-name position and
 * so hides which program runs.
 */

import { basename } from "node:path";
import { MODE_STRICTNESS, MUTATING_VIRTUAL_TOOLS } from "./types.ts";
import type {
  CompiledRule,
  Decision,
  DecisionInput,
  MappedCall,
  SplitCommand,
  ToolPermissionMode,
  ToolPermissions,
  ToolRules,
} from "./types.ts";

/** The one virtual tool whose inputs are shell commands. */
const TERMINAL_TOOL = "terminal";

/** Redirection target that never needs a permission check. */
const DEV_NULL = "/dev/null";

/** Guards against a stack overflow on pathologically nested substitutions. */
const MAX_NESTING_DEPTH = 32;

/**
 * A `${…}` body that is a bare parameter name or positional number, and so
 * expands to a value rather than to text derived from one.
 */
const PLAIN_PARAMETER = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+)$/;

/**
 * A leading `NAME=value` word, which sets a variable for the command that
 * follows instead of naming a program itself.
 */
const ASSIGNMENT_PREFIX = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Reserved words that introduce a command rather than being one, so the program
 * that runs is named by the word after them. In the command-name position bash
 * always reads these as keywords, so treating them as prefixes is what the
 * shell does, not a guess.
 */
const COMMAND_INTRODUCERS: Readonly<Record<string, true>> = {
  "!": true,
  "{": true,
  do: true,
  elif: true,
  else: true,
  if: true,
  then: true,
  time: true,
  until: true,
  while: true,
};

/**
 * Characters that make a bare `$` an expansion: a parameter name, a positional
 * number, or one of the special parameters. Deliberately generous — a `$` that
 * expands to nothing costs one prompt, a `$` mistaken for a literal costs the
 * whole judgement.
 */
const EXPANDS_AFTER_DOLLAR = /[A-Za-z0-9_@*#?!$-]/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Decides the permission mode for one virtual tool.
 *
 * `inputs` are the strings this virtual tool wants to act on: normalized paths,
 * shell commands, or URLs. For `terminal`, each command is first expanded into
 * its sub-commands so an `always_allow` of `^ls` cannot approve `ls && wget x`.
 */
export function decide(
  virtualTool: string,
  inputs: readonly DecisionInput[],
  permissions: ToolPermissions,
): Decision {
  const rules = permissions.tools[virtualTool];

  // A configuration that does not compile blocks the tool outright, so a typo in
  // an `always_deny` pattern can never silently widen what is permitted.
  if (rules !== undefined && rules.invalidPatterns.length > 0) {
    return denyForInvalidPatterns(virtualTool, rules, inputs);
  }

  if (rules === undefined) {
    return escapeFloor(
      unexpandedFloor(
        protectedFloor(
          {
            mode: permissions.default,
            virtualTool,
            reason: `${virtualTool}: no rules configured, so the global default (${permissions.default}) applies.`,
            cause: { kind: "default" },
            inputs,
          },
          permissions.protectedPaths,
        ),
      ),
    );
  }

  let evaluated = inputs;
  let splitFailure: string | undefined;
  if (virtualTool === TERMINAL_TOOL) {
    const expanded: DecisionInput[] = [];
    for (const input of inputs) {
      const attempt = trySplitCommand(input.value);
      if (attempt.split === undefined) {
        // Unparseable command: check it whole and refuse to auto-approve it.
        splitFailure ??= attempt.failure;
        expanded.push(input);
        continue;
      }
      for (const command of attempt.split.commands) expanded.push({ ...input, value: command });
      // Write targets are checked here as well as by `write_file` (which the
      // mapping step derives from the same list), so an `always_allow` on the
      // command name alone cannot approve `printf x > .env`.
      for (const target of attempt.split.redirects) {
        expanded.push({ ...input, value: `> ${target}` });
      }
    }
    evaluated = expanded;
  }

  return escapeFloor(
    unexpandedFloor(
      protectedFloor(
        unparseableFloor(
          checkInputs(virtualTool, evaluated, rules, splitFailure, permissions.default),
          splitFailure,
        ),
        permissions.protectedPaths,
      ),
    ),
  );
}

/**
 * Decides one real tool call that maps to several virtual tools, taking the
 * strictest outcome (`deny` > `confirm` > `allow`, design D7).
 */
export function decideCalls(
  calls: readonly MappedCall[],
  permissions: ToolPermissions,
): Decision {
  let result: Decision | undefined;
  for (const call of calls) {
    const decision = decide(call.virtualTool, call.inputs, permissions);
    result = result === undefined ? decision : mostRestrictive(result, decision);
  }
  // The caller skips ungated calls, so an empty list never reaches us. Staying a
  // total function keeps that contract out of the callers.
  return (
    result ?? {
      mode: "allow",
      virtualTool: "",
      reason: "No virtual tool applies to this call.",
      cause: { kind: "default" },
      inputs: [],
    }
  );
}

/** Returns the stricter of two decisions, preferring `a` on a tie. */
export function mostRestrictive(a: Decision, b: Decision): Decision {
  return MODE_STRICTNESS[b.mode] > MODE_STRICTNESS[a.mode] ? b : a;
}

/**
 * Matches one compiled rule against one input.
 *
 * Scope and pattern are ANDed. An explicit `inside` / `outside` scope never
 * matches an input that carries no scope, which is how command and URL inputs
 * stay out of path-only rules. A rule with no pattern matches on scope alone.
 */
export function matchesRule(rule: CompiledRule, input: DecisionInput): boolean {
  const scope = rule.scope;
  if ((scope === "inside" || scope === "outside") && input.scope !== scope) return false;
  // Compiled rules never carry the `g` flag, so `test` holds no `lastIndex`
  // state between calls and the regex objects are safe to reuse.
  return rule.regex === undefined || rule.regex.test(input.value);
}

/**
 * Splits a shell command into the pieces that each need to be checked: the
 * sub-commands, and the files the command writes through a redirection.
 *
 * Returns `undefined` when the command cannot be split with confidence, which
 * disables `always_allow` for that command rather than guessing.
 *
 * Words are unquoted and rejoined with single spaces, mirroring Zed's
 * `extract_commands`, so `r'm' -rf '/'` is checked as `rm -rf /` and quoting
 * cannot be used to slip past a pattern. A plain parameter expansion keeps its
 * source text (`rm -rf $HOME` stays `rm -rf $HOME`), while the contents of
 * command substitutions, subshells and process substitutions are extracted as
 * their own sub-commands. An expansion whose result cannot be known from the
 * text — `$'\x72\x6d'`, `${x-rm}` — is refused outright rather than emitted as
 * a literal that no rule would match.
 *
 * Position decides what an expansion costs. In an argument it leaves the
 * program readable, so `echo ${HOME}` and `awk '{print $1}'` split as written.
 * In the command-name position it *is* the program, and `x=r; y=m; $x$y -rf ~`
 * splits into three sub-commands that contain no `rm` at all, so a first word
 * carrying an expansion is refused like an unparseable command. A leading
 * `NAME=value` assignment or a reserved word (`if`, `time`, …) introduces the
 * command rather than being it, so the word after it is the one judged.
 *
 * `redirects` holds the write targets (`>`, `>>`, `>|`, `&>`, `<>`), bare and
 * unquoted, so that `write_file` rules can be applied to them too. A read
 * redirection creates nothing, so its target stays a `< <target>` entry among
 * the sub-commands instead: `terminal` still sees it, but it must not be
 * mistaken for a write. A redirection to `/dev/null`, a file descriptor
 * duplication, and a here-document contribute nothing at all.
 *
 * Constructs this splitter does not model (brace groups, control-flow keywords)
 * simply leave their keywords as extra sub-commands. That can only make
 * `always_allow` harder to satisfy, never easier.
 */
export function splitCommand(command: string): SplitCommand | undefined {
  return trySplitCommand(command).split;
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

/** One rule/input pair that decided something, kept for the reason text. */
interface RuleHit {
  readonly rule: CompiledRule;
  readonly input: DecisionInput;
}

function firstHit(
  rules: readonly CompiledRule[],
  input: DecisionInput,
): CompiledRule | undefined {
  for (const rule of rules) {
    if (matchesRule(rule, input)) return rule;
  }
  return undefined;
}

/**
 * Single pass over the inputs, exactly as Zed's `check_commands`:
 * `always_deny` returns on the first match, `always_confirm` records a pending
 * confirm, and `always_allow` must match *every* input. An empty input list
 * therefore falls through to a default instead of being allowed.
 */
function checkInputs(
  virtualTool: string,
  inputs: readonly DecisionInput[],
  rules: ToolRules,
  /** When set, `always_allow` is skipped and this says why, for the reason text. */
  splitFailure: string | undefined,
  globalDefault: ToolPermissionMode,
): Decision {
  let confirmHit: RuleHit | undefined;
  let allowHit: RuleHit | undefined;
  let allMatchedAllow = true;
  let hadAnyInputs = false;

  for (const input of inputs) {
    hadAnyInputs = true;

    const denied = firstHit(rules.always_deny, input);
    if (denied !== undefined) {
      return {
        mode: "deny",
        virtualTool,
        reason:
          `${virtualTool}: denied by always_deny ${describeRule(denied)} from ${denied.origin}` +
          `, matching ${JSON.stringify(input.value)}.`,
        cause: {
          kind: "rule",
          list: "always_deny",
          pattern: denied.source,
          scope: denied.scope,
          origin: denied.origin,
          input: input.value,
        },
        inputs,
      };
    }

    const confirmed = firstHit(rules.always_confirm, input);
    if (confirmed !== undefined && confirmHit === undefined) {
      confirmHit = { rule: confirmed, input };
    }

    const allowed = firstHit(rules.always_allow, input);
    if (allowed === undefined) allMatchedAllow = false;
    else if (allowHit === undefined) allowHit = { rule: allowed, input };
  }

  if (confirmHit !== undefined) {
    return {
      mode: "confirm",
      virtualTool,
      reason:
        `${virtualTool}: confirmation required by always_confirm ` +
        `${describeRule(confirmHit.rule)} from ${confirmHit.rule.origin}` +
        `, matching ${JSON.stringify(confirmHit.input.value)}.`,
      cause: {
        kind: "rule",
        list: "always_confirm",
        pattern: confirmHit.rule.source,
        scope: confirmHit.rule.scope,
        origin: confirmHit.rule.origin,
        input: confirmHit.input.value,
      },
      inputs,
    };
  }

  if (splitFailure === undefined && allMatchedAllow && hadAnyInputs && allowHit !== undefined) {
    return {
      mode: "allow",
      virtualTool,
      reason:
        `${virtualTool}: allowed by always_allow, matched by all ${inputs.length} ` +
        `${inputs.length === 1 ? "input" : "inputs"} (for example ` +
        `${JSON.stringify(allowHit.input.value)} matched ${describeRule(allowHit.rule)} ` +
        `from ${allowHit.rule.origin}).`,
      cause: {
        kind: "rule",
        list: "always_allow",
        pattern: allowHit.rule.source,
        scope: allowHit.rule.scope,
        origin: allowHit.rule.origin,
        input: allowHit.input.value,
      },
      inputs,
    };
  }

  const mode = rules.default ?? globalDefault;
  const which = rules.default === undefined ? "global default" : `${virtualTool} default`;
  const note =
    splitFailure === undefined
      ? ""
      : " always_allow was not evaluated because the command could not be split into " +
        `sub-commands: ${splitFailure}.`;
  return {
    mode,
    virtualTool,
    reason: `${virtualTool}: no rule matched, so the ${which} (${mode}) applies.${note}`,
    cause: { kind: "default" },
    inputs,
  };
}

function denyForInvalidPatterns(
  virtualTool: string,
  rules: ToolRules,
  inputs: readonly DecisionInput[],
): Decision {
  const invalid = rules.invalidPatterns;
  const first = invalid[0];
  const word = invalid.length === 1 ? "pattern" : "patterns";
  const example =
    first === undefined
      ? ""
      : ` The first one is ${JSON.stringify(first.pattern)} from ${first.origin}.`;
  return {
    mode: "deny",
    virtualTool,
    reason:
      `${virtualTool}: blocked because ${invalid.length} regex ${word} failed to compile.` +
      `${example} Fix the invalid ${word} in your tool-permissions configuration.`,
    cause: { kind: "invalid-pattern" },
    inputs,
  };
}

/**
 * Raises `allow` to `confirm` when the command could not be read.
 *
 * Disabling `always_allow` is not enough on its own: with a `default` of `allow`
 * — which the README's own recommended shape uses for `terminal`, protecting
 * itself with `always_confirm` patterns — an unreadable command would sail past
 * the pattern lists that were never able to see what it really runs. `$'\x72\x6d'`
 * expands to `rm` in the shell and matches no `\brm\b` rule as written, and
 * `$x$y` in the command-name position hides the program entirely, so the only
 * honest answer is to ask. `splitFailure` says which of the two it was, and the
 * prompt shows it.
 */
function unparseableFloor(decision: Decision, splitFailure: string | undefined): Decision {
  if (splitFailure === undefined || decision.mode !== "allow") return decision;
  return {
    mode: "confirm",
    virtualTool: decision.virtualTool,
    reason:
      `${decision.virtualTool}: confirmation required because the command could not be split into ` +
      `sub-commands (${splitFailure}), so the rules could not be matched against what the shell ` +
      `would actually run. This cannot be disabled by configuration.`,
    cause: { kind: "unparseable" },
    inputs: decision.inputs,
  };
}

/**
 * Raises `allow` to `confirm` when a path argument still carries an expansion the
 * shell has not performed.
 *
 * It runs before {@link escapeFloor} because such a path is reported as an escape
 * too — the literal spelling sits inside the project while nothing says where the
 * expansion lands — and "through a symlink" would be the wrong explanation.
 */
function unexpandedFloor(decision: Decision): Decision {
  if (decision.mode !== "allow") return decision;
  const pending = decision.inputs.find((input) => input.unexpanded === true);
  if (pending === undefined) return decision;
  return {
    mode: "confirm",
    virtualTool: decision.virtualTool,
    reason:
      `${decision.virtualTool}: confirmation required because ${JSON.stringify(pending.value)} still ` +
      `contains an expansion the shell has not performed, so where it lands is not knowable here. ` +
      `This cannot be disabled by configuration.`,
    cause: { kind: "unexpanded", input: pending.value },
    inputs: decision.inputs,
  };
}

/**
 * Raises `allow` to `confirm` when any input escaped the project root through a
 * symlink (design D8). It is a floor rather than a short circuit, so a matching
 * `always_deny` still wins and configuration cannot disable it.
 */
function escapeFloor(decision: Decision): Decision {
  if (decision.mode !== "allow") return decision;
  const escaped = decision.inputs.find((input) => input.escaped === true);
  if (escaped === undefined) return decision;

  const target = escaped.resolved === undefined ? "" : ` (it resolves to ${escaped.resolved})`;
  return {
    mode: "confirm",
    virtualTool: decision.virtualTool,
    reason:
      `${decision.virtualTool}: confirmation required because ${JSON.stringify(escaped.value)} points ` +
      `outside the project root through a symlink${target}. This cannot be disabled by configuration.`,
    cause: { kind: "escape", input: escaped.value },
    inputs: decision.inputs,
  };
}

/** An input that reached a protected configuration file, and how it got there. */
interface ProtectedHit {
  readonly input: DecisionInput;
  /**
   * The protected file the input reached, or its bare name when only that
   * matched — two configuration files share one name, so a relative mention
   * cannot honestly be attributed to either.
   */
  readonly path: string;
  /** A path `is` the file; a shell command only `mentions` it. */
  readonly verb: "is" | "mentions";
}

/**
 * Raises `allow` to `confirm` when a call reaches one of the gate's own
 * configuration files. Without it a single `write_file.default: allow` lets the
 * agent rewrite the rules that were about to gate it, and the rewrite goes live
 * on the next reload.
 *
 * Like `escapeFloor` it only ever raises `allow`, so the two compose in either
 * order and either one firing is enough. Callers run this one first, so that a
 * symlink into the configuration is reported as the configuration rather than as
 * a generic escape.
 */
function protectedFloor(decision: Decision, protectedPaths: readonly string[]): Decision {
  if (decision.mode !== "allow") return decision;
  const hit = findProtected(decision.virtualTool, decision.inputs, protectedPaths);
  if (hit === undefined) return decision;

  return {
    mode: "confirm",
    virtualTool: decision.virtualTool,
    reason:
      `${decision.virtualTool}: confirmation required because ${JSON.stringify(hit.input.value)} ` +
      `${hit.verb} this gate's own tool-permissions configuration (${hit.path}). This cannot be ` +
      `disabled by configuration.`,
    cause: { kind: "protected", input: hit.input.value },
    inputs: decision.inputs,
  };
}

/**
 * Finds the first input that reaches a protected file.
 *
 * A path tool names the file it will open, so an exact match on the literal or
 * the resolved path is both necessary and enough: the literal catches the file
 * named directly, the resolved one catches a symlink pointing at it.
 *
 * A shell command is text. The redirection targets handed to `write_file` cover
 * only the writes the shell itself performs, and `cp evil.json <config>` or
 * `sed -i '' … <config>` opens the file on its own. Nothing in the command has
 * been resolved to a path, so every mention of a protected file, or of its name
 * alone, is treated as reaching it. That asks on a command that merely says
 * `tool-permissions.json`, which is the cheap direction to be wrong in.
 */
function findProtected(
  virtualTool: string,
  inputs: readonly DecisionInput[],
  protectedPaths: readonly string[],
): ProtectedHit | undefined {
  if (virtualTool === TERMINAL_TOOL) {
    // A whole path names one file and is reported as such. A bare file name is
    // only remembered, so that a command spelling out one configuration file is
    // never reported as the other.
    let byName: ProtectedHit | undefined;
    for (const input of inputs) {
      for (const path of protectedPaths) {
        if (input.value.includes(path)) return { input, path, verb: "mentions" };
        const name = basename(path);
        if (byName === undefined && input.value.includes(name)) {
          byName = { input, path: name, verb: "mentions" };
        }
      }
    }
    return byName;
  }

  if (MUTATING_VIRTUAL_TOOLS[virtualTool] !== true) return undefined;
  for (const input of inputs) {
    if (
      protectedPaths.includes(input.resolved ?? "") ||
      protectedPaths.includes(input.literal ?? "")
    ) {
      return { input, path: input.resolved ?? input.literal ?? "", verb: "is" };
    }
  }
  return undefined;
}

function describeRule(rule: CompiledRule): string {
  if (rule.regex === undefined) return `scope ${rule.scope}`;
  return rule.scope === "any" ? `/${rule.source}/` : `/${rule.source}/ with scope ${rule.scope}`;
}

// ---------------------------------------------------------------------------
// Shell command splitting
// ---------------------------------------------------------------------------

/** What one split attempt produced. `split` is `undefined` exactly when `failure` is set. */
interface SplitAttempt {
  readonly split: SplitCommand | undefined;
  /** Phrase naming what defeated the splitter, for the decision's reason text. */
  readonly failure: string | undefined;
}

/** Mutable state of one split pass: the two output lists and the first failure. */
interface Parse {
  readonly commands: string[];
  readonly redirects: string[];
  failure: string | undefined;
}

/**
 * `splitCommand` with the rejection reason kept, so that a user who suddenly
 * stops matching an `always_allow` can be told which construct cost them it.
 */
function trySplitCommand(command: string): SplitAttempt {
  const parse: Parse = { commands: [], redirects: [], failure: undefined };
  if (!collectCommands(command, parse, 0)) {
    // The fallback is load-bearing, not decoration: `decide` treats a failure
    // without text as no failure at all and would re-enable `always_allow`.
    return { split: undefined, failure: parse.failure ?? "it is not valid shell syntax" };
  }
  return {
    split: { commands: parse.commands, redirects: parse.redirects },
    failure: undefined,
  };
}

/** A word read from the command, both unquoted and as written. */
interface WordRead {
  /** Unquoted value, with expansions kept as source text. */
  readonly text: string;
  /** Source slice, needed to tell an unquoted `2` file descriptor from `'2'`. */
  readonly raw: string;
  /**
   * Whether the shell will substitute something into this word before running
   * it: `$name`, `${name}`, `$(…)` or a backquote. Harmless in an argument,
   * disqualifying in the command-name position.
   */
  readonly expansion: boolean;
  readonly next: number;
}

/** A redirection, reduced to the file it touches, if it touches one at all. */
interface RedirectRead {
  readonly target: string | undefined;
  /** Whether the redirection creates or truncates `target`. */
  readonly writes: boolean;
  readonly next: number;
}

/**
 * Appends every sub-command of one command list to `parse.commands` and every
 * write target to `parse.redirects`. Returns `false` when the text cannot be
 * split with confidence, leaving the reason in `parse.failure`.
 */
function collectCommands(text: string, parse: Parse, depth: number): boolean {
  if (depth > MAX_NESTING_DEPTH) {
    parse.failure ??= `substitutions are nested more than ${MAX_NESTING_DEPTH} deep`;
    return false;
  }

  let words: string[] = [];
  let reads: string[] = [];
  let writes: string[] = [];
  let nested: string[] = [];
  /**
   * Whether the program this segment runs is still to be read. An assignment
   * prefix or a reserved word introduces a command instead of being one, so
   * both leave it pending.
   */
  let awaitingName = true;

  /**
   * Ends the current segment. `binaryBefore` / `binaryAfter` say whether the
   * segment is an operand of `&&`, `||` or `|`, which may not be empty.
   */
  const endSegment = (binaryBefore: boolean, binaryAfter: boolean): boolean => {
    if (words.length === 0 && reads.length === 0 && writes.length === 0 && nested.length === 0) {
      if (!binaryBefore && !binaryAfter) return true;
      parse.failure ??= "an operand of &&, || or | is empty";
      return false;
    }
    const joined = words.join(" ").trim();
    if (joined !== "") parse.commands.push(joined);
    // A read target is no command, but leaving it out would let an
    // `always_allow` of `^cat` approve `cat < ~/.ssh/id_rsa`.
    for (const read of reads) parse.commands.push(`< ${read}`);
    for (const write of writes) parse.redirects.push(write);
    for (const inner of nested) {
      if (!collectCommands(inner, parse, depth + 1)) return false;
    }
    words = [];
    reads = [];
    writes = [];
    nested = [];
    awaitingName = true;
    return true;
  };

  /** Sorts the file a redirection touches, if any, into the two output lists. */
  const takeRedirect = (redirect: RedirectRead): void => {
    if (redirect.target === undefined) return;
    (redirect.writes ? writes : reads).push(redirect.target);
  };

  let i = 0;
  let binaryBefore = false;

  while (i < text.length) {
    const c = text.charAt(i);

    if (c === " " || c === "\t" || c === "\r") {
      i += 1;
      continue;
    }

    // Separators. `;`, `&` and newline are terminators and may end an empty
    // segment; `&&`, `||`, `|` and `|&` are binary and may not.
    if (c === "\n" || c === ";") {
      if (!endSegment(binaryBefore, false)) return false;
      binaryBefore = false;
      i += 1;
      continue;
    }
    if (c === "&") {
      const next = text.charAt(i + 1);
      if (next === "&") {
        if (!endSegment(binaryBefore, true)) return false;
        binaryBefore = true;
        i += 2;
        continue;
      }
      if (next === ">") {
        const redirect = readRedirect(text, i, nested, parse);
        if (redirect === undefined) return false;
        takeRedirect(redirect);
        i = redirect.next;
        continue;
      }
      if (!endSegment(binaryBefore, false)) return false;
      binaryBefore = false;
      i += 1;
      continue;
    }
    if (c === "|") {
      if (!endSegment(binaryBefore, true)) return false;
      binaryBefore = true;
      const next = text.charAt(i + 1);
      i += next === "|" || next === "&" ? 2 : 1;
      continue;
    }

    if (c === "<" || c === ">") {
      const redirect = readRedirect(text, i, nested, parse);
      if (redirect === undefined) return false;
      takeRedirect(redirect);
      i = redirect.next;
      continue;
    }

    // A subshell contributes its contents, not a command of its own.
    if (c === "(") {
      const close = findClosingParen(text, i + 1);
      if (close < 0) {
        parse.failure ??= "a ( group is not closed";
        return false;
      }
      nested.push(text.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (c === ")") {
      parse.failure ??= "a ) has no opening (";
      return false;
    }

    const word = readWord(text, i, nested, parse);
    if (word === undefined) return false;
    const after = text.charAt(word.next);
    if (/^[0-9]+$/.test(word.raw) && (after === "<" || after === ">")) {
      // `2>file`: the digits are a file descriptor, not a command word.
      const redirect = readRedirect(text, word.next, nested, parse);
      if (redirect === undefined) return false;
      takeRedirect(redirect);
      i = redirect.next;
      continue;
    }
    // The command name is the one word every rule is really about, so an
    // expansion there is not a value the shell will substitute into a readable
    // command — it *is* the command. `x=r; y=m; $x$y -rf ~` splits perfectly
    // well into three sub-commands and none of them contains `rm`, so refusing
    // the split is the only honest answer, exactly as for `$'\x72\x6d'`. An
    // expansion in an argument leaves the name readable and stays welcome.
    if (
      awaitingName &&
      !ASSIGNMENT_PREFIX.test(word.text) &&
      COMMAND_INTRODUCERS[word.text] !== true
    ) {
      if (word.expansion) {
        parse.failure ??=
          `the command name ${word.text} is produced by an expansion, which hides the ` +
          `program that will run`;
        return false;
      }
      awaitingName = false;
    }
    words.push(word.text);
    i = word.next;
  }

  return endSegment(binaryBefore, false);
}

/** Reads one word, stopping before whitespace or any shell metacharacter. */
function readWord(
  text: string,
  start: number,
  nested: string[],
  parse: Parse,
): WordRead | undefined {
  let value = "";
  let expansion = false;
  let i = start;

  while (i < text.length) {
    const c = text.charAt(i);
    if (
      c === " " ||
      c === "\t" ||
      c === "\r" ||
      c === "\n" ||
      c === ";" ||
      c === "&" ||
      c === "|" ||
      c === "<" ||
      c === ">" ||
      c === "(" ||
      c === ")"
    ) {
      break;
    }

    if (c === "\\") {
      if (i + 1 >= text.length) {
        parse.failure ??= "it ends in a backslash";
        return undefined;
      }
      const escaped = text.charAt(i + 1);
      // A backslash-newline is a line continuation and contributes nothing.
      if (escaped !== "\n") value += escaped;
      i += 2;
      continue;
    }

    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) {
        parse.failure ??= "a single quote is not closed";
        return undefined;
      }
      value += text.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    if (c === '"') {
      const quotedPart = readDoubleQuoted(text, i, nested, parse);
      if (quotedPart === undefined) return undefined;
      value += quotedPart.text;
      if (quotedPart.expansion) expansion = true;
      i = quotedPart.next;
      continue;
    }

    if (c === "`") {
      const substitution = readBackquote(text, i, nested, parse);
      if (substitution === undefined) return undefined;
      value += substitution.source;
      expansion = true;
      i = substitution.next;
      continue;
    }

    if (c === "$") {
      const next = text.charAt(i + 1);
      // ANSI-C and locale quoting rewrite their own contents, so what bash will
      // run is not the text in front of us: `$'\x72\x6d'` is `rm`. Emitting the
      // visible characters would hand `always_allow` a command nothing matches.
      if (next === "'" || next === '"') {
        parse.failure ??=
          "a $'…' or $\"…\" quote rewrites its own contents (for example $'\\x72\\x6d' is rm)";
        return undefined;
      }
      if (next === "(") {
        const substitution = readDollarParen(text, i, nested, parse);
        if (substitution === undefined) return undefined;
        value += substitution.source;
        expansion = true;
        i = substitution.next;
        continue;
      }
      if (next === "{") {
        const braced = readBraced(text, i, parse);
        if (braced === undefined) return undefined;
        value += braced.source;
        expansion = true;
        i = braced.next;
        continue;
      }
      // A bare `$name` is kept as its source text, which a rule can still read
      // in an argument. The command-name check is what stops it from standing
      // in for the program itself.
      if (EXPANDS_AFTER_DOLLAR.test(next)) expansion = true;
    }

    value += c;
    i += 1;
  }

  return { text: value, raw: text.slice(start, i), expansion, next: i };
}

/** Reads a double-quoted section, keeping the expansions inside it visible. */
function readDoubleQuoted(
  text: string,
  start: number,
  nested: string[],
  parse: Parse,
): { text: string; expansion: boolean; next: number } | undefined {
  let value = "";
  let expansion = false;
  let i = start + 1;

  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') return { text: value, expansion, next: i + 1 };

    if (c === "\\") {
      if (i + 1 >= text.length) {
        parse.failure ??= "a double quote is not closed";
        return undefined;
      }
      const escaped = text.charAt(i + 1);
      // Inside double quotes a backslash only escapes these four characters and
      // a newline; anywhere else it stays a literal backslash.
      if (escaped === '"' || escaped === "\\" || escaped === "$" || escaped === "`") {
        value += escaped;
      } else if (escaped !== "\n") {
        value += c + escaped;
      }
      i += 2;
      continue;
    }

    if (c === "`") {
      const substitution = readBackquote(text, i, nested, parse);
      if (substitution === undefined) return undefined;
      value += substitution.source;
      expansion = true;
      i = substitution.next;
      continue;
    }

    if (c === "$") {
      const next = text.charAt(i + 1);
      if (next === "(") {
        const substitution = readDollarParen(text, i, nested, parse);
        if (substitution === undefined) return undefined;
        value += substitution.source;
        expansion = true;
        i = substitution.next;
        continue;
      }
      // `$'…'` is literal inside double quotes, but `${x-rm}` still expands.
      if (next === "{") {
        const braced = readBraced(text, i, parse);
        if (braced === undefined) return undefined;
        value += braced.source;
        expansion = true;
        i = braced.next;
        continue;
      }
      // Double quotes do not stop a bare `$name` from expanding either.
      if (EXPANDS_AFTER_DOLLAR.test(next)) expansion = true;
    }

    value += c;
    i += 1;
  }

  parse.failure ??= "a double quote is not closed";
  return undefined;
}

function readDollarParen(
  text: string,
  at: number,
  nested: string[],
  parse: Parse,
): { source: string; next: number } | undefined {
  const close = findClosingParen(text, at + 2);
  if (close < 0) {
    parse.failure ??= "a $(…) substitution is not closed";
    return undefined;
  }
  nested.push(text.slice(at + 2, close));
  return { source: text.slice(at, close + 1), next: close + 1 };
}

function readBackquote(
  text: string,
  at: number,
  nested: string[],
  parse: Parse,
): { source: string; next: number } | undefined {
  const close = findClosingBacktick(text, at + 1);
  if (close < 0) {
    parse.failure ??= "a ` substitution is not closed";
    return undefined;
  }
  nested.push(text.slice(at + 1, close));
  return { source: text.slice(at, close + 1), next: close + 1 };
}

/**
 * Reads a `${…}` expansion, which may only be kept as source text when it is a
 * plain parameter reference. Every other body selects or rewrites text that is
 * not in the command — `${x-rm}`, `${x:0:2}`, `${x/a/b}`, `${!x}` — so it is
 * refused rather than emitted as a literal no rule matches. `$VAR` without
 * braces is a plain reference by construction and stays as written.
 */
function readBraced(
  text: string,
  at: number,
  parse: Parse,
): { source: string; next: number } | undefined {
  const close = text.indexOf("}", at + 2);
  if (close < 0) {
    parse.failure ??= "a ${…} expansion is not closed";
    return undefined;
  }
  const body = text.slice(at + 2, close);
  const source = text.slice(at, close + 1);
  if (!PLAIN_PARAMETER.test(body)) {
    parse.failure ??= `the expansion ${source} produces text that is not written in the command`;
    return undefined;
  }
  return { source, next: close + 1 };
}

/**
 * Reads one redirection starting at `at`, which points at `<`, `>` or the `&`
 * of `&>`. A file descriptor prefix has already been consumed by the caller; it
 * changes which stream is redirected, never which file.
 */
function readRedirect(
  text: string,
  at: number,
  nested: string[],
  parse: Parse,
): RedirectRead | undefined {
  let i = at;
  let operator: string;

  if (text.charAt(i) === "&") {
    i += 2;
    if (text.charAt(i) === ">") {
      operator = "&>>";
      i += 1;
    } else {
      operator = "&>";
    }
  } else if (text.charAt(i) === ">") {
    i += 1;
    const next = text.charAt(i);
    if (next === ">" || next === "|" || next === "&") {
      operator = `>${next}`;
      i += 1;
    } else {
      operator = ">";
    }
  } else {
    i += 1;
    const next = text.charAt(i);
    if (next === "<") {
      i += 1;
      if (text.charAt(i) === "<") {
        operator = "<<<";
        i += 1;
      } else {
        operator = "<<";
      }
    } else if (next === ">" || next === "&") {
      operator = `<${next}`;
      i += 1;
    } else {
      operator = "<";
    }
  }

  while (text.charAt(i) === " " || text.charAt(i) === "\t") i += 1;

  // A process substitution target contributes its contents, not a file.
  if (text.charAt(i) === "(") {
    const close = findClosingParen(text, i + 1);
    if (close < 0) {
      parse.failure ??= "a process substitution is not closed";
      return undefined;
    }
    nested.push(text.slice(i + 1, close));
    return { target: undefined, writes: false, next: close + 1 };
  }

  const target = readWord(text, i, nested, parse);
  if (target === undefined) return undefined;
  if (target.raw === "") {
    parse.failure ??= "a redirection has no target";
    return undefined;
  }

  // Here-documents and here-strings feed data in, so only their expansions (now
  // in `nested`) matter. Duplicating or closing a descriptor touches no file
  // either, and `/dev/null` needs no permission in either direction.
  const inert =
    operator === "<<" ||
    operator === "<<<" ||
    ((operator === ">&" || operator === "<&") &&
      (/^[0-9]+$/.test(target.text) || target.text === "-")) ||
    target.text === DEV_NULL;
  if (inert) return { target: undefined, writes: false, next: target.next };

  // Only `<` and `<&file` leave the file untouched; `<>` opens it for writing
  // too, and every `>` form creates or truncates it.
  return {
    target: target.text,
    writes: operator !== "<" && operator !== "<&",
    next: target.next,
  };
}

/** Index of the `)` closing the group whose body starts at `from`, or -1. */
function findClosingParen(text: string, from: number): number {
  let depth = 1;
  let i = from;

  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (c === '"') {
      const close = skipDoubleQuoted(text, i);
      if (close < 0) return -1;
      i = close;
      continue;
    }
    if (c === "`") {
      const close = findClosingBacktick(text, i + 1);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (c === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (c === ")") {
      depth -= 1;
      i += 1;
      if (depth === 0) return i - 1;
      continue;
    }
    i += 1;
  }

  return -1;
}

/** Index just past the `"` closing the section that opens at `from`, or -1. */
function skipDoubleQuoted(text: string, from: number): number {
  let i = from + 1;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"') return i + 1;
    i += 1;
  }
  return -1;
}

/** Index of the backtick closing the substitution that starts at `from`, or -1. */
function findClosingBacktick(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") return i;
    i += 1;
  }
  return -1;
}
