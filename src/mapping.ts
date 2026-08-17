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
 * injected `PathResolver`. It does read `splitCommand` from the decision step,
 * which is filesystem-free as well, to learn which files a shell command
 * redirects into.
 */

import { splitCommand } from "./decision.ts";
import { isRecord } from "./types.ts";
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

/**
 * `xd://lsp` actions that can write files. `request` is here because a raw
 * request may be `workspace/executeCommand`, whose `workspace/applyEdit`
 * response the client applies to disk; which files that touches is no more
 * knowable from the arguments than it is for `rename`.
 *
 * `diagnostics` is deliberately absent: the language server compiles the
 * project whether or not this call is gated, so gating it would be theatre.
 */
const LSP_EDIT_ACTIONS: Readonly<Record<string, true>> = {
  rename: true,
  rename_file: true,
  code_actions: true,
  request: true,
};

/**
 * `xd://debug` actions that hand a string to a live process, and the argument
 * carrying it. `evaluate` reaches the adapter's expression evaluator — lldb and
 * gdb both expose `platform shell` there — and `custom_request` hands an
 * arbitrary DAP request to the adapter. Every other action drives a session
 * whose `launch` / `attach` was already gated.
 */
const DEBUG_COMMAND_ARGS: Readonly<Record<string, string>> = {
  evaluate: "expression",
  custom_request: "command",
};

/**
 * `xd://debug` actions that set a breakpoint carrying an expression the adapter
 * evaluates on every hit. `condition` and `hit_condition` are that expression,
 * and it runs in the debuggee's own evaluator: debugpy evaluates Python there,
 * so `__import__("os").system(...)` runs without a further tool call. Removing
 * a breakpoint evaluates nothing, so only the `set_` actions are here.
 */
const DEBUG_EXPRESSION_ACTIONS: Readonly<Record<string, true>> = {
  set_breakpoint: true,
  set_instruction_breakpoint: true,
  set_data_breakpoint: true,
};

/** The breakpoint arguments those actions hand to the adapter's evaluator. */
const DEBUG_EXPRESSION_ARGS = ["condition", "hit_condition"];

/** The `xd://debug` action that overwrites the memory of a running process. */
const DEBUG_WRITE_MEMORY = "write_memory";

/**
 * Internal URI schemes a `write` cannot reach a resource through, and why each
 * one is ungated. omp's registry is `agent`, `artifact`, `history`, `issue`,
 * `local`, `mcp`, `memory`, `omp`, `pr`, `rule`, `security`, `skill`, `ssh`,
 * `vault` and `xd` (`omp://tools/read.md`). Of those, only a handler with a
 * `write` hook writes anything: `ssh://host/<path>` writes a remote file and
 * `vault://` writes a secret, so neither is here. `local://` is this session's
 * own artifact sandbox, `conflict://` replaces a marker region inside a file the
 * model has already read rather than a path this argument names, `xd://` is a
 * device dispatch handled before this table, and everything else listed is
 * read-only, so omp refuses the write before it touches anything. `http://` and
 * `https://` are refused for the same reason.
 *
 * A scheme absent from this table — one an MCP server advertises, or one omp
 * adds later — is treated as a write, because this mapping cannot know that it
 * is not one.
 */
const UNWRITABLE_SCHEMES: Readonly<Record<string, true>> = {
  agent: true,
  artifact: true,
  conflict: true,
  history: true,
  http: true,
  https: true,
  issue: true,
  local: true,
  mcp: true,
  memory: true,
  omp: true,
  pr: true,
  rule: true,
  security: true,
  skill: true,
};

/**
 * Environment variable that relocates omp's agent directory. `src/config.ts`
 * reads the same one: the managed skills a `manage_skill` or `learn` call writes
 * live under whichever directory it names.
 */
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

/**
 * omp's default agent directory, in `~` form so the injected resolver expands
 * it rather than this module reading `HOME` behind the resolver's back.
 */
const DEFAULT_AGENT_DIR = "~/.omp/agent";

/** The shell's own name for a working directory, so a rule can match on it. */
const CWD_NAME = "PWD";

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
  return mapper(isRecord(input) ? input : EMPTY_ARGS, resolve);
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
  if (scheme !== undefined && scheme !== "file") {
    if (UNWRITABLE_SCHEMES[scheme] === true) return NOT_MAPPED;
    // A writable internal resource is a real write: omp documents `ssh://` as
    // `write`-able and routes every registered `write` hook (`vault://`, an
    // MCP-advertised scheme) through this same tool. The URI is kept whole so a
    // rule can target the scheme, and it deliberately skips the resolver: a
    // remote host or a secret store has no project-relative form, and
    // normalizing the text would file `ssh://host/etc/passwd` under the project
    // root as `ssh:/host/etc/passwd` — an `inside` path that does not exist.
    // `outside` is the honest scope, so a `{"scope": "outside"}` rule claims it
    // and an `inside` one cannot.
    return oneCall("write_file", [{ value: path, scope: "outside" }]);
  }

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
  // A scheme that reaches a real filesystem reads a real file, so it is gated as
  // one: `read ssh://host/etc/passwd` returns that host's file. The write side
  // already treats these as `write_file`; leaving the read side open would gate
  // putting content there but not taking content out.
  // `xd://<device>` is excluded: reading one returns the device's documentation,
  // not a file. Writing to it is a tool dispatch, handled far earlier.
  if (
    scheme !== undefined &&
    scheme !== "file" &&
    scheme !== "xd" &&
    UNWRITABLE_SCHEMES[scheme] !== true
  ) {
    return oneCall("read_file", [{ value: path, scope: "outside" }]);
  }
  // Every other internal URI (`agent://`, `artifact://`, `local://`,
  // `memory://`, `history://`, `issue://`, `pr://`, `omp://`, `mcp://`,
  // `xd://`, `rule://`, ...) reads a resource no path rule describes.
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

/**
 * Where `manage_skill` and `learn` write a managed skill. The session's real
 * agent directory is not readable from here, so the path is best-effort: the
 * relocation variable when it is set, and omp's default otherwise. The
 * `write_file` / `delete_path` rules apply to whichever it is.
 */
function managedSkillPath(name: string): string {
  // An empty variable counts as unset, exactly as `discoverConfigPaths` reads it.
  const relocated = process.env[AGENT_DIR_ENV];
  const agentDir = relocated === undefined || relocated === "" ? DEFAULT_AGENT_DIR : relocated;
  return `${agentDir}/managed-skills/${name}/SKILL.md`;
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
  return oneCall(virtualTool, [toPathInput(resolve(managedSkillPath(name)))]);
}

/**
 * `learn` stores a lesson and, with a `skill` argument, writes the very same
 * `<agent-dir>/managed-skills/<name>/SKILL.md` that `manage_skill` is gated
 * for — `create` and `update` both write it. A lesson on its own reaches only
 * the memory backend's own store, which no path rule describes; that is why
 * `memory_edit`'s `update` is not mapped either.
 */
function mapLearn(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const skill = args["skill"];
  if (!isRecord(skill)) return NOT_MAPPED;
  const name = stringArg(skill, "name");
  if (name === undefined) return oneCall("write_file", EMPTY_INPUTS);
  return oneCall("write_file", [toPathInput(resolve(managedSkillPath(name)))]);
}

function mapMemoryEdit(args: Readonly<Record<string, unknown>>): MappingResult {
  // `update` and `invalidate` keep the row; only `forget` hard-deletes it.
  if (stringArg(args, "op") !== "forget") return NOT_MAPPED;
  const id = stringArg(args, "id");
  // A memory id is not a path, so it carries no scope.
  return oneCall("delete_path", id === undefined ? EMPTY_INPUTS : [{ value: id }]);
}

// --- execution tools -------------------------------------------------------

function mapBash(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const command = stringArg(args, "command");
  if (command === undefined) return missingArg("bash", "command", "terminal");
  return commandCalls(command, resolve);
}

function mapHub(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const op = stringArg(args, "op");
  if (op === "start") {
    const application = stringArg(args, "application");
    if (application === undefined) return oneCall("terminal", EMPTY_INPUTS);
    return commandCalls(launchCommand(application, args), resolve);
  }
  // `list`, `jobs`, `inbox`, `wait`, `ps`, `logs` and `describe` read state, and
  // `cancel` / `stop` / `restart` only address a process whose launch line was
  // already judged at `start`.
  if (op !== "send") return NOT_MAPPED;

  // A `send` carrying `text` writes stdin of a supervised process, so it is a
  // command line for whatever runs there: gating `start` alone would leave
  // `hub start /bin/sh` followed by arbitrary `text` completely open. `keys` and
  // `signal` are input to that process too but carry no command text, so only
  // the `terminal` default applies — as it does for a `text` of the wrong type,
  // which is a payload this mapping cannot read rather than an absent one. A
  // `send` with none of the three addresses a peer agent (`to` / `message`) and
  // reaches no process.
  const text = args["text"];
  if (typeof text === "string") return commandCalls(text, resolve);
  const reachesProcess =
    text !== undefined || args["keys"] !== undefined || args["signal"] !== undefined;
  return reachesProcess ? oneCall("terminal", EMPTY_INPUTS) : NOT_MAPPED;
}

function mapDebug(
  args: Readonly<Record<string, unknown>>,
  resolve: PathResolver,
): MappingResult {
  const action = stringArg(args, "action");
  if (action === undefined) return NOT_MAPPED;
  if (action === "launch" || action === "attach") {
    const program = stringArg(args, "program");
    if (program === undefined) return oneCall("terminal", EMPTY_INPUTS);
    return commandCalls(launchCommand(program, args), resolve);
  }
  // `Object.hasOwn` because the action is untrusted: an inherited
  // `Object.prototype` member must not resolve to an argument name.
  const key = Object.hasOwn(DEBUG_COMMAND_ARGS, action) ? DEBUG_COMMAND_ARGS[action] : undefined;
  if (key !== undefined) {
    const command = stringArg(args, key);
    return command === undefined
      ? oneCall("terminal", EMPTY_INPUTS)
      : commandCalls(command, resolve);
  }
  // `write_memory` overwrites the memory of a running process, which is
  // arbitrary mutation of whatever that program does next. Neither a base64
  // payload nor an address is text a rule could read, so only `terminal`'s
  // `default` applies — the treatment a `hub send` key sequence already gets.
  if (action === DEBUG_WRITE_MEMORY) return oneCall("terminal", EMPTY_INPUTS);
  if (DEBUG_EXPRESSION_ACTIONS[action] === true) {
    const expressions: DecisionInput[] = [];
    for (const name of DEBUG_EXPRESSION_ARGS) {
      const expression = stringArg(args, name);
      if (expression !== undefined) expressions.push({ value: expression });
    }
    // A breakpoint without a condition evaluates nothing and stays unmapped.
    if (expressions.length > 0) return oneCall("terminal", expressions);
  }
  return NOT_MAPPED;
}

/**
 * The calls one command string maps to: `terminal` judged on the whole string,
 * plus — when the command redirects into real files — a `write_file` call
 * carrying those targets, so that `write_file.always_deny` on `\.ssh/` governs
 * `printf x >> ~/.ssh/authorized_keys` the way it governs a `write`. The
 * decision step takes the strictest outcome across the calls, so a denied
 * target denies the whole command.
 *
 * Splitting into sub-commands stays in the decision step, which needs Zed's
 * ANY/ALL semantics for it; only the targets are needed here, and a command the
 * splitter cannot read with confidence contributes none.
 */
function commandCalls(command: string, resolve: PathResolver): MappingResult {
  const terminal: MappedCall = { virtualTool: "terminal", inputs: [{ value: command }] };
  const split = splitCommand(command);
  if (split === undefined) return { calls: [terminal] };

  const targets: DecisionInput[] = [];
  for (const target of split.redirects) {
    // `(( a > 10 ))` and `[[ $a > $b ]]` are an arithmetic evaluation and a
    // test, not redirections, and nothing in the text distinguishes them from
    // one. Their right-hand side names no file, so resolving it emits a
    // `write_file` call for `10` or for `$b` — which reads as a project-relative
    // name, comes back `escaped`, and makes an arithmetic comparison prompt.
    // What is left after the expansions are removed is the test: a target that
    // keeps literal path text (`$HOME/.ssh/authorized_keys`) is a real
    // redirection and the resolver reports it as unexpanded, while one that is
    // nothing but an expansion or a number is dropped. Neither case costs
    // coverage on the `terminal` side, which sees the whole command string and,
    // in the decision step, one `> <target>` input per redirect.
    const literal = target.replace(EXPANSIONS, "");
    if (literal === "" || NUMERIC_TARGET.test(literal)) continue;
    targets.push(toPathInput(resolve(target)));
  }
  if (targets.length === 0) return { calls: [terminal] };
  return { calls: [terminal, { virtualTool: "write_file", inputs: targets }] };
}

/** A redirect target that is nothing but digits, so it names no file. */
const NUMERIC_TARGET = /^[0-9]+$/;
/** The expansions the splitter keeps as source text, for stripping them out. */
const EXPANSIONS = /\$\{[^}]*\}|\$\([^)]*\)|`[^`]*`|\$[\w@*#?$!-]+/g;
/** Characters a value may carry and still be one shell word without quotes. */
const SAFE_VALUE = /^[A-Za-z0-9_@%+=:,./-]*$/;

/**
 * A launch spec as the one string a rule sees: `PWD=<cwd> NAME=value … head args`.
 *
 * A launch is not just a command line. `NODE_OPTIONS`, `BASH_ENV`, `LD_PRELOAD`
 * and `DYLD_INSERT_LIBRARIES` load attacker-chosen code into an innocuous
 * `node -v`, and `cwd` decides which file a relative program name resolves to,
 * so both belong in what the `terminal` rules match. They go in front, in the
 * shell's own assignment-prefix shape, so that a rule anchored with `^` cannot
 * be satisfied by hiding the payload in the environment: `^node -v$` stops
 * matching once `NODE_OPTIONS` is set. Keys are sorted, so the string does not
 * depend on the order the arguments happened to arrive in.
 */
function launchCommand(head: string, args: Readonly<Record<string, unknown>>): string {
  const assignments: [string, string][] = [];
  const cwd = stringArg(args, "cwd");
  if (cwd !== undefined && cwd !== "") assignments.push([CWD_NAME, cwd]);
  const env = args["env"];
  if (isRecord(env)) {
    for (const name of Object.keys(env).sort()) {
      const value = env[name];
      if (typeof value === "string") assignments.push([name, value]);
    }
  }

  let command = "";
  for (const [name, value] of assignments) {
    // A value outside the safe set is single quoted so that it stays one word:
    // an unquoted space would end the assignment run, putting the value's own
    // tail where the decision step looks for the command name, and a `>` or
    // `&&` inside a value would read there as a redirection or an operator. The
    // decision step judges unquoted word text, so the quotes take nothing away
    // from what a rule can match.
    const safe = SAFE_VALUE.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
    command += `${name}=${safe} `;
  }
  command += head;

  const rawArgs = args["args"];
  if (!Array.isArray(rawArgs)) return command;
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

/**
 * Arbitrary code a third time, this time against the host desktop: real
 * keyboard and pointer input into any window, the clipboard, and OS
 * accessibility. It gets its own virtual tool with no inputs for the same
 * reason `eval` does — a rule matched against a script would be all false
 * positives — and omp routes the script's own `tool.<name>()` calls back
 * through `tool_call`, so those stay individually gated. A `read_only: true`
 * run is included: it still reads every window on the user's screen.
 */
function mapComputer(): MappingResult {
  return oneCall("computer", EMPTY_INPUTS);
}

function mapTask(args: Readonly<Record<string, unknown>>): MappingResult {
  // The batch shape is `{ context, tasks: [...] }`; the flat shape is one item
  // at the top level. omp accepts both.
  const tasks: unknown = args["tasks"];
  const entries: readonly unknown[] = Array.isArray(tasks) ? (tasks as unknown[]) : [args];

  const inputs: DecisionInput[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const text = stringArg(entry, "task");
    if (text === undefined) continue;
    const agent = stringArg(entry, "agent") ?? DEFAULT_AGENT_TYPE;
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
  // even when it only lists, because the table does not distinguish `apply`, and
  // `request` is gated whatever method it names, because the arguments are the
  // server's business rather than this mapping's.
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
  learn: mapLearn,
  memory_edit: mapMemoryEdit,
  bash: mapBash,
  hub: mapHub,
  debug: mapDebug,
  eval: mapEval,
  browser: mapBrowser,
  computer: mapComputer,
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
    unexpanded: normalized.unexpanded,
    literal: normalized.literal,
    resolved: normalized.resolved,
  };
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
