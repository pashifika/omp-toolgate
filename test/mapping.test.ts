/**
 * Covers every row and scenario of `specs/tool-input-mapping/spec.md`.
 *
 * Path normalization is stubbed: the real `PathResolver` needs a filesystem to
 * resolve symlinks, and mapping only has to hand it the right raw strings and
 * pass its answer through untouched.
 */

import { describe, expect, it } from "vitest";

import { canonicalizeToolName, mapToolCall, parseHashline } from "../src/mapping.ts";
import type { HashlineSection } from "../src/mapping.ts";
import type { NormalizedPath, PathResolver, PathScope } from "../src/types.ts";

const CWD = "/repo";
const HOME = "/home/u";

/** Suffixes after which the stub treats trailing `:` text as a selector. */
const SELECTOR_BEARING = [
  ".sqlite",
  ".sqlite3",
  ".db",
  ".db3",
  ".zip",
  ".tar.gz",
  ".tgz",
  ".tar",
  ".jar",
];

/**
 * Deterministic stand-in for `normalizePath`: strips a selector, expands `~`,
 * absolutizes against `/repo`, resolves `.` and `..`, then reports anything
 * under `/repo` as `inside` and relative, everything else as `outside` and
 * absolute. A target still carrying `$name`, `${…}` or `$(…)` is never `inside`,
 * exactly as `normalizeAgainstRoot` treats one: only the shell knows where it
 * lands.
 */
const resolve: PathResolver = (raw: string): NormalizedPath => {
  const colon = raw.indexOf(":");
  const head = colon < 0 ? raw : raw.slice(0, colon);
  const carriesSelector = colon > 0 && SELECTOR_BEARING.some((ext) => head.endsWith(ext));
  const base = carriesSelector ? head : raw;
  const expanded = base.startsWith("~/") ? `${HOME}/${base.slice(2)}` : base;

  const segments: string[] = [];
  const absolute = expanded.startsWith("/") ? expanded : `${CWD}/${expanded}`;
  for (const segment of absolute.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const literal = `/${segments.join("/")}`;
  const unexpanded = /\$[\w{(]/.test(expanded);
  const inside = !unexpanded && (literal === CWD || literal.startsWith(`${CWD}/`));
  const relative = literal.slice(CWD.length + 1);

  return {
    path: inside ? (relative === "" ? "." : relative) : literal,
    scope: inside ? "inside" : "outside",
    escaped: !inside && literal.startsWith(`${CWD}/`),
    literal,
    resolved: literal,
    selector: carriesSelector ? raw.slice(colon + 1) : undefined,
    unexpanded,
  };
};

/** One mapping expectation: which virtual tools, and what they are judged on. */
interface MapCase {
  /** Reads as the test name, so a row identifies its spec scenario. */
  readonly case: string;
  readonly tool: string;
  readonly input: unknown;
  /** Every expected call in order. Empty means the call is not gated at all. */
  readonly expected: readonly { readonly virtualTool: string; readonly values: readonly string[] }[];
  /** Expected `warning` text. Absent asserts that there is no warning. */
  readonly warning?: RegExp;
}

const MANAGED_SKILL = "/home/u/.omp/agent/managed-skills/my-skill/SKILL.md";

function expectMapping({ tool, input, expected, warning }: MapCase): void {
  const result = mapToolCall(tool, input, resolve);
  expect(
    result.calls.map((call) => ({
      virtualTool: call.virtualTool,
      values: call.inputs.map((entry) => entry.value),
    })),
  ).toStrictEqual(expected);
  if (warning === undefined) expect(result.warning).toBeUndefined();
  else expect(result.warning).toMatch(warning);
}

// ---------------------------------------------------------------------------

const NAME_CASES = [
  { case: "mcp__github__create_issue", expected: "mcp:github:create_issue" },
  // Already canonical: the configuration side accepts both spellings.
  { case: "mcp:github:create_issue", expected: "mcp:github:create_issue" },
  // Split on the first `__` after the prefix, so a tool name keeps its own.
  { case: "mcp__github__create__issue", expected: "mcp:github:create__issue" },
  { case: "write", expected: "write" },
  { case: "mcp__github", expected: "mcp__github" },
  { case: "mcp____tool", expected: "mcp____tool" },
];

describe("canonicalizeToolName", () => {
  it.each(NAME_CASES)("canonicalizes $case to $expected", ({ case: name, expected }) => {
    expect(canonicalizeToolName(name)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------

interface HashlineCase {
  readonly case: string;
  readonly input: string;
  readonly expected: readonly HashlineSection[] | undefined;
}

const HASHLINE_CASES: HashlineCase[] = [
  {
    case: "reads a replacement section as an edit",
    input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x",
    expected: [{ path: "src/a.ts", op: "edit_file", dest: undefined }],
  },
  {
    case: "reads a REM section as a deletion",
    input: "[src/a.ts#1A2B]\nREM",
    expected: [{ path: "src/a.ts", op: "delete_path", dest: undefined }],
  },
  {
    case: "reads an MV section as a move and keeps its destination",
    input: "[src/a.ts#1A2B]\nMV lib/a.ts",
    expected: [{ path: "src/a.ts", op: "move_path", dest: "lib/a.ts" }],
  },
  {
    case: "unquotes a double-quoted destination containing spaces",
    input: '[src/a.ts#1A2B]\nMV "lib/my file.ts"',
    expected: [{ path: "src/a.ts", op: "move_path", dest: "lib/my file.ts" }],
  },
  {
    case: "unquotes a single-quoted destination containing spaces",
    input: "[src/a.ts#1A2B]\nMV 'lib/my file.ts'",
    expected: [{ path: "src/a.ts", op: "move_path", dest: "lib/my file.ts" }],
  },
  {
    case: "classifies each section of a multi-section payload on its own",
    input: "[a.ts#1A2B]\nPUT 1.=1:\n+x\n[b.ts#3C4D]\nREM",
    expected: [
      { path: "a.ts", op: "edit_file", dest: undefined },
      { path: "b.ts", op: "delete_path", dest: undefined },
    ],
  },
  {
    case: "reads a + row as file content, never as an operation",
    input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+REM\n+MV elsewhere",
    expected: [{ path: "src/a.ts", op: "edit_file", dest: undefined }],
  },
  {
    case: "lets REM outrank MV within one section",
    input: "[a.ts#1A2B]\nPUT 1.=1:\n+x\nMV b.ts\nREM",
    expected: [{ path: "a.ts", op: "delete_path", dest: undefined }],
  },
  {
    case: "lets MV outrank PUT within one section",
    input: "[a.ts#1A2B]\nPUT 1.=1:\n+x\nMV b.ts",
    expected: [{ path: "a.ts", op: "move_path", dest: "b.ts" }],
  },
  {
    case: "ignores the custom-tool envelope and any preamble",
    input: "*** Begin Patch\n[a.ts#1A2B]\nCUT 1.=1 @fn\n*** End Patch",
    expected: [{ path: "a.ts", op: "edit_file", dest: undefined }],
  },
  {
    case: "gives up on a payload with no section heading",
    input: "PUT 1.=1:\n+x",
    expected: undefined,
  },
  { case: "gives up on an empty payload", input: "", expected: undefined },
  {
    case: "gives up when the snapshot tag is not four hex digits",
    input: "[src/a.ts#12G4]\nREM",
    expected: undefined,
  },
];

describe("parseHashline", () => {
  it.each(HASHLINE_CASES)("$case", ({ input, expected }) => {
    expect(parseHashline(input)).toStrictEqual(expected);
  });
});

// ---------------------------------------------------------------------------

const FILE_CASES: MapCase[] = [
  {
    case: "maps an ordinary write to write_file",
    tool: "write",
    input: { path: "/repo/src/a.ts", content: "..." },
    expected: [{ virtualTool: "write_file", values: ["src/a.ts"] }],
  },
  {
    case: "maps a write through an archive selector to the archive file",
    tool: "write",
    input: { path: "fixtures/archive.zip:templates/email.txt", content: "hello\n" },
    expected: [{ virtualTool: "write_file", values: ["fixtures/archive.zip"] }],
  },
  {
    case: "maps a SQLite table insert to the database file",
    tool: "write",
    input: { path: "data/app.sqlite:users", content: "{name: 'Ada'}" },
    expected: [{ virtualTool: "write_file", values: ["data/app.sqlite"] }],
  },
  {
    case: "maps a SQLite row delete to delete_path",
    tool: "write",
    input: { path: "data/app.sqlite:users:42", content: "   " },
    expected: [{ virtualTool: "delete_path", values: ["data/app.sqlite"] }],
  },
  {
    case: "maps a SQLite row update to write_file, not delete_path",
    tool: "write",
    input: { path: "data/app.sqlite:users:42", content: "{name:'a'}" },
    expected: [{ virtualTool: "write_file", values: ["data/app.sqlite"] }],
  },
  {
    case: "does not map a local:// write",
    tool: "write",
    input: { path: "local://notes.md", content: "..." },
    expected: [],
  },
  {
    case: "does not map a conflict:// write",
    tool: "write",
    input: { path: "conflict://1", content: "@ours" },
    expected: [],
  },
  {
    case: "judges the normalized path, so traversal cannot dodge a rule",
    tool: "write",
    input: { path: "src/../../etc/hosts", content: "" },
    expected: [{ virtualTool: "write_file", values: ["/etc/hosts"] }],
  },
  {
    case: "maps an ordinary read to read_file",
    tool: "read",
    input: { path: "src/a.ts" },
    expected: [{ virtualTool: "read_file", values: ["src/a.ts"] }],
  },
  {
    case: "maps a URL read to fetch with the URL string",
    tool: "read",
    input: { path: "https://example.com/a.json" },
    expected: [{ virtualTool: "fetch", values: ["https://example.com/a.json"] }],
  },
  {
    // omp's `parseReadUrlTarget()` fetches a bare `www.` host too, before it
    // ever looks at the filesystem.
    case: "maps a bare www. read to fetch",
    tool: "read",
    input: { path: "www.example.com" },
    expected: [{ virtualTool: "fetch", values: ["www.example.com"] }],
  },
  {
    case: "maps a skill read to that skill's SKILL.md",
    tool: "read",
    input: { path: "skill://commit-message" },
    expected: [{ virtualTool: "skill", values: ["commit-message/SKILL.md"] }],
  },
  {
    case: "maps a read of a file inside a skill to that file",
    tool: "read",
    input: { path: "skill://dd-apm/references/x.md" },
    expected: [{ virtualTool: "skill", values: ["dd-apm/references/x.md"] }],
  },
  {
    case: "maps a glob with no path to the project root",
    tool: "glob",
    input: {},
    expected: [{ virtualTool: "find_path", values: ["."] }],
  },
  {
    case: "maps a glob with an empty path to the project root",
    tool: "glob",
    input: { path: "" },
    expected: [{ virtualTool: "find_path", values: ["."] }],
  },
  {
    case: "judges each root of a multi-root glob on its own",
    tool: "glob",
    input: { path: "src/**/*.ts; test/**/*.ts" },
    expected: [{ virtualTool: "find_path", values: ["src/**/*.ts", "test/**/*.ts"] }],
  },
  {
    case: "maps grep to its pattern plus every search root",
    tool: "grep",
    input: { pattern: "TODO", path: "src; ~/.aws" },
    expected: [{ virtualTool: "grep", values: ["TODO", "src", "/home/u/.aws"] }],
  },
  {
    // The table grants a `.` default to `glob` alone; inventing one here would
    // add another string an `always_allow` rule has to satisfy.
    case: "maps a grep with no path to its pattern alone",
    tool: "grep",
    input: { pattern: "TODO" },
    expected: [{ virtualTool: "grep", values: ["TODO"] }],
  },
  {
    case: "maps ast_grep to grep with its pattern and path",
    tool: "xd://ast_grep",
    input: { pat: "foo($A)", path: "src" },
    expected: [{ virtualTool: "grep", values: ["foo($A)", "src"] }],
  },
  {
    case: "maps ast_edit to edit_file with every rewritten path",
    tool: "xd://ast_edit",
    input: { ops: [{ pat: "a", out: "b" }], paths: ["src/a.ts", "src/b.ts"] },
    expected: [{ virtualTool: "edit_file", values: ["src/a.ts", "src/b.ts"] }],
  },
  {
    case: "maps a manage_skill create to the managed SKILL.md",
    tool: "manage_skill",
    input: { action: "create", name: "my-skill", description: "d", body: "b" },
    expected: [{ virtualTool: "write_file", values: [MANAGED_SKILL] }],
  },
  {
    case: "maps a manage_skill update to the managed SKILL.md",
    tool: "manage_skill",
    input: { action: "update", name: "my-skill", description: "d", body: "b" },
    expected: [{ virtualTool: "write_file", values: [MANAGED_SKILL] }],
  },
  {
    case: "maps a manage_skill delete to delete_path on the same file",
    tool: "manage_skill",
    input: { action: "delete", name: "my-skill" },
    expected: [{ virtualTool: "delete_path", values: [MANAGED_SKILL] }],
  },
  {
    // Blocker: omp documents `ssh://` as `write`-able, so the first round's
    // premise that a non-`file` scheme is never a write was wrong.
    case: "maps a write to a remote ssh path to write_file",
    tool: "write",
    input: { path: "ssh://host/etc/passwd", content: "root::0:0:::\n" },
    expected: [{ virtualTool: "write_file", values: ["ssh://host/etc/passwd"] }],
  },
  {
    // The write side gates `ssh://`, so the read side must too — otherwise the
    // gate governs putting content on a remote host but not taking it off one.
    case: "maps a read of a remote ssh path to read_file",
    tool: "read",
    input: { path: "ssh://host/etc/passwd" },
    expected: [{ virtualTool: "read_file", values: ["ssh://host/etc/passwd"] }],
  },
  {
    case: "does not map a read of a tool device, which returns documentation",
    tool: "read",
    input: { path: "xd://lsp" },
    expected: [],
  },
  {
    case: "maps a write to a vault secret to write_file",
    tool: "write",
    input: { path: "vault://secret/key", content: "..." },
    expected: [{ virtualTool: "write_file", values: ["vault://secret/key"] }],
  },
  {
    // An MCP server may advertise its own writable scheme, and omp may register
    // one later. Not knowing a scheme is no reason to leave the write ungated.
    case: "maps a write to an unrecognized scheme to write_file",
    tool: "write",
    input: { path: "fleet://prod/authorized_keys", content: "..." },
    expected: [{ virtualTool: "write_file", values: ["fleet://prod/authorized_keys"] }],
  },
  {
    case: "maps a learn that writes a managed skill to that SKILL.md",
    tool: "learn",
    input: {
      memory: "a lesson",
      skill: { action: "create", name: "my-skill", description: "d", body: "b" },
    },
    expected: [{ virtualTool: "write_file", values: [MANAGED_SKILL] }],
  },
  {
    case: "maps a learn that updates a managed skill to the same file",
    tool: "learn",
    input: {
      memory: "a lesson",
      skill: { action: "update", name: "my-skill", description: "d", body: "b" },
    },
    expected: [{ virtualTool: "write_file", values: [MANAGED_SKILL] }],
  },
  {
    // A lesson alone reaches the memory backend's own store, like a
    // `memory_edit` update.
    case: "does not map a memory-only learn",
    tool: "learn",
    input: { memory: "a lesson", context: "from a failed build" },
    expected: [],
  },
  {
    case: "applies the write_file default for a learn skill with no name",
    tool: "learn",
    input: { memory: "a lesson", skill: { action: "create" } },
    expected: [{ virtualTool: "write_file", values: [] }],
  },
  {
    case: "maps a memory forget to delete_path on the memory id",
    tool: "memory_edit",
    input: { op: "forget", id: "wm_42" },
    expected: [{ virtualTool: "delete_path", values: ["wm_42"] }],
  },
  {
    case: "does not map a memory update, which keeps the row",
    tool: "memory_edit",
    input: { op: "update", id: "wm_42", content: "..." },
    expected: [],
  },
  {
    case: "does not map a memory invalidate, which keeps the row",
    tool: "memory_edit",
    input: { op: "invalidate", id: "wm_42" },
    expected: [],
  },
];

/** Everything omp's internal-URL router owns that is not a file or a fetch. */
const INTERNAL_READ_SCHEMES = [
  "agent",
  "artifact",
  "local",
  "memory",
  "history",
  "issue",
  "pr",
  "omp",
  "mcp",
  "xd",
  "rule",
];

/**
 * Schemes a `write` reaches no resource through: read-only registry entries plus
 * `local://` (this session's artifact sandbox) and `conflict://` (a marker
 * region inside a file the model already read).
 */
const UNWRITABLE_SCHEMES = [
  "agent",
  "artifact",
  "conflict",
  "history",
  "http",
  "https",
  "issue",
  "local",
  "mcp",
  "memory",
  "omp",
  "pr",
  "rule",
  "security",
  "skill",
];

describe("mapToolCall: file tools", () => {
  it.each(FILE_CASES)("$case", expectMapping);

  it.each(INTERNAL_READ_SCHEMES.map((scheme) => ({ scheme })))(
    "does not map a $scheme:// read",
    ({ scheme }) => {
      expectMapping({
        case: scheme,
        tool: "read",
        input: { path: `${scheme}://x` },
        expected: [],
      });
    },
  );

  it.each(UNWRITABLE_SCHEMES.map((scheme) => ({ scheme })))(
    "does not map a $scheme:// write",
    ({ scheme }) => {
      expectMapping({
        case: scheme,
        tool: "write",
        input: { path: `${scheme}://x`, content: "..." },
        expected: [],
      });
    },
  );
});

// ---------------------------------------------------------------------------

const EDIT_CASES: MapCase[] = [
  {
    case: "maps a replacement section to edit_file",
    tool: "edit",
    input: { input: "[src/a.ts#1A2B]\nPUT 1.=1:\n+x" },
    expected: [{ virtualTool: "edit_file", values: ["src/a.ts"] }],
  },
  {
    case: "maps a REM section to delete_path",
    tool: "edit",
    input: { input: "[src/a.ts#1A2B]\nREM" },
    expected: [{ virtualTool: "delete_path", values: ["src/a.ts"] }],
  },
  {
    case: "maps an MV section to move_path judged on both ends",
    tool: "edit",
    input: { input: "[src/a.ts#1A2B]\nMV lib/a.ts" },
    expected: [{ virtualTool: "move_path", values: ["src/a.ts", "lib/a.ts"] }],
  },
  {
    case: "resolves a quoted move destination",
    tool: "edit",
    input: { input: '[src/a.ts#1A2B]\nMV "lib/my file.ts"' },
    expected: [{ virtualTool: "move_path", values: ["src/a.ts", "lib/my file.ts"] }],
  },
  {
    case: "splits one call across edit_file, delete_path and move_path",
    tool: "edit",
    input: { input: "[a.ts#1A2B]\nPUT 1.=1:\n+x\n[b.ts#3C4D]\nREM\n[c.ts#5E6F]\nMV d.ts" },
    expected: [
      { virtualTool: "edit_file", values: ["a.ts"] },
      { virtualTool: "delete_path", values: ["b.ts"] },
      { virtualTool: "move_path", values: ["c.ts", "d.ts"] },
    ],
  },
  {
    case: "collects sections of the same operation into one call",
    tool: "edit",
    input: { input: "[a.ts#1A2B]\nCUT 1.=1 @fn\n[b.ts#3C4D]\nPUT <1 @fn" },
    expected: [{ virtualTool: "edit_file", values: ["a.ts", "b.ts"] }],
  },
  {
    case: "falls back to the edit_file default when nothing parses",
    tool: "edit",
    input: { input: "PUT 1.=1:\n+x" },
    expected: [{ virtualTool: "edit_file", values: [] }],
    warning: /^edit carried no \[PATH#TAG\]/,
  },
];

describe("mapToolCall: edit sections", () => {
  it.each(EDIT_CASES)("$case", expectMapping);
});

// ---------------------------------------------------------------------------

const EXEC_CASES: MapCase[] = [
  {
    case: "maps bash to terminal",
    tool: "bash",
    input: { command: "sudo ls" },
    expected: [{ virtualTool: "terminal", values: ["sudo ls"] }],
  },
  {
    // Major 2: `write_file.always_deny` on `.ssh` must reach the redirect target,
    // which used to be judged against `terminal` patterns only.
    case: "maps a redirect target to write_file alongside terminal",
    tool: "bash",
    input: { command: "printf x >> ~/.ssh/authorized_keys" },
    expected: [
      { virtualTool: "terminal", values: ["printf x >> ~/.ssh/authorized_keys"] },
      { virtualTool: "write_file", values: ["/home/u/.ssh/authorized_keys"] },
    ],
  },
  {
    // Nothing but a redirection: no sub-command, and still a file to check.
    case: "maps a command that is only a redirect to write_file too",
    tool: "bash",
    input: { command: "> ~/.ssh/authorized_keys" },
    expected: [
      { virtualTool: "terminal", values: ["> ~/.ssh/authorized_keys"] },
      { virtualTool: "write_file", values: ["/home/u/.ssh/authorized_keys"] },
    ],
  },
  {
    case: "maps every redirect target of a compound command",
    tool: "bash",
    input: { command: "printf x > a.txt && printf y > /tmp/b.txt" },
    expected: [
      { virtualTool: "terminal", values: ["printf x > a.txt && printf y > /tmp/b.txt"] },
      { virtualTool: "write_file", values: ["a.txt", "/tmp/b.txt"] },
    ],
  },
  {
    // The change must not widen every command into a write: a read redirect and
    // `/dev/null` are not writes, and neither is an angle bracket in a word.
    case: "leaves a command without a write redirect as one terminal call",
    tool: "bash",
    input: { command: 'git commit -m "fix: a > b" < msg.txt 2>/dev/null' },
    expected: [
      { virtualTool: "terminal", values: ['git commit -m "fix: a > b" < msg.txt 2>/dev/null'] },
    ],
  },
  {
    // An unsplittable command disables `always_allow` in the decision step; it
    // must not invent a target here either.
    case: "emits no write_file call when the command cannot be split",
    tool: "bash",
    input: { command: "printf x > 'unclosed" },
    expected: [{ virtualTool: "terminal", values: ["printf x > 'unclosed"] }],
  },
  {
    // The redirect list is the splitter's best guess, and `(( ))` is arithmetic:
    // resolving `10` as a file made an arithmetic comparison prompt under
    // `write_file.default: confirm`.
    case: "emits no write_file call for an arithmetic comparison",
    tool: "bash",
    input: { command: "(( a > 10 ))" },
    expected: [{ virtualTool: "terminal", values: ["(( a > 10 ))"] }],
  },
  {
    case: "emits no write_file call for a test comparison",
    tool: "bash",
    input: { command: "[[ $a > $b ]]" },
    expected: [{ virtualTool: "terminal", values: ["[[ $a > $b ]]"] }],
  },
  {
    // Nothing but an expansion: no literal text a path rule could read, and
    // resolving it would report `/repo/$OUT` as an escape. The `terminal` side
    // still sees the whole command, and the decision step still checks `> $OUT`.
    case: "emits no write_file call for a redirect target that is only an expansion",
    tool: "bash",
    input: { command: "printf x > $OUT" },
    expected: [{ virtualTool: "terminal", values: ["printf x > $OUT"] }],
  },
  {
    // Literal path text survives the expansion, so the resolver still gets to
    // judge it: it reads as project-relative, lands in the home directory, and
    // comes back `outside` and unexpanded, where `\.ssh/` can deny it.
    case: "still maps a redirect target that keeps literal path text",
    tool: "bash",
    input: { command: "printf x > $HOME/.ssh/authorized_keys" },
    expected: [
      { virtualTool: "terminal", values: ["printf x > $HOME/.ssh/authorized_keys"] },
      { virtualTool: "write_file", values: ["/repo/$HOME/.ssh/authorized_keys"] },
    ],
  },
  {
    case: "still maps a plain redirect target to write_file",
    tool: "bash",
    input: { command: "printf x > out.txt" },
    expected: [
      { virtualTool: "terminal", values: ["printf x > out.txt"] },
      { virtualTool: "write_file", values: ["out.txt"] },
    ],
  },
  {
    case: "maps a process launch to terminal as one command string",
    tool: "hub",
    input: { op: "start", name: "web", application: "bun", args: ["run", "dev"] },
    expected: [{ virtualTool: "terminal", values: ["bun run dev"] }],
  },
  {
    // Blocker: `NODE_OPTIONS` loads attacker-chosen code into an innocuous
    // `node -v`, and `cwd` decides which file a relative program name is. Both
    // have to be in the string the terminal rules match, in front of it, so
    // that a `^`-anchored rule cannot be satisfied while they are set.
    case: "judges a launch spec's environment and cwd, not just its command line",
    tool: "hub",
    input: {
      op: "start",
      name: "web",
      application: "node",
      args: ["-v"],
      cwd: "/srv/app",
      env: { NODE_OPTIONS: "--require /tmp/evil.js" },
    },
    expected: [
      {
        virtualTool: "terminal",
        values: ["PWD=/srv/app NODE_OPTIONS='--require /tmp/evil.js' node -v"],
      },
    ],
  },
  {
    // Sorted, so the same launch spec always produces the same string.
    case: "sorts a launch spec's environment by name",
    tool: "hub",
    input: {
      op: "start",
      application: "node",
      env: { LD_PRELOAD: "/tmp/x.so", BASH_ENV: "/tmp/y.sh", PORT: 8080 },
    },
    expected: [
      { virtualTool: "terminal", values: ["BASH_ENV=/tmp/y.sh LD_PRELOAD=/tmp/x.so node"] },
    ],
  },
  {
    case: "maps a redirect inside a launch line to write_file too",
    tool: "hub",
    input: { op: "start", name: "sh", application: "sh", args: ["-c", "printf x > out.txt"] },
    expected: [
      { virtualTool: "terminal", values: ["sh -c printf x > out.txt"] },
      { virtualTool: "write_file", values: ["out.txt"] },
    ],
  },
  {
    // B3: gating `start` while leaving `send` open left every line typed into a
    // started `/bin/sh` ungated.
    case: "maps process stdin to terminal with the text as the command",
    tool: "hub",
    input: { op: "send", name: "sh", text: "rm -rf ~/Documents" },
    expected: [{ virtualTool: "terminal", values: ["rm -rf ~/Documents"] }],
  },
  {
    case: "maps a redirect typed into a process to write_file too",
    tool: "hub",
    input: { op: "send", name: "sh", text: "cat >> ~/.ssh/authorized_keys" },
    expected: [
      { virtualTool: "terminal", values: ["cat >> ~/.ssh/authorized_keys"] },
      { virtualTool: "write_file", values: ["/home/u/.ssh/authorized_keys"] },
    ],
  },
  {
    // A key sequence is not a command string, but it still reaches the process.
    case: "maps a key sequence to terminal with no inputs",
    tool: "hub",
    input: { op: "send", name: "sh", keys: ["CTRL_C"] },
    expected: [{ virtualTool: "terminal", values: [] }],
  },
  {
    case: "maps a signal to terminal with no inputs",
    tool: "hub",
    input: { op: "send", name: "sh", signal: "SIGKILL" },
    expected: [{ virtualTool: "terminal", values: [] }],
  },
  {
    // A payload this mapping cannot read is not an absent payload.
    case: "maps a send whose text is not a string to terminal with no inputs",
    tool: "hub",
    input: { op: "send", name: "sh", text: 42 },
    expected: [{ virtualTool: "terminal", values: [] }],
  },
  {
    case: "does not map hub messaging",
    tool: "hub",
    input: { op: "send", to: "Main", message: "..." },
    expected: [],
  },
  {
    case: "maps a debug launch to terminal",
    tool: "xd://debug",
    input: { action: "launch", program: "./bin/app", args: ["-v"] },
    expected: [{ virtualTool: "terminal", values: ["./bin/app -v"] }],
  },
  {
    case: "maps a debug attach to terminal",
    tool: "xd://debug",
    input: { action: "attach", program: "./bin/app", pid: 42 },
    expected: [{ virtualTool: "terminal", values: ["./bin/app"] }],
  },
  {
    // A relative `program` resolves against `cwd`, so the launch line alone does
    // not say which file is about to run.
    case: "names a debug launch's cwd in the judged command",
    tool: "xd://debug",
    input: { action: "launch", program: "app", args: ["-v"], cwd: "/tmp/work" },
    expected: [{ virtualTool: "terminal", values: ["PWD=/tmp/work app -v"] }],
  },
  {
    case: "does not map a debug action that drives an existing session",
    tool: "xd://debug",
    input: { action: "continue" },
    expected: [],
  },
  {
    // The adapter's expression evaluator reaches `platform shell` in lldb.
    case: "maps a debug expression evaluation to terminal",
    tool: "xd://debug",
    input: { action: "evaluate", expression: "platform shell rm -rf ~/Documents" },
    expected: [{ virtualTool: "terminal", values: ["platform shell rm -rf ~/Documents"] }],
  },
  {
    case: "maps a debug custom_request to terminal",
    tool: "xd://debug",
    input: { action: "custom_request", command: "runInTerminal", arguments: { args: ["sh"] } },
    expected: [{ virtualTool: "terminal", values: ["runInTerminal"] }],
  },
  {
    case: "applies the terminal default when a debug evaluation has no expression",
    tool: "xd://debug",
    input: { action: "evaluate", frame_id: 1 },
    expected: [{ virtualTool: "terminal", values: [] }],
  },
  {
    // Writing into a live process is arbitrary mutation of what it does next.
    // Neither a base64 payload nor an address is text a rule could read.
    case: "maps a debug write_memory to terminal with no inputs",
    tool: "xd://debug",
    input: { action: "write_memory", memory_reference: "0x10a4c", data: "kZA=" },
    expected: [{ virtualTool: "terminal", values: [] }],
  },
  {
    case: "does not map a debug read_memory",
    tool: "xd://debug",
    input: { action: "read_memory", memory_reference: "0x10a4c", count: 16 },
    expected: [],
  },
  {
    // debugpy evaluates a breakpoint condition as Python on every hit.
    case: "maps a breakpoint condition to terminal",
    tool: "xd://debug",
    input: {
      action: "set_breakpoint",
      file: "app.py",
      line: 3,
      condition: "__import__('os').system('rm -rf ~/Documents')",
    },
    expected: [
      { virtualTool: "terminal", values: ["__import__('os').system('rm -rf ~/Documents')"] },
    ],
  },
  {
    case: "maps a data breakpoint's hit_condition to terminal",
    tool: "xd://debug",
    input: { action: "set_data_breakpoint", data_id: "d1", hit_condition: "system('id')" },
    expected: [{ virtualTool: "terminal", values: ["system('id')"] }],
  },
  {
    case: "does not map a breakpoint that carries no condition",
    tool: "xd://debug",
    input: { action: "set_breakpoint", file: "src/a.ts", line: 3 },
    expected: [],
  },
  {
    // Removing a breakpoint evaluates nothing, whatever it was created with.
    case: "does not map a breakpoint removal",
    tool: "xd://debug",
    input: { action: "remove_breakpoint", file: "src/a.ts", line: 3, condition: "i > 2" },
    expected: [],
  },
  {
    // `terminal.always_confirm: ["\\brm\\b"]` must never see this source text.
    case: "never matches a terminal pattern against eval source",
    tool: "eval",
    input: { language: "py", code: "rm_tree(path)" },
    expected: [{ virtualTool: "eval", values: [] }],
  },
  {
    // omp routes the `tool.<name>()` bridge through `tool_call`, so a call made
    // inside an eval cell reaches this mapping like any other.
    case: "still judges a bash call made from inside an eval cell",
    tool: "bash",
    input: { command: "sudo ls" },
    expected: [{ virtualTool: "terminal", values: ["sudo ls"] }],
  },
  {
    case: "gives browser its own virtual tool with no inputs",
    tool: "xd://browser",
    input: { action: "run", code: "await tab.click('x')" },
    expected: [{ virtualTool: "browser", values: [] }],
  },
  {
    // Disabled by default in omp, and completely ungated when it is on: `code`
    // drives real keyboard input into any window on the user's desktop.
    case: "gives computer its own virtual tool with no inputs",
    tool: "computer",
    input: { code: "await desktop.window({ app: 'Terminal' }).type('rm -rf ~\\n')" },
    expected: [{ virtualTool: "computer", values: [] }],
  },
  {
    // A read-only run still photographs every window on that desktop.
    case: "gates a read-only computer run too",
    tool: "computer",
    input: { code: "await desktop.screenshot()", read_only: true },
    expected: [{ virtualTool: "computer", values: [] }],
  },
  {
    case: "maps every item of a task batch to spawn_agent",
    tool: "task",
    input: {
      context: "shared",
      tasks: [{ agent: "scout", task: "read the config loader" }, { task: "write the loader" }],
    },
    expected: [
      {
        virtualTool: "spawn_agent",
        values: ["scout read the config loader", "task write the loader"],
      },
    ],
  },
  {
    case: "maps the flat task shape too",
    tool: "task",
    input: { agent: "sonic", task: "rename a symbol" },
    expected: [{ virtualTool: "spawn_agent", values: ["sonic rename a symbol"] }],
  },
  {
    case: "maps web_search to its query",
    tool: "web_search",
    input: { query: "zed tool permissions" },
    expected: [{ virtualTool: "web_search", values: ["zed tool permissions"] }],
  },
  {
    case: "maps an lsp rename to edit_file with no inputs",
    tool: "xd://lsp",
    input: { action: "rename", file: "src/a.ts", symbol: "foo", new_name: "bar" },
    expected: [{ virtualTool: "edit_file", values: [] }],
  },
  {
    case: "maps an lsp rename_file to edit_file with no inputs",
    tool: "xd://lsp",
    input: { action: "rename_file", file: "src/a.ts", new_name: "src/b.ts" },
    expected: [{ virtualTool: "edit_file", values: [] }],
  },
  {
    case: "maps lsp code_actions to edit_file with no inputs",
    tool: "xd://lsp",
    input: { action: "code_actions", file: "src/a.ts", apply: true },
    expected: [{ virtualTool: "edit_file", values: [] }],
  },
  {
    // A raw request may be `workspace/executeCommand`, whose `workspace/applyEdit`
    // response is applied to disk.
    case: "maps a raw lsp request to edit_file with no inputs",
    tool: "xd://lsp",
    input: { action: "request", query: "workspace/executeCommand", payload: "{}" },
    expected: [{ virtualTool: "edit_file", values: [] }],
  },
];

/**
 * hub operations that reach no process input, and lsp actions that write
 * nothing. `cancel` / `stop` / `restart` only address a process whose launch
 * line was judged at `start`. `diagnostics` stays here deliberately: the
 * language server compiles the project whether or not the call is gated.
 */
const READ_ONLY_OPS = [
  { tool: "hub", key: "op", value: "wait" },
  { tool: "hub", key: "op", value: "inbox" },
  { tool: "hub", key: "op", value: "list" },
  { tool: "hub", key: "op", value: "jobs" },
  { tool: "hub", key: "op", value: "cancel" },
  { tool: "hub", key: "op", value: "ps" },
  { tool: "hub", key: "op", value: "logs" },
  { tool: "hub", key: "op", value: "stop" },
  { tool: "hub", key: "op", value: "restart" },
  { tool: "hub", key: "op", value: "describe" },
  { tool: "xd://lsp", key: "action", value: "hover" },
  { tool: "xd://lsp", key: "action", value: "definition" },
  { tool: "xd://lsp", key: "action", value: "references" },
  { tool: "xd://lsp", key: "action", value: "diagnostics" },
  { tool: "xd://lsp", key: "action", value: "symbols" },
];

describe("mapToolCall: execution tools", () => {
  it.each(EXEC_CASES)("$case", expectMapping);

  it.each(READ_ONLY_OPS)("does not map $tool with $key $value", ({ tool, key, value }) => {
    expectMapping({ case: value, tool, input: { [key]: value }, expected: [] });
  });
});

// ---------------------------------------------------------------------------

const DEVICE_CASES: MapCase[] = [
  {
    case: "re-maps an ast_edit device dispatch under the device name",
    tool: "write",
    input: {
      path: "xd://ast_edit",
      content: '{"ops":[{"pat":"a","out":"b"}],"paths":["src/a.ts"]}',
    },
    expected: [{ virtualTool: "edit_file", values: ["src/a.ts"] }],
  },
  {
    case: "re-maps a built-in that is mounted as a device",
    tool: "write",
    input: { path: "xd://memory_edit", content: '{"op":"forget","id":"wm_7"}' },
    expected: [{ virtualTool: "delete_path", values: ["wm_7"] }],
  },
  {
    case: "passes the resolve device through without a warning",
    tool: "write",
    input: { path: "xd://resolve", content: "applying the preview" },
    expected: [],
  },
  {
    case: "passes the reject device through without a warning",
    tool: "write",
    input: { path: "xd://reject", content: "discarding the preview" },
    expected: [],
  },
  {
    case: "passes the report_issue device through without a warning",
    tool: "write",
    input: { path: "xd://report_issue", content: "read: wrong line range" },
    expected: [],
  },
  {
    case: "warns rather than silently gating an unknown device",
    tool: "write",
    input: { path: "xd://nope", content: "{}" },
    expected: [],
    warning: /xd:\/\/nope/,
  },
  {
    case: "warns when a device payload is not valid JSON",
    tool: "write",
    input: { path: "xd://ast_edit", content: "not json" },
    expected: [],
    warning: /xd:\/\/ast_edit/,
  },
];

describe("mapToolCall: tool devices dispatched through write", () => {
  it.each(DEVICE_CASES)("$case", expectMapping);
});

// ---------------------------------------------------------------------------

const MCP_CASES: MapCase[] = [
  {
    case: "keys the rule lookup on the canonical tool id",
    tool: "mcp__github__create_issue",
    input: { title: "Bug" },
    expected: [{ virtualTool: "mcp:github:create_issue", values: ["Bug"] }],
  },
  {
    case: "accepts the canonical tool id as the real tool name too",
    tool: "mcp:github:create_issue",
    input: { title: "Bug" },
    expected: [{ virtualTool: "mcp:github:create_issue", values: ["Bug"] }],
  },
  {
    case: "offers every nested string argument, in argument order",
    tool: "mcp__github__create_issue",
    input: {
      title: "Bug",
      labels: ["p1", "bug"],
      meta: { repo: "acme/app", count: 3 },
      draft: true,
    },
    expected: [
      { virtualTool: "mcp:github:create_issue", values: ["Bug", "p1", "bug", "acme/app"] },
    ],
  },
  {
    case: "applies only the default when no argument is a string",
    tool: "mcp__time__now",
    input: { unix: true },
    expected: [{ virtualTool: "mcp:time:now", values: [] }],
  },
];

describe("mapToolCall: MCP tools", () => {
  it.each(MCP_CASES)("$case", expectMapping);
});

// ---------------------------------------------------------------------------

/** Tools with no side effect to gate. Passing through must stay silent. */
const PASS_THROUGH_TOOLS = ["todo", "ask", "checkpoint", "rewind", "xd://resolve", "yield"];

const UNMAPPED_CASES: MapCase[] = [
  {
    case: "passes an unknown tool name through without a warning",
    tool: "some_plugin_tool",
    input: { path: "/etc/hosts" },
    expected: [],
  },
  // A major tool whose arguments are not understood still gets a decision:
  // `calls: []` here would be an implicit allow.
  {
    case: "applies the write_file default and warns when write has no path",
    tool: "write",
    input: { content: "..." },
    expected: [{ virtualTool: "write_file", values: [] }],
    warning: /^write was called without a string "path"/,
  },
  {
    case: "applies the read_file default and warns when read has no path",
    tool: "read",
    input: {},
    expected: [{ virtualTool: "read_file", values: [] }],
    warning: /^read was called without a string "path"/,
  },
  {
    case: "applies the edit_file default and warns when edit has no input",
    tool: "edit",
    input: { patch: "..." },
    expected: [{ virtualTool: "edit_file", values: [] }],
    warning: /^edit was called without a string "input"/,
  },
  {
    case: "applies the terminal default and warns when bash has no command",
    tool: "bash",
    input: { cmd: "ls" },
    expected: [{ virtualTool: "terminal", values: [] }],
    warning: /^bash was called without a string "command"/,
  },
  // A lesser tool gets the same default-only decision, but no notification.
  {
    case: "applies the grep default without warning for unexpected arguments",
    tool: "grep",
    input: { unexpected: 1 },
    expected: [{ virtualTool: "grep", values: [] }],
  },
  {
    case: "applies the edit_file default without warning for a bare ast_edit",
    tool: "xd://ast_edit",
    input: { ops: [{ pat: "a", out: "b" }] },
    expected: [{ virtualTool: "edit_file", values: [] }],
  },
  {
    case: "applies the spawn_agent default without warning for a bare task",
    tool: "task",
    input: { context: "shared", tasks: [] },
    expected: [{ virtualTool: "spawn_agent", values: [] }],
  },
  {
    case: "applies the write_file default without warning for a nameless skill",
    tool: "manage_skill",
    input: { action: "create" },
    expected: [{ virtualTool: "write_file", values: [] }],
  },
  {
    case: "keeps the glob default target when the arguments are unexpected",
    tool: "glob",
    input: { unexpected: 1 },
    expected: [{ virtualTool: "find_path", values: ["."] }],
  },
  {
    case: "survives a bash input that is not an object",
    tool: "bash",
    input: "sudo ls",
    expected: [{ virtualTool: "terminal", values: [] }],
    warning: /^bash was called without a string "command"/,
  },
  {
    case: "survives an eval input that is not an object",
    tool: "eval",
    input: null,
    expected: [{ virtualTool: "eval", values: [] }],
  },
];

describe("mapToolCall: unmapped calls", () => {
  it.each(PASS_THROUGH_TOOLS.map((tool) => ({ tool })))(
    "passes the side-effect-free tool $tool straight through",
    ({ tool }) => {
      expectMapping({ case: tool, tool, input: { anything: "here" }, expected: [] });
    },
  );

  it.each(UNMAPPED_CASES)("$case", expectMapping);
});

// ---------------------------------------------------------------------------

interface ScopeCase {
  readonly case: string;
  readonly tool: string;
  readonly input: unknown;
  /** One entry per decision input, in order. */
  readonly scopes: readonly (PathScope | undefined)[];
}

const SCOPE_CASES: ScopeCase[] = [
  {
    case: "a path inside the project",
    tool: "write",
    input: { path: "src/a.ts", content: "..." },
    scopes: ["inside"],
  },
  {
    case: "a path outside the project",
    tool: "write",
    input: { path: "/tmp/x.txt", content: "..." },
    scopes: ["outside"],
  },
  {
    case: "a fetched URL, which no scope rule may claim",
    tool: "read",
    input: { path: "https://example.com/a.json" },
    scopes: [undefined],
  },
  {
    case: "a memory id, which is not a path",
    tool: "memory_edit",
    input: { op: "forget", id: "wm_42" },
    scopes: [undefined],
  },
  {
    case: "an MCP argument, which is not a path",
    tool: "mcp__github__create_issue",
    input: { title: "Bug" },
    scopes: [undefined],
  },
  {
    case: "a move, whose source and destination are both paths",
    tool: "edit",
    input: { input: "[src/a.ts#1A2B]\nMV /tmp/a.ts" },
    scopes: ["inside", "outside"],
  },
  {
    // The command string carries no scope; the file it redirects into does, so a
    // `{"scope": "outside"}` rule can claim the target without claiming the
    // command.
    case: "a redirect target, which is a path while the command is not",
    tool: "bash",
    input: { command: "printf x >> ~/.ssh/authorized_keys" },
    scopes: [undefined, "outside"],
  },
  {
    // A remote or store-backed resource is not a project path, so an `inside`
    // rule must not claim it and an `outside` one must.
    case: "a write to a remote path, which is outside by construction",
    tool: "write",
    input: { path: "ssh://host/etc/passwd", content: "..." },
    scopes: ["outside"],
  },
];

describe("mapToolCall: decision input metadata", () => {
  it.each(SCOPE_CASES)("reports the scope of $case", ({ tool, input, scopes }) => {
    const result = mapToolCall(tool, input, resolve);
    expect(result.calls.flatMap((call) => call.inputs.map((entry) => entry.scope))).toStrictEqual(
      scopes,
    );
  });

  it("carries the resolver's verdicts and both absolute paths through", () => {
    // A repository with `config -> ~/.ssh` committed in it.
    const escaping: PathResolver = (raw) => ({
      path: `config/${raw}`,
      scope: "inside",
      escaped: true,
      literal: `/repo/config/${raw}`,
      resolved: `/home/u/.ssh/${raw}`,
      selector: undefined,
      unexpanded: false,
    });
    const [call] = mapToolCall("write", { path: "id_rsa", content: "x" }, escaping).calls;
    expect(call?.inputs).toStrictEqual([
      {
        value: "config/id_rsa",
        scope: "inside",
        escaped: true,
        unexpanded: false,
        literal: "/repo/config/id_rsa",
        resolved: "/home/u/.ssh/id_rsa",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------

const RELOCATED_SKILL = "/opt/omp-agent/managed-skills/my-skill/SKILL.md";

describe("mapToolCall: managed skill location", () => {
  it("follows PI_CODING_AGENT_DIR, the variable that relocates the agent dir", () => {
    const before = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = "/opt/omp-agent";
    try {
      expectMapping({
        case: "manage_skill",
        tool: "manage_skill",
        input: { action: "create", name: "my-skill", description: "d", body: "b" },
        expected: [{ virtualTool: "write_file", values: [RELOCATED_SKILL] }],
      });
      expectMapping({
        case: "learn",
        tool: "learn",
        input: { memory: "a lesson", skill: { action: "update", name: "my-skill" } },
        expected: [{ virtualTool: "write_file", values: [RELOCATED_SKILL] }],
      });
    } finally {
      if (before === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = before;
    }
  });
});
