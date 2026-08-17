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
 * extraction below covers the injection vector that rejection was guarding.
 */

import { MODE_STRICTNESS } from "./types.ts";
import type {
  CompiledRule,
  Decision,
  DecisionInput,
  MappedCall,
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
    return escapeFloor({
      mode: permissions.default,
      virtualTool,
      reason: `${virtualTool}: no rules configured, so the global default (${permissions.default}) applies.`,
      cause: { kind: "default" },
      inputs,
    });
  }

  let evaluated = inputs;
  let allowEnabled = true;
  if (virtualTool === TERMINAL_TOOL) {
    const expanded: DecisionInput[] = [];
    for (const input of inputs) {
      const parts = splitCommand(input.value);
      if (parts === undefined) {
        // Unparseable command: check it whole and refuse to auto-approve it.
        allowEnabled = false;
        expanded.push(input);
        continue;
      }
      for (const part of parts) expanded.push({ ...input, value: part });
    }
    evaluated = expanded;
  }

  return escapeFloor(
    checkInputs(virtualTool, evaluated, rules, allowEnabled, permissions.default),
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
 * Splits a shell command into the sub-commands that each need to be checked.
 *
 * Returns `undefined` when the command cannot be split with confidence, which
 * disables `always_allow` for that command rather than guessing.
 *
 * Words are unquoted and rejoined with single spaces, mirroring Zed's
 * `extract_commands`, so `r'm' -rf '/'` is checked as `rm -rf /` and quoting
 * cannot be used to slip past a pattern. Parameter expansions keep their source
 * text (`rm -rf $HOME` stays `rm -rf $HOME`), while the contents of command
 * substitutions, subshells and process substitutions are extracted as their own
 * sub-commands. A redirection to a real file contributes a `> <target>`
 * pseudo sub-command so an `always_allow` on the command name alone cannot
 * approve `printf x > .env`; a redirection to `/dev/null` or to another file
 * descriptor contributes nothing.
 *
 * Constructs this splitter does not model (brace groups, control-flow keywords)
 * simply leave their keywords as extra sub-commands. That can only make
 * `always_allow` harder to satisfy, never easier.
 */
export function splitCommand(command: string): readonly string[] | undefined {
  const out: string[] = [];
  return collectCommands(command, out, 0) ? out : undefined;
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
  allowEnabled: boolean,
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

  if (allowEnabled && allMatchedAllow && hadAnyInputs && allowHit !== undefined) {
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
  const note = allowEnabled
    ? ""
    : " always_allow was not evaluated because the command could not be split into sub-commands.";
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

function describeRule(rule: CompiledRule): string {
  if (rule.regex === undefined) return `scope ${rule.scope}`;
  return rule.scope === "any" ? `/${rule.source}/` : `/${rule.source}/ with scope ${rule.scope}`;
}

// ---------------------------------------------------------------------------
// Shell command splitting
// ---------------------------------------------------------------------------

/** A word read from the command, both unquoted and as written. */
interface WordRead {
  /** Unquoted value, with expansions kept as source text. */
  readonly text: string;
  /** Source slice, needed to tell an unquoted `2` file descriptor from `'2'`. */
  readonly raw: string;
  readonly next: number;
}

/** A redirection, reduced to the pseudo sub-command it contributes (if any). */
interface RedirectRead {
  readonly pseudo: string | undefined;
  readonly next: number;
}

/**
 * Appends every sub-command of one command list to `out`.
 * Returns `false` when the text cannot be split with confidence.
 */
function collectCommands(text: string, out: string[], depth: number): boolean {
  if (depth > MAX_NESTING_DEPTH) return false;

  let words: string[] = [];
  let redirects: string[] = [];
  let nested: string[] = [];
  let anyCommand = false;
  let anyRedirect = false;

  /**
   * Ends the current segment. `binaryBefore` / `binaryAfter` say whether the
   * segment is an operand of `&&`, `||` or `|`, which may not be empty.
   */
  const endSegment = (binaryBefore: boolean, binaryAfter: boolean): boolean => {
    if (words.length === 0 && redirects.length === 0 && nested.length === 0) {
      return !binaryBefore && !binaryAfter;
    }
    const joined = words.join(" ").trim();
    if (joined !== "") {
      out.push(joined);
      anyCommand = true;
    }
    for (const redirect of redirects) {
      out.push(redirect);
      anyRedirect = true;
    }
    for (const inner of nested) {
      if (!collectCommands(inner, out, depth + 1)) return false;
      anyCommand = true;
    }
    words = [];
    redirects = [];
    nested = [];
    return true;
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
        const redirect = readRedirect(text, i, "", nested);
        if (redirect === undefined) return false;
        if (redirect.pseudo !== undefined) redirects.push(redirect.pseudo);
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
      const redirect = readRedirect(text, i, "", nested);
      if (redirect === undefined) return false;
      if (redirect.pseudo !== undefined) redirects.push(redirect.pseudo);
      i = redirect.next;
      continue;
    }

    // A subshell contributes its contents, not a command of its own.
    if (c === "(") {
      const close = findClosingParen(text, i + 1);
      if (close < 0) return false;
      nested.push(text.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (c === ")") return false;

    const word = readWord(text, i, nested);
    if (word === undefined) return false;
    const after = text.charAt(word.next);
    if (/^[0-9]+$/.test(word.raw) && (after === "<" || after === ">")) {
      // `2>file`: the digits are a file descriptor, not a command word.
      const redirect = readRedirect(text, word.next, word.raw, nested);
      if (redirect === undefined) return false;
      if (redirect.pseudo !== undefined) redirects.push(redirect.pseudo);
      i = redirect.next;
      continue;
    }
    words.push(word.text);
    i = word.next;
  }

  if (!endSegment(binaryBefore, false)) return false;
  // A redirection with no command anywhere, such as `> /etc/passwd`, is not
  // something we can reason about.
  return anyCommand || !anyRedirect;
}

/** Reads one word, stopping before whitespace or any shell metacharacter. */
function readWord(text: string, start: number, nested: string[]): WordRead | undefined {
  let value = "";
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
      if (i + 1 >= text.length) return undefined;
      const escaped = text.charAt(i + 1);
      // A backslash-newline is a line continuation and contributes nothing.
      if (escaped !== "\n") value += escaped;
      i += 2;
      continue;
    }

    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return undefined;
      value += text.slice(i + 1, close);
      i = close + 1;
      continue;
    }

    if (c === '"') {
      const quotedPart = readDoubleQuoted(text, i, nested);
      if (quotedPart === undefined) return undefined;
      value += quotedPart.text;
      i = quotedPart.next;
      continue;
    }

    if (c === "`") {
      const substitution = readBackquote(text, i, nested);
      if (substitution === undefined) return undefined;
      value += substitution.source;
      i = substitution.next;
      continue;
    }

    if (c === "$" && text.charAt(i + 1) === "(") {
      const substitution = readDollarParen(text, i, nested);
      if (substitution === undefined) return undefined;
      value += substitution.source;
      i = substitution.next;
      continue;
    }

    value += c;
    i += 1;
  }

  return { text: value, raw: text.slice(start, i), next: i };
}

/** Reads a double-quoted section, keeping the expansions inside it visible. */
function readDoubleQuoted(
  text: string,
  start: number,
  nested: string[],
): { text: string; next: number } | undefined {
  let value = "";
  let i = start + 1;

  while (i < text.length) {
    const c = text.charAt(i);
    if (c === '"') return { text: value, next: i + 1 };

    if (c === "\\") {
      if (i + 1 >= text.length) return undefined;
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
      const substitution = readBackquote(text, i, nested);
      if (substitution === undefined) return undefined;
      value += substitution.source;
      i = substitution.next;
      continue;
    }

    if (c === "$" && text.charAt(i + 1) === "(") {
      const substitution = readDollarParen(text, i, nested);
      if (substitution === undefined) return undefined;
      value += substitution.source;
      i = substitution.next;
      continue;
    }

    value += c;
    i += 1;
  }

  return undefined;
}

function readDollarParen(
  text: string,
  at: number,
  nested: string[],
): { source: string; next: number } | undefined {
  const close = findClosingParen(text, at + 2);
  if (close < 0) return undefined;
  nested.push(text.slice(at + 2, close));
  return { source: text.slice(at, close + 1), next: close + 1 };
}

function readBackquote(
  text: string,
  at: number,
  nested: string[],
): { source: string; next: number } | undefined {
  const close = findClosingBacktick(text, at + 1);
  if (close < 0) return undefined;
  nested.push(text.slice(at + 1, close));
  return { source: text.slice(at, close + 1), next: close + 1 };
}

/**
 * Reads one redirection starting at `at`, which points at `<`, `>` or the `&`
 * of `&>`. `fd` is the file descriptor prefix already consumed, if any.
 */
function readRedirect(
  text: string,
  at: number,
  fd: string,
  nested: string[],
): RedirectRead | undefined {
  let i = at;
  let operator: string;
  let fdPrefix = fd;

  if (text.charAt(i) === "&") {
    // `&>` and `&>>` never carry a file descriptor prefix.
    fdPrefix = "";
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
    if (close < 0) return undefined;
    nested.push(text.slice(i + 1, close));
    return { pseudo: undefined, next: close + 1 };
  }

  const target = readWord(text, i, nested);
  if (target === undefined || target.raw === "") return undefined;

  // Here-documents and here-strings feed data in, so only their expansions (now
  // in `nested`) matter. Duplicating a file descriptor touches no file either.
  if (operator === "<<" || operator === "<<<") return { pseudo: undefined, next: target.next };
  if (
    (operator === ">&" || operator === "<&") &&
    (/^[0-9]+$/.test(target.text) || target.text === "-")
  ) {
    return { pseudo: undefined, next: target.next };
  }
  if (target.text === DEV_NULL) return { pseudo: undefined, next: target.next };

  return { pseudo: `${fdPrefix}${operator} ${target.text}`, next: target.next };
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
