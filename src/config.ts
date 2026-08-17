/**
 * Discovery, parsing, validation and merging of omp-toolgate's configuration.
 *
 * Two files take part: a global one under the agent directory and a project one
 * under `<project_root>/.omp/`. The project file may be committed to a
 * repository, so it is treated as third-party input: unless the global file
 * lists the project root in `trustedProjects`, a project file can only tighten
 * the global rules (design D6), and the patterns it contributes are capped in
 * count and length.
 *
 * The module is free of global state and of `Bun.*`; JSONC parsing is injected
 * so the caller decides which parser to use.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalizeToolName } from "./mapping.ts";
import { MODE_STRICTNESS } from "./types.ts";
import type {
  CompiledRule,
  InvalidPattern,
  RawToolPermissions,
  RawToolRules,
  RuleOrigin,
  RuleScope,
  ToolPermissionMode,
  ToolPermissions,
  ToolRules,
} from "./types.ts";

/** Parses JSONC (comments and trailing commas). Injected, never imported. */
export type JsoncParser = (text: string) => unknown;

/** Maximum rules one untrusted project file may contribute to one tool. */
export const PROJECT_PATTERN_LIMIT = 64;

/** Maximum pattern length one untrusted project file may contribute. */
export const PROJECT_PATTERN_LENGTH_LIMIT = 512;

/** Name of both configuration files. */
const CONFIG_FILE_NAME = "tool-permissions.json";

/** Global configuration directory, relative to the home directory. */
const AGENT_DIR = join(".omp", "agent");

/** Project configuration directory, relative to `project_root`. */
const PROJECT_DIR = ".omp";

/** Environment variable that relocates the agent directory. */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/** Global `default` when a file exists but none sets it (design D9). */
const IMPLIED_GLOBAL_DEFAULT: ToolPermissionMode = "confirm";

/** A candidate object is the permissions block if it carries one of these. */
const BLOCK_MARKER_KEYS = ["default", "default_mode", "tools", "trustedProjects"] as const;

/** The three rule lists, in the order they are reported in warnings. */
const LIST_KEYS = ["always_allow", "always_confirm", "always_deny"] as const;

/** Both configuration file paths, whether or not the files exist. */
export interface ConfigPaths {
  /** `<PI_CODING_AGENT_DIR ?? ~/.omp/agent>/tool-permissions.json`. */
  readonly globalPath: string;
  /** `<project_root>/.omp/tool-permissions.json`. */
  readonly projectPath: string;
}

/** Result of one `loadPermissions` call. */
export interface LoadedPermissions {
  /** `undefined` when no configuration file exists: the gate stays out of the way. */
  readonly permissions: ToolPermissions | undefined;
  /** Messages for the `session_start` notification. Empty when no file exists. */
  readonly warnings: readonly string[];
  readonly globalPath: string;
  readonly projectPath: string;
  /**
   * Whether each file exists and could be read. A file whose content was
   * discarded still counts as loaded here; `globalRaw` / `projectRaw` are what
   * tell whether a block was accepted.
   */
  readonly loaded: { readonly global: boolean; readonly project: boolean };
  /**
   * The accepted block of each file, validated and with tool keys
   * canonicalized, before merging and before the untrusted project limits.
   * `undefined` when the file is missing or was discarded.
   */
  readonly globalRaw: RawToolPermissions | undefined;
  readonly projectRaw: RawToolPermissions | undefined;
  /** Whether the global file lists this project root in `trustedProjects`. */
  readonly trusted: boolean;
}

/**
 * Locates both configuration files. The project path is returned even when the
 * file does not exist, because the caller needs it to write rules back.
 *
 * `cwd` is never consulted: the caller has already resolved `project_root`.
 */
export function discoverConfigPaths(projectRoot: string, env: NodeJS.ProcessEnv): ConfigPaths {
  // An empty environment variable counts as unset.
  const relocated = env[AGENT_DIR_ENV];
  const home = env["HOME"];
  const agentDir =
    relocated !== undefined && relocated !== ""
      ? relocated
      : join(home !== undefined && home !== "" ? home : homedir(), AGENT_DIR);
  return {
    globalPath: join(agentDir, CONFIG_FILE_NAME),
    projectPath: join(projectRoot, PROJECT_DIR, CONFIG_FILE_NAME),
  };
}

/**
 * Reads, validates and merges both configuration files.
 *
 * Nothing here throws on bad input: a broken file, a bad value or a pattern
 * that does not compile turns into a warning, and a tool holding an
 * uncompilable pattern keeps it in `invalidPatterns` so the decision stage can
 * deny every call to it.
 */
export function loadPermissions(
  projectRoot: string,
  env: NodeJS.ProcessEnv,
  parse: JsoncParser,
): LoadedPermissions {
  const { globalPath, projectPath } = discoverConfigPaths(projectRoot, env);
  const warnings: string[] = [];
  const globalFile = readSide(globalPath, "global", parse, warnings);
  const projectFile = readSide(projectPath, "project", parse, warnings);
  const loaded = { global: globalFile.exists, project: projectFile.exists };

  if (!loaded.global && !loaded.project) {
    return {
      permissions: undefined,
      warnings,
      globalPath,
      projectPath,
      loaded,
      globalRaw: undefined,
      projectRaw: undefined,
      trusted: false,
    };
  }

  const trusted = isTrustedProject(projectRoot, globalFile.config?.raw.trustedProjects);
  if (projectFile.config !== undefined && !trusted) {
    applyProjectLimits(projectFile.config.tools, projectPath, warnings);
  }

  const globalDefault = globalFile.config?.raw.default;
  const projectDefault = projectFile.config?.raw.default;
  const globalFloor = globalDefault ?? IMPLIED_GLOBAL_DEFAULT;
  const topDefault = trusted
    ? (projectDefault ?? globalFloor)
    : projectDefault === undefined
      ? globalFloor
      : strictest(globalFloor, projectDefault);

  const tools = mergeTools(
    compileSide(globalFile.config?.tools, "global"),
    compileSide(projectFile.config?.tools, "project"),
    trusted,
    topDefault,
  );
  for (const [name, rules] of tools) {
    const invalid = rules.invalidPatterns;
    if (invalid.length === 0) continue;
    const detail = invalid
      .map((entry) => `${entry.origin} "${entry.pattern}": ${entry.message}`)
      .join("; ");
    warnings.push(
      `tool "${name}" has ${invalid.length} invalid pattern(s) and denies every call (${detail})`,
    );
  }

  return {
    permissions: { default: topDefault, tools: Object.fromEntries(tools) },
    warnings,
    globalPath,
    projectPath,
    loaded,
    globalRaw: globalFile.config?.raw,
    projectRaw: projectFile.config?.raw,
    trusted,
  };
}

// ---------------------------------------------------------------------------
// Reading and validating one file
// ---------------------------------------------------------------------------

/** A rule after validation, before its pattern is compiled. */
interface NormalizedRule {
  readonly pattern: string;
  readonly caseSensitive: boolean;
  readonly scope: RuleScope;
}

/**
 * One file's rules for one virtual tool. A list is `undefined` when the file
 * does not mention it at all, which a trusted project override depends on: a
 * present but empty list clears the global one, an absent list keeps it.
 */
interface SideToolRules {
  default: ToolPermissionMode | undefined;
  always_allow: NormalizedRule[] | undefined;
  always_confirm: NormalizedRule[] | undefined;
  always_deny: NormalizedRule[] | undefined;
}

/** One file's accepted content. */
interface SideConfig {
  readonly raw: RawToolPermissions;
  readonly tools: Map<string, SideToolRules>;
}

/** Outcome of reading one file. */
interface SideFile {
  /** The file exists and could be opened, even if its content was discarded. */
  readonly exists: boolean;
  readonly config: SideConfig | undefined;
}

/** Where to report a problem found in one file. */
interface Sink {
  readonly file: string;
  readonly warnings: string[];
}

function readSide(
  file: string,
  origin: RuleOrigin,
  parse: JsoncParser,
  warnings: string[],
): SideFile {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    // A path that cannot exist is not a problem; anything else is.
    const code = isRecord(error) ? error["code"] : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return { exists: false, config: undefined };
    warnings.push(fileWarning(file, `could not be read and was ignored: ${errorMessage(error)}`));
    return { exists: true, config: undefined };
  }

  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    warnings.push(fileWarning(file, `could not be parsed and was ignored: ${errorMessage(error)}`));
    return { exists: true, config: undefined };
  }

  const container = digPermissionsContainer(parsed);
  if (container === undefined) {
    warnings.push(fileWarning(file, "does not contain a JSON object and was ignored"));
    return { exists: true, config: undefined };
  }
  return { exists: true, config: sanitizeBlock(container, origin, { file, warnings }) };
}

/**
 * Returns the live object inside a parsed configuration document that holds
 * `default` / `tools` / `trustedProjects`, so a whole Zed `settings.json` works
 * verbatim: `agent.tool_permissions`, then `tool_permissions`, then the
 * document itself. `undefined` means the document is not an object at all.
 *
 * A location that already carries permissions keys wins; otherwise the first
 * candidate that is an object does, innermost first, which keeps an empty
 * document writable. The reference is the one from the document, not a copy, so
 * a write-back can mutate it and re-stringify the whole document.
 */
export function digPermissionsContainer(doc: unknown): Record<string, unknown> | undefined {
  if (!isRecord(doc)) return undefined;
  const agent = doc["agent"];
  const candidates: readonly unknown[] = [
    isRecord(agent) ? agent["tool_permissions"] : undefined,
    doc["tool_permissions"],
    doc,
  ];
  return candidates.find(looksLikeBlock) ?? candidates.find(isRecord);
}

function looksLikeBlock(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && BLOCK_MARKER_KEYS.some((key) => key in value);
}

function sanitizeBlock(
  block: Record<string, unknown>,
  origin: RuleOrigin,
  sink: Sink,
): SideConfig {
  const raw: RawToolPermissions = {};

  const topDefault = readMode(block, "default", sink);
  if (topDefault !== undefined) raw.default = topDefault;

  const tools = new Map<string, SideToolRules>();
  const toolsValue = block["tools"];
  if (toolsValue !== undefined && toolsValue !== null) {
    if (!isRecord(toolsValue)) {
      sink.warnings.push(fileWarning(sink.file, '"tools" is not an object and was ignored'));
    } else {
      for (const [key, value] of Object.entries(toolsValue)) {
        sanitizeToolEntry(tools, canonicalizeToolName(key), key, value, sink);
      }
    }
  }
  if (tools.size > 0) {
    raw.tools = Object.fromEntries(
      [...tools].map(([name, entry]) => [name, toRawToolRules(entry)] as const),
    );
  }

  // A project file cannot declare itself trusted: the key is inert there.
  if (origin === "global") {
    const trustedProjects = readStringArray(block["trustedProjects"], "trustedProjects", sink);
    if (trustedProjects !== undefined) raw.trustedProjects = trustedProjects;
  }

  return { raw, tools };
}

function sanitizeToolEntry(
  tools: Map<string, SideToolRules>,
  name: string,
  key: string,
  value: unknown,
  sink: Sink,
): void {
  if (!isRecord(value)) {
    sink.warnings.push(fileWarning(sink.file, `"tools.${key}" is not an object and was ignored`));
    return;
  }

  // Two raw keys can canonicalize to the same virtual tool; merge them as one.
  let entry = tools.get(name);
  if (entry === undefined) {
    entry = {
      default: undefined,
      always_allow: undefined,
      always_confirm: undefined,
      always_deny: undefined,
    };
    tools.set(name, entry);
  }

  const mode = readMode(value, `tools.${key}.default`, sink);
  if (mode !== undefined) {
    entry.default = entry.default === undefined ? mode : strictest(entry.default, mode);
  }

  for (const list of LIST_KEYS) {
    const rules = value[list];
    if (rules === undefined || rules === null) continue;
    if (!Array.isArray(rules)) {
      sink.warnings.push(
        fileWarning(sink.file, `"tools.${key}.${list}" is not an array and was ignored`),
      );
      continue;
    }
    const target = entry[list] ?? [];
    entry[list] = target;
    for (let index = 0; index < rules.length; index += 1) {
      const rule = normalizeRule(rules[index], `tools.${key}.${list}[${index}]`, sink);
      if (rule !== undefined) target.push(rule);
    }
  }
}

function normalizeRule(value: unknown, label: string, sink: Sink): NormalizedRule | undefined {
  if (typeof value === "string") {
    return { pattern: value, caseSensitive: false, scope: "any" };
  }
  if (!isRecord(value)) {
    sink.warnings.push(
      fileWarning(sink.file, `"${label}" is neither a string nor an object and was ignored`),
    );
    return undefined;
  }

  let pattern = "";
  const patternValue = value["pattern"];
  if (patternValue !== undefined && patternValue !== null) {
    if (typeof patternValue !== "string") {
      sink.warnings.push(
        fileWarning(sink.file, `"${label}.pattern" is not a string, so the rule was dropped`),
      );
      return undefined;
    }
    pattern = patternValue;
  }

  // Zed's default is case-insensitive matching (`CompiledRegex`).
  let caseSensitive = false;
  const caseValue = value["case_sensitive"];
  if (caseValue !== undefined && caseValue !== null) {
    if (typeof caseValue !== "boolean") {
      sink.warnings.push(
        fileWarning(sink.file, `"${label}.case_sensitive" is not a boolean and was ignored`),
      );
    } else {
      caseSensitive = caseValue;
    }
  }

  let scope: RuleScope = "any";
  const scopeValue = value["scope"];
  if (scopeValue !== undefined && scopeValue !== null) {
    if (!isScope(scopeValue)) {
      sink.warnings.push(
        fileWarning(
          sink.file,
          `"${label}.scope" is not one of inside/outside/any, so the rule was dropped`,
        ),
      );
      return undefined;
    }
    scope = scopeValue;
  }

  return { pattern, caseSensitive, scope };
}

function readMode(
  obj: Record<string, unknown>,
  label: string,
  sink: Sink,
): ToolPermissionMode | undefined {
  const value = obj["default"] ?? obj["default_mode"];
  if (value === undefined || value === null) return undefined;
  if (isMode(value)) return value;
  sink.warnings.push(
    fileWarning(sink.file, `"${label}" is not one of allow/confirm/deny and was ignored`),
  );
  return undefined;
}

function readStringArray(value: unknown, label: string, sink: Sink): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    sink.warnings.push(fileWarning(sink.file, `"${label}" is not an array and was ignored`));
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push(entry);
    } else {
      sink.warnings.push(
        fileWarning(sink.file, `"${label}" has a non-string entry, which was ignored`),
      );
    }
  }
  return out;
}

function toRawToolRules(entry: SideToolRules): RawToolRules {
  const raw: RawToolRules = {};
  if (entry.default !== undefined) raw.default = entry.default;
  for (const list of LIST_KEYS) {
    const rules = entry[list];
    if (rules !== undefined) {
      raw[list] = rules.map((rule) => ({
        pattern: rule.pattern,
        case_sensitive: rule.caseSensitive,
        scope: rule.scope,
      }));
    }
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

const GLOB_META = /[*?]/;
const GLOB_TOKEN = /\*\*|[*?]|[^*?]+/g;
const REGEXP_META = /[\\^$.*+?()[\]{}|]/g;
const TRAILING_SLASHES = /(?!^)\/+$/;

function isTrustedProject(projectRoot: string, patterns: readonly string[] | undefined): boolean {
  if (patterns === undefined || patterns.length === 0) return false;
  const root = resolve(projectRoot);
  return patterns.some((pattern) => matchesProjectRoot(pattern, root));
}

function matchesProjectRoot(pattern: string, root: string): boolean {
  const trimmed = pattern.replace(TRAILING_SLASHES, "");
  if (trimmed === "") return false;
  if (!GLOB_META.test(trimmed)) return resolve(trimmed) === root;
  return globToRegExp(trimmed).test(root);
}

/** `*` stays inside one segment, `**` crosses separators, `?` is one character. */
function globToRegExp(glob: string): RegExp {
  const source = glob.replace(GLOB_TOKEN, (token) => {
    if (token === "**") return ".*";
    if (token === "*") return "[^/]*";
    if (token === "?") return "[^/]";
    return token.replace(REGEXP_META, "\\$&");
  });
  return new RegExp(`^${source}$`);
}

// ---------------------------------------------------------------------------
// Untrusted project limits
// ---------------------------------------------------------------------------

/**
 * Caps what an untrusted project file contributes to one virtual tool, since
 * its patterns are third-party input and Node's `RegExp` has no timeout.
 * Over-long patterns go first, then the per-tool budget applies in file order.
 */
function applyProjectLimits(
  tools: Map<string, SideToolRules>,
  file: string,
  warnings: string[],
): void {
  for (const [name, entry] of tools) {
    let kept = 0;
    let dropped = 0;
    for (const list of LIST_KEYS) {
      const rules = entry[list];
      if (rules === undefined) continue;
      const survivors: NormalizedRule[] = [];
      for (const rule of rules) {
        if (rule.pattern.length > PROJECT_PATTERN_LENGTH_LIMIT || kept >= PROJECT_PATTERN_LIMIT) {
          dropped += 1;
          continue;
        }
        kept += 1;
        survivors.push(rule);
      }
      entry[list] = survivors;
    }
    if (dropped > 0) {
      warnings.push(
        fileWarning(
          file,
          `dropped ${dropped} rule(s) for "${name}": an untrusted project may contribute at most ` +
            `${PROJECT_PATTERN_LIMIT} rules per tool and ${PROJECT_PATTERN_LENGTH_LIMIT} characters per pattern`,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Compilation and merging
// ---------------------------------------------------------------------------

/** One compiled rule list, plus the patterns of that list that did not compile. */
interface CompiledList {
  readonly rules: readonly CompiledRule[];
  readonly invalid: readonly InvalidPattern[];
}

/** One file's compiled rules for one virtual tool. `undefined` list = absent. */
interface CompiledSideRules {
  readonly default: ToolPermissionMode | undefined;
  readonly always_allow: CompiledList | undefined;
  readonly always_confirm: CompiledList | undefined;
  readonly always_deny: CompiledList | undefined;
}

const EMPTY_LIST: CompiledList = { rules: [], invalid: [] };

function compileSide(
  tools: Map<string, SideToolRules> | undefined,
  origin: RuleOrigin,
): Map<string, CompiledSideRules> {
  const compiled = new Map<string, CompiledSideRules>();
  if (tools === undefined) return compiled;
  for (const [name, entry] of tools) {
    compiled.set(name, {
      default: entry.default,
      always_allow: compileList(entry.always_allow, origin),
      always_confirm: compileList(entry.always_confirm, origin),
      always_deny: compileList(entry.always_deny, origin),
    });
  }
  return compiled;
}

function compileList(
  rules: readonly NormalizedRule[] | undefined,
  origin: RuleOrigin,
): CompiledList | undefined {
  if (rules === undefined) return undefined;
  const compiled: CompiledRule[] = [];
  const invalid: InvalidPattern[] = [];
  for (const rule of rules) {
    if (rule.pattern === "") {
      compiled.push({ source: "", regex: undefined, scope: rule.scope, origin });
      continue;
    }
    try {
      compiled.push({
        source: rule.pattern,
        regex: new RegExp(rule.pattern, rule.caseSensitive ? "" : "i"),
        scope: rule.scope,
        origin,
      });
    } catch (error) {
      invalid.push({ pattern: rule.pattern, origin, message: errorMessage(error) });
    }
  }
  return { rules: compiled, invalid };
}

function mergeTools(
  globalTools: Map<string, CompiledSideRules>,
  projectTools: Map<string, CompiledSideRules>,
  trusted: boolean,
  topDefault: ToolPermissionMode,
): Map<string, ToolRules> {
  const merged = new Map<string, ToolRules>();
  const names = new Set<string>(globalTools.keys());
  for (const name of projectTools.keys()) names.add(name);

  for (const name of names) {
    const globalSide = globalTools.get(name);
    const projectSide = projectTools.get(name);
    const allow = mergeList(globalSide?.always_allow, projectSide?.always_allow, trusted);
    const confirm = mergeList(globalSide?.always_confirm, projectSide?.always_confirm, trusted);
    const deny = mergeList(globalSide?.always_deny, projectSide?.always_deny, trusted);
    const invalid =
      allow.invalid.length + confirm.invalid.length + deny.invalid.length === 0
        ? EMPTY_LIST.invalid
        : [...allow.invalid, ...confirm.invalid, ...deny.invalid];
    merged.set(name, {
      default: mergeDefault(globalSide?.default, projectSide?.default, trusted, topDefault),
      always_allow: allow.rules,
      always_confirm: confirm.rules,
      always_deny: deny.rules,
      invalidPatterns: invalid,
    });
  }
  return merged;
}

/**
 * An untrusted project appends; a trusted one replaces a list it mentions and
 * leaves the global one alone otherwise. Invalid patterns follow their list, so
 * a trusted replacement also clears the global list's compile failures.
 */
function mergeList(
  globalList: CompiledList | undefined,
  projectList: CompiledList | undefined,
  trusted: boolean,
): CompiledList {
  if (trusted) return projectList ?? globalList ?? EMPTY_LIST;
  if (globalList === undefined) return projectList ?? EMPTY_LIST;
  if (projectList === undefined) return globalList;
  return {
    rules: [...globalList.rules, ...projectList.rules],
    invalid: [...globalList.invalid, ...projectList.invalid],
  };
}

/**
 * `undefined` stays `undefined` so the decision stage inherits the global
 * default. An untrusted project can only raise the bar, and the bar it is
 * compared against is the effective global default when the global file does
 * not set one for this tool — otherwise a project could undercut inheritance.
 */
function mergeDefault(
  globalDefault: ToolPermissionMode | undefined,
  projectDefault: ToolPermissionMode | undefined,
  trusted: boolean,
  topDefault: ToolPermissionMode,
): ToolPermissionMode | undefined {
  if (trusted) return projectDefault ?? globalDefault;
  if (projectDefault === undefined) return globalDefault;
  return strictest(globalDefault ?? topDefault, projectDefault);
}

function strictest(a: ToolPermissionMode, b: ToolPermissionMode): ToolPermissionMode {
  return MODE_STRICTNESS[b] > MODE_STRICTNESS[a] ? b : a;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function fileWarning(file: string, detail: string): string {
  return `${file}: ${detail}`;
}

/**
 * The one boundary guard for this package: configuration files are untrusted
 * JSONC and no schema validator is available, so every field is checked where
 * it is read and only the "is it an object at all" question lives here.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMode(value: unknown): value is ToolPermissionMode {
  return typeof value === "string" && Object.hasOwn(MODE_STRICTNESS, value);
}

function isScope(value: unknown): value is RuleScope {
  return value === "inside" || value === "outside" || value === "any";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
