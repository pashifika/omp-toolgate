/**
 * Approval prompt: what the user is asked when a decision comes out `confirm`,
 * which patterns "always allow" may record, and how that record is written back.
 *
 * The module is split so that everything except `appendAlwaysAllow` is pure and
 * therefore testable without a filesystem or a UI.
 */

import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { digPermissionsContainer, type JsoncParser } from "./config.ts";
import { canonicalizeToolName } from "./mapping.ts";
import { isRecord, type Decision, type DecisionCause, type DecisionInput } from "./types.ts";

/** Virtual tools whose decision inputs are paths, so path candidates apply. */
const PATH_VIRTUAL_TOOLS: Readonly<Record<string, true>> = {
  write_file: true,
  edit_file: true,
  delete_path: true,
  move_path: true,
  copy_path: true,
  read_file: true,
  find_path: true,
  create_directory: true,
  skill: true,
};

/** One entry of the approval dialog. */
export interface ApprovalChoice {
  readonly label: string;
  readonly kind: "once" | "global" | "project" | "deny";
  /** The pattern that would be recorded, for `global` and `project`. */
  readonly pattern: string | undefined;
  /** The configuration file that would be written, for `global` and `project`. */
  readonly file: string | undefined;
}

/** Everything the caller needs to render the dialog and act on the answer. */
export interface ApprovalPlan {
  readonly body: string;
  readonly choices: readonly ApprovalChoice[];
  /** Why an "always allow" choice was withheld. Shown with the prompt. */
  readonly notes: readonly string[];
}

export interface ApprovalPaths {
  readonly globalPath: string;
  readonly projectPath: string;
}

/**
 * Escapes regex metacharacters, leaving `-` and `/` alone: `-` is only special
 * inside a character class, and `/` is not special at all in a pattern built
 * from a string. `^src/generated/` therefore reads as written instead of
 * `^src\/generated/`. Same choice as Zed's `escape_for_pattern`.
 */
function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True for a token that names a command or a sub-command: no path separator, no
 * leading `-`, nothing but ASCII word characters and `-`. Mirrors Zed's
 * `is_plain_command_token`, which exists so that "always allow" can never be
 * offered for a path-derived executable such as `./deploy.sh`.
 */
function isPlainCommandToken(token: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(token);
}

/** Splits one sub-command into shell words, honoring quotes well enough to find the command name. */
function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i] as string;
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "\\" && i + 1 < segment.length) {
      current += segment[i + 1] as string;
      i += 1;
      continue;
    }
    if (char === " " || char === "\t" || char === "\n") {
      if (current !== "") words.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current !== "") words.push(current);
  return words;
}

/**
 * Builds the anchored pattern for one sub-command, or `undefined` when no safe
 * pattern exists. `cargo test --release` yields `^cargo\s+test(\s|$)`;
 * `ls -la` yields `^ls\b` because a flag is not a sub-command; `./deploy.sh` and
 * a leading `VAR=value` assignment yield nothing, the latter because an anchored
 * pattern would never match the assignment-prefixed command anyway.
 */
function commandPattern(segment: string): string | undefined {
  const words = shellWords(segment.trim());
  const command = words[0];
  if (command === undefined || !isPlainCommandToken(command)) return undefined;
  const next = words[1];
  if (next !== undefined && !next.startsWith("-") && isPlainCommandToken(next)) {
    return `^${escapePattern(command)}\\s+${escapePattern(next)}(\\s|$)`;
  }
  return `^${escapePattern(command)}\\b`;
}

/**
 * Patterns offered for "always allow", in the order they should be presented.
 *
 * `terminal` produces one anchored pattern per sub-command; the inputs of a
 * `terminal` decision are already split, so no further splitting happens here.
 * Path tools produce the enclosing directory and the file extension. Every other
 * virtual tool produces nothing, so only "allow once" and "deny" are offered.
 */
export function candidatePatterns(
  virtualTool: string,
  inputs: readonly DecisionInput[],
): readonly string[] {
  const out: string[] = [];
  const push = (pattern: string | undefined): void => {
    if (pattern !== undefined && !out.includes(pattern)) out.push(pattern);
  };

  if (virtualTool === "terminal") {
    for (const input of inputs) push(commandPattern(input.value));
    return out;
  }

  if (PATH_VIRTUAL_TOOLS[virtualTool] !== true) return out;

  for (const input of inputs) {
    const value = input.value;
    if (value === "") continue;
    const parent = path.posix.dirname(value);
    if (parent !== "." && parent !== "/" && parent !== "") {
      push(`^${escapePattern(parent)}/`);
    }
    const extension = path.posix.extname(value);
    if (extension.length > 1) push(`${escapePattern(extension)}$`);
  }
  return out;
}

/** One-line description of what decided the outcome. */
export function describeCause(decision: Decision): string {
  const cause = decision.cause;
  switch (cause.kind) {
    case "rule":
      return `${cause.list ?? "rule"} ${describeCondition(cause)} from ${cause.origin ?? "config"} configuration`;
    case "escape":
      return "symlink escape out of the project root (cannot be disabled by configuration)";
    case "invalid-pattern":
      return "a pattern in the configuration failed to compile";
    case "default":
      return "no rule matched, so the configured default applied";
  }
}

/**
 * The rule's condition as written: a pattern, a scope, or both. A scope-only
 * rule has no pattern, so printing `//` would hide what actually matched.
 */
function describeCondition(cause: DecisionCause): string {
  const pattern = cause.pattern ?? "";
  const scope = cause.scope;
  if (pattern === "") {
    return scope === undefined ? "rule" : `scope ${scope}`;
  }
  return scope === undefined || scope === "any"
    ? `/${pattern}/`
    : `/${pattern}/ with scope ${scope}`;
}

/**
 * Builds the dialog.
 *
 * "Always allow" is offered only when it can actually change the next outcome.
 * It cannot when a symlink escape forced the confirmation (design D8), and it
 * cannot when an `always_confirm` / `always_deny` rule matched: `always_allow`
 * is evaluated *after* both of those, so recording a pattern that the matching
 * rule also covers would be dead weight and the very same prompt would come
 * back. The project choice is withheld additionally when the pattern is
 * absolute, since a project file must stay portable.
 */
export function planApproval(
  decision: Decision,
  paths: ApprovalPaths,
): ApprovalPlan {
  const escaped = decision.cause.kind === "escape" || decision.inputs.some((i) => i.escaped);
  const notes: string[] = [];
  const lines = [
    `omp-toolgate: confirm ${decision.virtualTool}`,
    `  reason: ${describeCause(decision)}`,
  ];

  for (const input of decision.inputs) {
    const scope = input.scope === undefined ? "" : ` [${input.scope}]`;
    lines.push(`  target: ${input.value}${scope}`);
    if (input.escaped && input.literal !== undefined && input.resolved !== undefined) {
      lines.push(`    literal:  ${input.literal}`);
      lines.push(`    realpath: ${input.resolved}`);
    }
  }

  const choices: ApprovalChoice[] = [
    { label: "Allow once", kind: "once", pattern: undefined, file: undefined },
  ];

  const ruleForcedConfirm =
    decision.cause.kind === "rule" &&
    (decision.cause.list === "always_confirm" || decision.cause.list === "always_deny");

  if (escaped) {
    notes.push(
      "This call leaves the project root through a symlink, so it can only be allowed once.",
    );
  } else if (ruleForcedConfirm) {
    const origin = decision.cause.origin === "project" ? paths.projectPath : paths.globalPath;
    notes.push(
      `An always_confirm rule matched, and always_allow is evaluated after it, so no ` +
        `recorded pattern can stop this prompt. To stop asking, edit the rule in ${origin}: ` +
        `${describeCondition(decision.cause)}.`,
    );
  } else {
    const candidates = candidatePatterns(decision.virtualTool, decision.inputs);
    if (candidates.length === 0) {
      notes.push(
        `No safe pattern can be derived for ${decision.virtualTool}, so it can only be allowed once.`,
      );
    }

    // Project first: the narrower scope is the one a user should reach for by
    // default, so it sits closer to "allow once".
    for (const pattern of candidates) {
      if (pattern.startsWith("^/")) continue;
      choices.push({
        label: `Always allow (this project): ${pattern}`,
        kind: "project",
        pattern,
        file: paths.projectPath,
      });
    }

    for (const pattern of candidates) {
      choices.push({
        label: `Always allow (global): ${pattern}`,
        kind: "global",
        pattern,
        file: paths.globalPath,
      });
    }

    if (candidates.length > 0 && !choices.some((choice) => choice.kind === "project")) {
      notes.push(
        "The target is outside the project root, so it cannot be recorded in the project configuration.",
      );
    }
  }

  choices.push({ label: "Deny", kind: "deny", pattern: undefined, file: undefined });
  return { body: lines.join("\n"), choices, notes };
}

/** Why a call was blocked, phrased so the model can choose its next step. */
export function buildBlockReason(
  decision: Decision,
  kind: "deny" | "user-denied" | "no-ui",
  configPath: string,
): string {
  const targets = decision.inputs.map((i) => i.value).join(", ") || "(no input)";
  const head =
    kind === "deny"
      ? `omp-toolgate denied ${decision.virtualTool}`
      : kind === "user-denied"
        ? `omp-toolgate asked the user to confirm ${decision.virtualTool} and the user denied it`
        : `omp-toolgate requires confirmation for ${decision.virtualTool}, and this session has no interactive UI`;
  const tail =
    kind === "no-ui"
      ? " Approval must happen in the parent interactive session; do not retry here."
      : "";
  return [
    `${head}.`,
    `Target: ${targets}.`,
    `Cause: ${describeCause(decision)}.`,
    `Configuration: ${configPath}.`,
    tail,
  ]
    .join(" ")
    .trim();
}

/** True when `list` already carries `pattern`, in either accepted rule shape. */
function containsPattern(list: readonly unknown[], pattern: string): boolean {
  return list.some((entry) => {
    if (typeof entry === "string") return entry === pattern;
    if (!isRecord(entry)) return false;
    return entry["pattern"] === pattern;
  });
}

/**
 * Appends `pattern` to `tools.<virtualTool>.always_allow` of `filePath`,
 * creating the directory, the file and the intermediate objects as needed.
 *
 * The write is a temporary file plus `rename`, so a crash never leaves a
 * truncated configuration. The whole document is re-serialized as JSON, which
 * means comments and the original formatting of a hand-written JSONC file are
 * lost on the first write-back; that is documented in the README.
 */
export function appendAlwaysAllow(
  filePath: string,
  virtualTool: string,
  pattern: string,
  parse: JsoncParser,
): "written" | "duplicate" {
  let text: string | undefined;
  let mode: number | undefined;
  try {
    text = readFileSync(filePath, "utf8");
    mode = statSync(filePath).mode & 0o777;
  } catch {
    text = undefined;
  }

  let document: unknown = {};
  if (text !== undefined && text.trim() !== "") {
    try {
      document = parse(text);
    } catch {
      // A file we cannot parse is also a file we must not overwrite.
      throw new Error(`cannot record the pattern: ${filePath} is not valid JSONC`);
    }
  }
  if (!isRecord(document)) {
    throw new Error(`cannot record the pattern: ${filePath} is not a JSON object`);
  }

  const container = digPermissionsContainer(document) ?? document;

  const existingTools = container["tools"];
  const tools: Record<string, unknown> = isRecord(existingTools) ? existingTools : {};
  container["tools"] = tools;

  // Reuse a key that already denotes this tool, so an MCP entry written in omp's
  // `mcp__server__tool` form does not gain a `mcp:server:tool` twin.
  const canonical = canonicalizeToolName(virtualTool);
  const existingKey = Object.keys(tools).find(
    (key) => canonicalizeToolName(key) === canonical,
  );
  const key = existingKey ?? canonical;

  const existingRules = tools[key];
  const rules: Record<string, unknown> = isRecord(existingRules) ? existingRules : {};
  tools[key] = rules;

  const existingList = rules["always_allow"];
  const list: unknown[] = Array.isArray(existingList) ? existingList : [];
  rules["always_allow"] = list;
  if (containsPattern(list, pattern)) return "duplicate";
  list.push({ pattern });

  const serialized = `${JSON.stringify(document, undefined, 2)}\n`;
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.tmp`);
  writeFileSync(temporary, serialized, mode === undefined ? "utf8" : { encoding: "utf8", mode });
  renameSync(temporary, filePath);
  return "written";
}
