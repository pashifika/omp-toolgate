/**
 * Shared contract for omp-toolgate.
 *
 * Every module in `src/` depends on this file and on nothing else of ours except
 * where noted, so the configuration shape, the decision shape and the path shape
 * have exactly one definition.
 *
 * Naming follows Zed's `agent.tool_permissions` block (snake_case) wherever a
 * name appears in a configuration file, because a Zed `settings.json` must be
 * usable verbatim. Names that only exist in memory use the local TypeScript
 * style (camelCase).
 */

/**
 * The package's canonical object guard. Configuration documents and tool-call
 * arguments arrive as `unknown`; this narrows to "some object" and leaves every
 * field `unknown`, so each field still has to be checked where it is read.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Visible spellings for the control characters that would otherwise forge a line. */
const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

/**
 * Rewrites every character that could forge a line in text the gate emits.
 *
 * Both of the gate's outputs are line-oriented and both are read as the gate's
 * own voice: the approval dialog by the user, and the block reason by the model.
 * Every string that reaches either from outside — a tool argument, a pattern or
 * a tool key from a committed project file, a path derived from the working
 * directory — passes through here first, because a newline in any of them would
 * add a line indistinguishable from one the gate wrote.
 *
 * Truncation is deliberately not part of this: a configuration path has to stay
 * whole to be actionable, while a model-supplied argument does not. The caller
 * decides.
 */
export function escapeControlCharacters(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, (char) => {
    const known = CONTROL_ESCAPES[char];
    if (known !== undefined) return known;
    return `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`;
  });
}

/** Permission outcome. Ordered `allow` < `confirm` < `deny` by strictness. */
export type ToolPermissionMode = "allow" | "confirm" | "deny";

/** Where a normalized path sits relative to `project_root`. */
export type PathScope = "inside" | "outside";

/** Rule-side scope selector. `any` (or omitted) matches regardless of location. */
export type RuleScope = PathScope | "any";

/** Which configuration file a rule came from. */
export type RuleOrigin = "global" | "project";

// ---------------------------------------------------------------------------
// Configuration as written on disk
// ---------------------------------------------------------------------------

/**
 * A single rule as written in a configuration file.
 *
 * A bare string is shorthand for `{ pattern: <string> }`. `scope` is an
 * omp-toolgate extension and is not understood by Zed.
 */
export type RawRule =
  | string
  | {
      pattern?: string;
      case_sensitive?: boolean;
      scope?: RuleScope;
    };

/** Per-tool rules as written in a configuration file. */
export interface RawToolRules {
  default?: ToolPermissionMode;
  /** Zed accepts `default_mode` as an alias of `default`. */
  default_mode?: ToolPermissionMode;
  always_allow?: RawRule[];
  always_confirm?: RawRule[];
  always_deny?: RawRule[];
}

/** A whole `tool_permissions` block as written in a configuration file. */
export interface RawToolPermissions {
  default?: ToolPermissionMode;
  default_mode?: ToolPermissionMode;
  tools?: Record<string, RawToolRules>;
  /**
   * Project roots whose `.omp/tool-permissions.json` may override global rules
   * normally instead of only tightening them. Honored in the global file only.
   * omp-toolgate extension; absolute paths or globs.
   */
  trustedProjects?: string[];
}

// ---------------------------------------------------------------------------
// Configuration after compilation
// ---------------------------------------------------------------------------

/** A rule whose pattern has been compiled. */
export interface CompiledRule {
  /** Original pattern text. Empty for a scope-only rule. */
  readonly source: string;
  /** `undefined` for a scope-only rule, which matches on `scope` alone. */
  readonly regex: RegExp | undefined;
  readonly scope: RuleScope;
  readonly origin: RuleOrigin;
}

/** A pattern that failed to compile. */
export interface InvalidPattern {
  readonly pattern: string;
  readonly origin: RuleOrigin;
  readonly message: string;
}

/** Compiled rules for one virtual tool. */
export interface ToolRules {
  /** `undefined` inherits the global default. */
  readonly default: ToolPermissionMode | undefined;
  readonly always_allow: readonly CompiledRule[];
  readonly always_confirm: readonly CompiledRule[];
  readonly always_deny: readonly CompiledRule[];
  /** Non-empty makes every call to this virtual tool `deny`. */
  readonly invalidPatterns: readonly InvalidPattern[];
}

/** The effective permission set for a session. */
export interface ToolPermissions {
  readonly default: ToolPermissionMode;
  /** Keyed by canonical virtual tool name (see `canonicalizeToolName`). */
  readonly tools: Readonly<Record<string, ToolRules>>;
  /**
   * Absolute paths whose modification is floored at `confirm` no matter what the
   * rules say — the gate's own configuration files. Without this an in-project
   * write under `write_file.default: allow` could rewrite the rules that were
   * about to gate it.
   */
  readonly protectedPaths: readonly string[];
}

/**
 * Virtual tools that modify the filesystem. Used for the protected-path floor,
 * which must not fire on a mere read of a configuration file.
 */
export const MUTATING_VIRTUAL_TOOLS: Readonly<Record<string, true>> = {
  write_file: true,
  edit_file: true,
  delete_path: true,
  move_path: true,
  copy_path: true,
  create_directory: true,
};

/**
 * A shell command broken into the pieces that must each be checked.
 *
 * `redirects` are the targets of redirections to real files, kept apart from
 * `commands` so that a path rule can be applied to them as well: a rule on
 * `write_file` should govern `printf x >> ~/.ssh/authorized_keys` just as it
 * governs a `write` call. `terminal` still sees them, so an `always_allow` on a
 * command name alone cannot approve a redirect into an unrelated file.
 */
export interface SplitCommand {
  readonly commands: readonly string[];
  readonly redirects: readonly string[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Result of normalizing one raw path argument. */
export interface NormalizedPath {
  /**
   * The only string patterns are matched against: `project_root`-relative when
   * inside (no leading `./`), absolute when outside, `/` separated.
   */
  readonly path: string;
  readonly scope: PathScope;
  /** Literal path is inside `project_root` but `realpath` leaves it. */
  readonly escaped: boolean;
  /**
   * Absolute literal path: the argument made absolute against the canonicalized
   * working directory, with `.` and `..` collapsed textually, no symlink
   * resolution.
   */
  readonly literal: string;
  /**
   * Absolute path after resolving symlinks component by component, left to
   * right, so a `..` applies to the directory a symlink actually points at
   * rather than to the name that preceded it. This is the file the tool will
   * open, and the string `path` is derived from.
   */
  readonly resolved: string;
  /**
   * Selector text stripped from the raw argument, without the leading `:`.
   * `undefined` when nothing was stripped — which is the case for any colon
   * whose tail does not match a known selector grammar, because a path is more
   * likely to contain a literal colon than an unrecognized selector.
   */
  readonly selector: string | undefined;
  /**
   * The argument still contains an expansion the shell has not performed
   * (`$HOME/x`, `${OUT}/log`), so nothing here says where it will land. Such a
   * path is never classified `inside`, and the decision is floored at `confirm`.
   */
  readonly unexpanded: boolean;
}

/** Resolves a raw path argument. Injected so mapping stays filesystem-free. */
export type PathResolver = (raw: string) => NormalizedPath;

// ---------------------------------------------------------------------------
// Decision inputs and outputs
// ---------------------------------------------------------------------------

/** One string to match rules against, plus what is known about its origin. */
export interface DecisionInput {
  /** The string patterns are matched against. */
  readonly value: string;
  /**
   * Omitted for inputs that are not paths (commands, URLs, queries). A rule
   * carrying an explicit `inside`/`outside` scope never matches such an input.
   */
  readonly scope?: PathScope;
  /** Forces at least `confirm`; cannot be disabled by configuration. */
  readonly escaped?: boolean;
  /** The path still holds an unexpanded expansion; see `NormalizedPath`. */
  readonly unexpanded?: boolean;
  /** Absolute literal path, for the approval prompt. */
  readonly literal?: string;
  /** Absolute resolved path, for the approval prompt. */
  readonly resolved?: string;
}

/** Why a decision came out the way it did. */
export interface DecisionCause {
  /**
   * Why the decision came out the way it did:
   *
   * - `rule` — an `always_deny` / `always_confirm` / `always_allow` rule matched.
   * - `default` — no rule matched, so a `default` applied.
   * - `invalid-pattern` — a pattern for this tool failed to compile, which
   *   denies every call to it.
   * - `escape` — the target left the project root through a symlink.
   * - `protected` — the target is one of the gate's own configuration files.
   * - `unexpanded` — the target still holds an expansion the shell has not
   *   performed, so where it lands is unknown.
   * - `unparseable` — a command's real text could not be determined.
   *
   * The last four are floors that configuration cannot disable.
   */
  readonly kind:
    | "invalid-pattern"
    | "escape"
    | "protected"
    | "unparseable"
    | "unexpanded"
    | "rule"
    | "default";
  /**
   * The matching rule's pattern text, when `kind` is `rule`. Empty for a
   * scope-only rule, whose `scope` is then the whole condition.
   */
  readonly pattern?: string;
  /** The matching rule's scope, when `kind` is `rule`. */
  readonly scope?: RuleScope;
  /** Which file the matching rule came from, when `kind` is `rule`. */
  readonly origin?: RuleOrigin;
  /**
   * The distinct files the failing patterns came from, when `kind` is
   * `invalid-pattern`. Plural because both files can hold one, and the block
   * reason has to send the reader to every file that needs an edit.
   */
  readonly origins?: readonly RuleOrigin[];
  /** The input that triggered it. */
  readonly input?: string;
  /** Which list matched, when `kind` is `rule`. */
  readonly list?: "always_allow" | "always_confirm" | "always_deny";
}

/** The outcome of evaluating one virtual tool. */
export interface Decision {
  readonly mode: ToolPermissionMode;
  readonly virtualTool: string;
  /** Human- and model-readable explanation, safe to show to the model. */
  readonly reason: string;
  readonly cause: DecisionCause;
  /** The inputs that were evaluated, after any terminal sub-command split. */
  readonly inputs: readonly DecisionInput[];
}

// ---------------------------------------------------------------------------
// Tool call mapping
// ---------------------------------------------------------------------------

/** One virtual tool a real tool call maps to. */
export interface MappedCall {
  readonly virtualTool: string;
  /** Empty means "apply the tool's `default` only". */
  readonly inputs: readonly DecisionInput[];
}

/** Result of mapping one real tool call. */
export interface MappingResult {
  /** Empty means the call is not gated at all and passes straight through. */
  readonly calls: readonly MappedCall[];
  /**
   * Set when a major tool (`write` / `edit` / `bash` / `read`) was called with
   * an argument shape this mapping does not understand. The call still gets a
   * `default`-only decision; the text is notified once per session.
   */
  readonly warning?: string;
}

/** Strictness order used when one call maps to several virtual tools. */
export const MODE_STRICTNESS: Readonly<Record<ToolPermissionMode, number>> = {
  allow: 0,
  confirm: 1,
  deny: 2,
};
