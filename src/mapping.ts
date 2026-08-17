/**
 * Maps one real omp tool call onto the virtual tool names that Zed's
 * `agent.tool_permissions` block is written against, plus the strings its rules
 * are matched on.
 *
 * The governing principle (design D7): only arguments that are meaningful *as a
 * command line* reach `terminal`, and a tool that accepts arbitrary code gets
 * its own virtual name with no inputs so that only its `default` applies.
 * Matching `\brm\b` against `eval` source text would be dominated by false
 * positives, and omp routes the `tool.<name>()` bridge inside an `eval` cell
 * through `tool_call` anyway, so the inner calls stay individually gated.
 *
 * `specs/tool-input-mapping/spec.md` holds the two normative tables; they win
 * over omp's own tool documentation. Where a doc says more than the table does,
 * the difference is called out at the relevant branch below.
 *
 * This module never touches the filesystem: path normalization arrives as the
 * injected `PathResolver`.
 */

import type {
  DecisionInput,
  MappedCall,
  MappingResult,
  NormalizedPath,
  PathResolver,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------

/** omp's MCP tool-name form. */
const MCP_TOOL_PREFIX = "mcp__";
/** Zed's MCP tool-id form (`context_server_registry.rs`'s `mcp_tool_id()`). */
const MCP_ID_PREFIX = "mcp:";
/** omp mounts several built-ins as tool devices behind `write`. */
const DEVICE_PREFIX = "xd://";
const SCHEME_SEPARATOR = "://";

/**
 * Rewrites `mcp__<server>__<tool>` to `mcp:<server>:<tool>` and returns every
 * other name unchanged.
 *
 * The split is on the *first* `__` after the prefix, so a tool name that itself
 * contains `__` survives: `mcp__github__create__issue` becomes
 * `mcp:github:create__issue`.
 */
export function canonicalizeToolName(name: string): string {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return name;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const separator = rest.indexOf("__");
  // No server segment, no tool segment: not the documented form, leave it be.
  if (separator < 1) return name;
  const tool = rest.slice(separator + 2);
  if (tool.length === 0) return name;
  return `${MCP_ID_PREFIX}${rest.slice(0, separator)}:${tool}`;
}

// ---------------------------------------------------------------------------
// Hashline parsing
// ---------------------------------------------------------------------------

/** A `[PATH#TAG]` heading. The tag is four hex digits derived from content. */
const SECTION_HEADING = /^\[([^\]#]+)#[0-9A-Fa-f]{4}\]$/;
/** `MV DEST`; destinations containing spaces are quoted. */
const MOVE_OPERATION = /^MV\s+(.+)$/;
/** `REM` deletes the section file and takes no argument and no body. */
const REMOVE_OPERATION = "REM";

/** One `edit` section, classified by the strongest operation in its body. */
export interface HashlineSection {
  readonly path: string;
  readonly op: "edit_file" | "delete_path" | "move_path";
  /** Move destination, exactly as authored minus any quoting. */
  readonly dest: string | undefined;
}

/** Mutable accumulator; a section is classified only once its body is read. */
interface SectionDraft {
  readonly path: string;
  remove: boolean;
  dest: string | undefined;
}

/**
 * Splits an `edit` payload into sections and classifies each one.
 *
 * Returns `undefined` when the payload carries no section heading at all, which
 * the caller treats as an unmapped `edit` call.
 */
export function parseHashline(input: string): readonly HashlineSection[] | undefined {
  const drafts: SectionDraft[] = [];
  let current: SectionDraft | undefined;

  for (const line of input.split("\n")) {
    // Body rows are `+TEXT` starting at column 0. They are final file content,
    // so a row like `+REM` must never be read as an operation.
    if (line.startsWith("+")) continue;

    const trimmed = line.trim();
    const heading = SECTION_HEADING.exec(trimmed);
    if (heading !== null) {
      const path = heading[1];
      if (path !== undefined) {
        current = { path, remove: false, dest: undefined };
        drafts.push(current);
      }
      continue;
    }
    // Envelope noise (`*** Begin Patch`) and anything before the first heading.
    if (current === undefined) continue;

    if (trimmed === REMOVE_OPERATION) {
      current.remove = true;
      continue;
    }
    const move = MOVE_OPERATION.exec(trimmed);
    if (move !== null) {
      const dest = unquote(move[1] ?? "");
      if (dest.length > 0) current.dest = dest;
    }
    // Everything else (`PUT`, `CUT`, register pastes) leaves the section an
    // ordinary edit, which is the fallback classification below.
  }

  if (drafts.length === 0) return undefined;
  // `REM` outranks `MV`, and both outrank `PUT` / `CUT`: a section that deletes
  // its file cannot also be an edit or a move.
  return drafts.map((draft): HashlineSection => {
    if (draft.remove) return { path: draft.path, op: "delete_path", dest: undefined };
    if (draft.dest !== undefined) return { path: draft.path, op: "move_path", dest: draft.dest };
    return { path: draft.path, op: "edit_file", dest: undefined };
  });
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2) {
    const quote = text[0];
    if ((quote === '"' || quote === "'") && text.endsWith(quote)) return text.slice(1, -1);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

const EMPTY_INPUTS: readonly DecisionInput[] = [];
/** The call is not gated at all and passes straight through. */
const NOT_MAPPED: MappingResult = { calls: [] };
const EMPTY_ARGS: Readonly<Record<string, unknown>> = {};

/** Tool devices that exist only to finalize another tool's staged proposal. */
const UNGATED_DEVICES: Readonly<Record<string, true>> = {
  resolve: true,
  reject: true,
  report_issue: true,
};

/** `xd://lsp` actions that mutate files. The rest are read-only queries. */
const LSP_EDIT_ACTIONS: Readonly<Record<string, true>> = {
  rename: true,
  rename_file: true,
  code_actions: true,
};

/**
 * Where `manage_skill` writes. omp's default agent directory is `~/.omp/agent`
 * and this module cannot read the session's actual one, so the path is
 * best-effort; the `write_file` / `delete_path` rules still apply to it.
 */
const MANAGED_SKILLS_ROOT = "~/.omp/agent/managed-skills";

/** omp's general-purpose worker, used when a `task` item omits `agent`. */
const DEFAULT_AGENT_TYPE = "task";

/** `glob` (and only `glob`) documents a default target of `.`. */
const GLOB_DEFAULT_TARGET = ".";

type ArgMapper = (
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
) => MappingResult;

/**
 * Maps one real tool call.
 *
 * A tool name absent from the tables passes through ungated and silently. A
 * tool name present in the tables whose arguments do not have the expected
 * shape gets a `default`-only decision rather than an implicit allow, plus a
 * warning when the real tool is one of `write` / `edit` / `bash` / `read`.
 */
export function mapToolCall(
  toolName: string,
  input: unknown,
  resolve: PathResolver,
): MappingResult {
  const canonical = canonicalizeToolName(toolName);
  if (canonical.startsWith(MCP_ID_PREFIX)) return mapMcpCall(canonical, input);
  const key = canonical.startsWith(DEVICE_PREFIX)
    ? canonical.slice(DEVICE_PREFIX.length)
    : canonical;
  // `Object.hasOwn` because the key is an untrusted tool name: inherited
  // `Object.prototype` members must not resolve to a mapper.
  const mapper = Object.hasOwn(MAPPERS, key) ? MAPPERS[key] : undefined;
  if (mapper === undefined) return NOT_MAPPED;
  return mapper(asRecord(input) ?? EMPTY_ARGS, resolve);
}

/**
 * An MCP tool keeps its canonical name as its virtual tool name and offers
 * every string in its argument object, however deeply nested, as a non-path
 * input. Nothing else is known about an arbitrary server's schema.
 */
function mapMcpCall(virtualTool: string, input: unknown): MappingResult {
  const inputs: DecisionInput[] = [];
  collectStrings(input, inputs);
  return oneCall(virtualTool, inputs);
}

function collectStrings(value: unknown, out: DecisionInput[]): void {
  if (typeof value === "string") {
    out.push({ value });
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value as readonly unknown[]) collectStrings(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
}

// --- file tools ------------------------------------------------------------

function mapWrite(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const path = stringArg(args, "path");
  if (path === undefined) return missingArg("write", "path", "write_file");

  const scheme = uriScheme(path);
  if (scheme === "xd") {
    return mapDeviceWrite(path.slice(DEVICE_PREFIX.length).trim(), args, resolve);
  }
  // `local://` is the session artifact sandbox and `conflict://` replays a
  // region the model already read; the spec table maps neither. Any other
  // writable internal resource (`vault://`, ...) is likewise not a file write,
  // so no path rule could apply to it.
  if (scheme !== undefined && scheme !== "file") return NOT_MAPPED;

  const target = scheme === "file" ? stripScheme(path, scheme) : path;
  const normalized = resolve(target);
  // `db.sqlite:table:key` with blank content deletes that row. A selector
  // carrying a `:` is the row-key form. This does not check the file kind, so
  // an archive entry whose inner path contains a `:` is classified the same
  // way; that errs toward `delete_path`, the stricter of the two.
  const isRowDelete =
    normalized.selector !== undefined &&
    normalized.selector.includes(":") &&
    (stringArg(args, "content") ?? "").trim().length === 0;

  return oneCall(isRowDelete ? "delete_path" : "write_file", [toPathInput(normalized)]);
}

/**
 * `write` to `xd://<device>` dispatches a mounted tool, so the real call is the
 * device's own. Re-map it under the device name.
 *
 * An unknown device or unparseable payload yields no calls: a device dispatch
 * is not a file write, and answering it with a `default`-only `write_file`
 * would apply the wrong tool's rules in both directions. The warning is what
 * keeps that from being a silent hole.
 */
function mapDeviceWrite(
  device: string,
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  if (device.length === 0) return NOT_MAPPED;
  if (UNGATED_DEVICES[device] === true) return NOT_MAPPED;
  if (!Object.hasOwn(MAPPERS, device)) {
    return {
      calls: [],
      warning: `write dispatched the tool device "xd://${device}", which omp-toolgate has no mapping for; the call was not gated.`,
    };
  }
  const parsed = tryParseJson(stringArg(args, "content"));
  if (parsed === undefined) {
    return {
      calls: [],
      warning: `write to "xd://${device}" carried content that is not valid JSON; the call was not gated.`,
    };
  }
  return mapToolCall(`${DEVICE_PREFIX}${device}`, parsed.value, resolve);
}

function mapEdit(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const raw = stringArg(args, "input");
  if (raw === undefined) return missingArg("edit", "input", "edit_file");

  const sections = parseHashline(raw);
  if (sections === undefined) {
    return {
      calls: [{ virtualTool: "edit_file", inputs: EMPTY_INPUTS }],
      warning: `edit carried no [PATH#TAG] section heading; only the edit_file default applies.`,
    };
  }

  // One call can edit, delete and move at once, so group the sections by
  // virtual tool and let the caller take the most restrictive outcome.
  const grouped = new Map<string, DecisionInput[]>();
  for (const section of sections) {
    let inputs = grouped.get(section.op);
    if (inputs === undefined) {
      inputs = [];
      grouped.set(section.op, inputs);
    }
    inputs.push(toPathInput(resolve(section.path)));
    // A move is judged on both ends.
    if (section.dest !== undefined) inputs.push(toPathInput(resolve(section.dest)));
  }

  const calls: MappedCall[] = [];
  for (const [virtualTool, inputs] of grouped) calls.push({ virtualTool, inputs });
  return { calls };
}

function mapRead(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const path = stringArg(args, "path");
  if (path === undefined) return missingArg("read", "path", "read_file");

  // The spec table names `http://` and `https://`; omp's `parseReadUrlTarget()`
  // also accepts a bare `www.` host and fetches it before ever looking at the
  // filesystem, so that form is a `fetch` here too rather than a bogus path.
  if (isWebUrl(path)) return oneCall("fetch", [{ value: path }]);

  const scheme = uriScheme(path);
  if (scheme === "skill") {
    const rest = stripScheme(path, scheme).trim();
    if (rest.length === 0) return NOT_MAPPED;
    // omp's real skill roots are not consulted, so this is a best-effort path:
    // `skill://<name>` is the skill's own `SKILL.md`, and `skill://<name>/<f>`
    // is that file inside it.
    const relative = rest.includes("/") ? rest : `${rest}/SKILL.md`;
    return oneCall("skill", [toPathInput(resolve(relative))]);
  }
  // Every other internal URI (`agent://`, `artifact://`, `local://`,
  // `memory://`, `history://`, `issue://`, `pr://`, `omp://`, `mcp://`,
  // `ssh://`, `xd://`, `rule://`, ...) reads a resource no path rule describes.
  // `file://` is not one of them: omp expands it to a local path.
  if (scheme !== undefined && scheme !== "file") return NOT_MAPPED;

  const target = scheme === "file" ? stripScheme(path, scheme) : path;
  return oneCall("read_file", [toPathInput(resolve(target))]);
}

function mapGlob(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const targets = splitTargets(stringArg(args, "path") ?? "");
  if (targets.length === 0) targets.push(GLOB_DEFAULT_TARGET);
  return oneCall("find_path", targets.map((target) => toPathInput(resolve(target))));
}

function mapGrep(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  return oneCall("grep", searchInputs(stringArg(args, "pattern"), args, resolve));
}

function mapAstGrep(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  return oneCall("grep", searchInputs(stringArg(args, "pat"), args, resolve));
}

/**
 * A search maps its pattern text plus its search roots. Unlike `glob`, neither
 * `grep` nor `ast_grep` gets a `.` default: the spec table grants that only to
 * `glob`, and inventing an input would add one more string an `always_allow`
 * rule has to satisfy.
 */
function searchInputs(
  pattern: string | undefined,
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): readonly DecisionInput[] {
  const inputs: DecisionInput[] = [];
  if (pattern !== undefined) inputs.push({ value: pattern });
  for (const target of splitTargets(stringArg(args, "path") ?? "")) {
    inputs.push(toPathInput(resolve(target)));
  }
  return inputs;
}

function mapAstEdit(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const paths = args["paths"];
  const inputs: DecisionInput[] = [];
  if (Array.isArray(paths)) {
    for (const entry of paths as readonly unknown[]) {
      if (typeof entry !== "string") continue;
      const target = entry.trim();
      if (target.length > 0) inputs.push(toPathInput(resolve(target)));
    }
  }
  return oneCall("edit_file", inputs);
}

function mapManageSkill(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const action = stringArg(args, "action");
  const isDelete = action === "delete";
  // `create` / `update` write the file, `delete` removes it. An unrecognized
  // action cannot happen through omp's schema; treat it as a write, the
  // majority case, so that a `default` still applies.
  const virtualTool = isDelete ? "delete_path" : "write_file";
  const name = stringArg(args, "name");
  if (name === undefined || (!isDelete && action !== "create" && action !== "update")) {
    return oneCall(virtualTool, EMPTY_INPUTS);
  }
  return oneCall(virtualTool, [
    toPathInput(resolve(`${MANAGED_SKILLS_ROOT}/${name}/SKILL.md`)),
  ]);
}

function mapMemoryEdit(args: Readonly<Record<string, unknown>>): MappingResult {
  // `update` and `invalidate` keep the row; only `forget` hard-deletes it.
  if (stringArg(args, "op") !== "forget") return NOT_MAPPED;
  const id = stringArg(args, "id");
  // A memory id is not a path, so it carries no scope.
  return oneCall("delete_path", id === undefined ? EMPTY_INPUTS : [{ value: id }]);
}

// --- execution tools -------------------------------------------------------

function mapBash(args: Readonly<Record<string, unknown>>): MappingResult {
  const command = stringArg(args, "command");
  if (command === undefined) return missingArg("bash", "command", "terminal");
  // Splitting a compound command into sub-commands belongs to the decision
  // step, which needs Zed's ANY/ALL semantics to do it.
  return oneCall("terminal", [{ value: command }]);
}

function mapHub(args: Readonly<Record<string, unknown>>): MappingResult {
  // Messaging, job control and log reads start no process.
  if (stringArg(args, "op") !== "start") return NOT_MAPPED;
  const application = stringArg(args, "application");
  if (application === undefined) return oneCall("terminal", EMPTY_INPUTS);
  return oneCall("terminal", [{ value: joinCommand(application, args["args"]) }]);
}

function mapDebug(args: Readonly<Record<string, unknown>>): MappingResult {
  const action = stringArg(args, "action");
  // Only `launch` and `attach` start or seize a process; the rest drive one
  // that is already gated.
  if (action !== "launch" && action !== "attach") return NOT_MAPPED;
  const program = stringArg(args, "program");
  if (program === undefined) return oneCall("terminal", EMPTY_INPUTS);
  return oneCall("terminal", [{ value: joinCommand(program, args["args"]) }]);
}

/** `application` / `program` plus argv, as the one string a rule would match. */
function joinCommand(head: string, rawArgs: unknown): string {
  if (!Array.isArray(rawArgs)) return head;
  let command = head;
  for (const arg of rawArgs as readonly unknown[]) {
    if (typeof arg === "string") command += ` ${arg}`;
  }
  return command;
}

/** Arbitrary code. Deliberately no inputs: only `eval`'s `default` applies. */
function mapEval(): MappingResult {
  return oneCall("eval", EMPTY_INPUTS);
}

/** Arbitrary code again, this time with a page attached. */
function mapBrowser(): MappingResult {
  return oneCall("browser", EMPTY_INPUTS);
}

function mapTask(args: Readonly<Record<string, unknown>>): MappingResult {
  // The batch shape is `{ context, tasks: [...] }`; the flat shape is one item
  // at the top level. omp accepts both.
  const tasks: unknown = args["tasks"];
  const entries: readonly unknown[] = Array.isArray(tasks) ? (tasks as unknown[]) : [args];

  const inputs: DecisionInput[] = [];
  for (const entry of entries) {
    const item = asRecord(entry);
    if (item === undefined) continue;
    const text = stringArg(item, "task");
    if (text === undefined) continue;
    const agent = stringArg(item, "agent") ?? DEFAULT_AGENT_TYPE;
    inputs.push({ value: `${agent} ${text}` });
  }
  return oneCall("spawn_agent", inputs);
}

function mapWebSearch(args: Readonly<Record<string, unknown>>): MappingResult {
  const query = stringArg(args, "query");
  return oneCall("web_search", query === undefined ? EMPTY_INPUTS : [{ value: query }]);
}

function mapLsp(args: Readonly<Record<string, unknown>>): MappingResult {
  const action = stringArg(args, "action");
  if (action === undefined || LSP_EDIT_ACTIONS[action] !== true) return NOT_MAPPED;
  // Which files a `WorkspaceEdit` touches is not knowable here, so there are no
  // inputs and only `edit_file`'s `default` applies. `code_actions` is gated
  // even when it only lists, because the table does not distinguish `apply`.
  return oneCall("edit_file", EMPTY_INPUTS);
}

/**
 * Keyed by canonical real tool name with any `xd://` device prefix removed, so
 * that a built-in mounted as a tool device (`xd://memory_edit`) and the same
 * built-in at top level share one entry.
 */
const MAPPERS: Readonly<Record<string, ArgMapper>> = {
  write: mapWrite,
  edit: mapEdit,
  read: mapRead,
  glob: mapGlob,
  grep: mapGrep,
  ast_edit: mapAstEdit,
  ast_grep: mapAstGrep,
  manage_skill: mapManageSkill,
  memory_edit: mapMemoryEdit,
  bash: mapBash,
  hub: mapHub,
  debug: mapDebug,
  eval: mapEval,
  browser: mapBrowser,
  task: mapTask,
  web_search: mapWebSearch,
  lsp: mapLsp,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function oneCall(virtualTool: string, inputs: readonly DecisionInput[]): MappingResult {
  return { calls: [{ virtualTool, inputs }] };
}

/**
 * A major tool (`write` / `edit` / `bash` / `read`) called with an argument
 * shape this mapping does not understand. It still gets a `default`-only
 * decision, never an implicit allow.
 */
function missingArg(tool: string, arg: string, virtualTool: string): MappingResult {
  return {
    calls: [{ virtualTool, inputs: EMPTY_INPUTS }],
    warning: `${tool} was called without a string "${arg}"; only the ${virtualTool} default applies.`,
  };
}

function toPathInput(normalized: NormalizedPath): DecisionInput {
  return {
    value: normalized.path,
    scope: normalized.scope,
    escaped: normalized.escaped,
    literal: normalized.literal,
    resolved: normalized.resolved,
  };
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stringArg(
  args: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

const SCHEME = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//;

/**
 * The lowercased scheme of a `<scheme>://` argument, or `undefined` for a plain
 * path. A leading `./` therefore stays a path, which is exactly omp's escape
 * hatch for a URI-looking filename.
 */
function uriScheme(raw: string): string | undefined {
  return SCHEME.exec(raw)?.[1]?.toLowerCase();
}

function stripScheme(raw: string, scheme: string): string {
  return raw.slice(scheme.length + SCHEME_SEPARATOR.length);
}

const WEB_HOST = /^www\./i;

function isWebUrl(raw: string): boolean {
  const scheme = uriScheme(raw);
  if (scheme === "http" || scheme === "https") return true;
  return scheme === undefined && WEB_HOST.test(raw);
}

/**
 * `glob`, `grep` and `ast_grep` take several search roots in one string,
 * separated by `;`. Each root is judged on its own, so a rule cannot be dodged
 * by appending a second root to an allowed one.
 */
function splitTargets(raw: string): string[] {
  const targets: string[] = [];
  for (const part of raw.split(";")) {
    const target = part.trim();
    if (target.length > 0) targets.push(target);
  }
  return targets;
}

/** Wrapped so that a payload of `null` is distinguishable from a parse failure. */
function tryParseJson(text: string | undefined): { readonly value: unknown } | undefined {
  if (text === undefined) return undefined;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return undefined;
  }
}
