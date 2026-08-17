import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { afterAll, describe, expect, it } from "vitest";
import {
  appendAlwaysAllow,
  buildBlockReason,
  candidatePatterns,
  describeCause,
  planApproval,
} from "../src/prompt.ts";
import type { Decision, DecisionCause, DecisionInput } from "../src/types.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "toolgate-prompt-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PATHS = {
  globalPath: "/home/me/.omp/agent/tool-permissions.json",
  projectPath: "/repo/.omp/tool-permissions.json",
};

function decisionOf(overrides: {
  mode?: Decision["mode"];
  virtualTool?: string;
  cause?: DecisionCause;
  inputs?: readonly DecisionInput[];
}): Decision {
  return {
    mode: overrides.mode ?? "confirm",
    virtualTool: overrides.virtualTool ?? "write_file",
    reason: "test",
    cause: overrides.cause ?? { kind: "default" },
    inputs: overrides.inputs ?? [{ value: "src/a.ts", scope: "inside" }],
  };
}

describe("candidatePatterns", () => {
  it.each([
    {
      what: "anchors a command and its sub-command",
      tool: "terminal",
      inputs: [{ value: "cargo test --release" }],
      expected: ["^cargo\\s+test(\\s|$)"],
    },
    {
      // A terminal decision arrives already split, one input per sub-command.
      what: "covers every sub-command of a pipeline",
      tool: "terminal",
      inputs: [{ value: "cargo test 2>&1" }, { value: "tail" }],
      expected: ["^cargo\\s+test(\\s|$)", "^tail\\b"],
    },
    {
      what: "treats a flag as no sub-command",
      tool: "terminal",
      inputs: [{ value: "ls -la" }],
      expected: ["^ls\\b"],
    },
    {
      what: "refuses a relative path-derived executable",
      tool: "terminal",
      inputs: [{ value: "./deploy.sh --prod" }],
      expected: [],
    },
    {
      what: "refuses an absolute path-derived executable",
      tool: "terminal",
      inputs: [{ value: "/usr/local/bin/deploy" }],
      expected: [],
    },
    {
      // `^cargo…` would never match "PAGER=x cargo test", so no candidate is honest.
      what: "refuses an assignment-prefixed command",
      tool: "terminal",
      inputs: [{ value: "PAGER=x cargo test" }],
      expected: [],
    },
    {
      what: "refuses a redirection pseudo sub-command",
      tool: "terminal",
      inputs: [{ value: "> /etc/passwd" }],
      expected: [],
    },
    {
      what: "offers a directory and an extension for a path",
      tool: "write_file",
      inputs: [{ value: "src/generated/api.ts", scope: "inside" as const }],
      expected: ["^src/generated/", "\\.ts$"],
    },
    {
      what: "skips the directory candidate at the project root level",
      tool: "write_file",
      inputs: [{ value: ".env", scope: "inside" as const }],
      expected: [],
    },
    {
      what: "offers nothing for a code-carrying tool",
      tool: "eval",
      inputs: [],
      expected: [],
    },
    {
      what: "offers nothing for a URL tool",
      tool: "fetch",
      inputs: [{ value: "https://example.com/a" }],
      expected: [],
    },
  ])("$what", ({ tool, inputs, expected }) => {
    expect(candidatePatterns(tool, inputs)).toEqual(expected);
  });
});

describe("planApproval", () => {
  it("lists allow-once, project, global and deny in that order", () => {
    const plan = planApproval(
      decisionOf({ inputs: [{ value: "src/generated/api.ts", scope: "inside" }] }),
      PATHS,
    );
    expect(plan.choices.map((choice) => choice.kind)).toEqual([
      "once",
      "project",
      "project",
      "global",
      "global",
      "deny",
    ]);
    expect(plan.choices[1]?.file).toBe(PATHS.projectPath);
    expect(plan.choices[3]?.file).toBe(PATHS.globalPath);
    expect(plan.body).toMatch(/confirm write_file/);
    expect(plan.body).toMatch(/src\/generated\/api\.ts \[inside\]/);
  });

  const escapedInput: DecisionInput = {
    value: "/home/me/.ssh/id_rsa",
    scope: "outside",
    escaped: true,
    literal: "/repo/config/id_rsa",
    resolved: "/home/me/.ssh/id_rsa",
  };

  it("shows the literal path and the realpath target for a symlink escape", () => {
    const plan = planApproval(
      decisionOf({ cause: { kind: "escape" }, inputs: [escapedInput] }),
      PATHS,
    );
    expect(plan.body).toMatch(/literal:\s+\/repo\/config\/id_rsa/);
    expect(plan.body).toMatch(/realpath:\s+\/home\/me\/\.ssh\/id_rsa/);
    expect(plan.body).toMatch(/symlink escape/);
  });

  it("offers only allow-once and deny for a symlink escape", () => {
    const plan = planApproval(
      decisionOf({ cause: { kind: "escape" }, inputs: [escapedInput] }),
      PATHS,
    );
    expect(plan.choices.map((choice) => choice.kind)).toEqual(["once", "deny"]);
    expect(plan.notes.join("\n")).toMatch(/allowed once/);
  });

  it.each([
    {
      // always_allow is evaluated after always_confirm, so recording a pattern
      // the same rule covers would bring the identical prompt straight back.
      what: "withholds both always-allow targets when a global confirm rule decided",
      cause: {
        kind: "rule" as const,
        list: "always_confirm" as const,
        origin: "global" as const,
        pattern: "(^|/)\\.env$",
        input: "config/.env",
      },
      inputs: [{ value: "config/.env", scope: "inside" as const }],
      hasProject: false,
      hasGlobal: false,
      note: new RegExp(PATHS.globalPath.replace(/[.]/g, "\\.")),
    },
    {
      what: "withholds both always-allow targets when a project confirm rule decided",
      cause: {
        kind: "rule" as const,
        list: "always_confirm" as const,
        origin: "project" as const,
        pattern: "^src/generated/",
        input: "src/generated/api.ts",
      },
      inputs: [{ value: "src/generated/api.ts", scope: "inside" as const }],
      hasProject: false,
      hasGlobal: false,
      note: new RegExp(PATHS.projectPath.replace(/[.]/g, "\\.")),
    },
    {
      what: "offers both always-allow targets when only a default decided",
      cause: { kind: "default" as const },
      inputs: [{ value: "src/generated/api.ts", scope: "inside" as const }],
      hasProject: true,
      hasGlobal: true,
      note: undefined,
    },
    {
      what: "withholds the project target for an absolute pattern",
      cause: { kind: "default" as const },
      inputs: [{ value: "/etc/hosts", scope: "outside" as const }],
      hasProject: false,
      hasGlobal: true,
      note: /outside the project root/,
    },
  ])("$what", ({ cause, inputs, hasProject, hasGlobal, note }) => {
    const plan = planApproval(decisionOf({ cause, inputs }), PATHS);
    expect(plan.choices.some((choice) => choice.kind === "project")).toBe(hasProject);
    expect(plan.choices.some((choice) => choice.kind === "global")).toBe(hasGlobal);
    if (note !== undefined) expect(plan.notes.join("\n")).toMatch(note);
  });

  it("explains that a tool with no derivable pattern can only be allowed once", () => {
    const plan = planApproval(decisionOf({ virtualTool: "eval", inputs: [] }), PATHS);
    expect(plan.choices.map((choice) => choice.kind)).toEqual(["once", "deny"]);
    expect(plan.notes.join("\n")).toMatch(/No safe pattern/);
  });
});

describe("buildBlockReason", () => {
  const denied = decisionOf({
    mode: "deny",
    virtualTool: "write_file",
    cause: {
      kind: "rule",
      list: "always_deny",
      origin: "global",
      pattern: "(^|/)\\.(ssh|aws)(/|$)",
      input: "/home/me/.ssh/id_rsa",
    },
    inputs: [{ value: "/home/me/.ssh/id_rsa", scope: "outside" }],
  });

  it.each([
    { kind: "deny" as const, expected: /denied write_file/ },
    { kind: "user-denied" as const, expected: /the user denied it/ },
    { kind: "no-ui" as const, expected: /no interactive UI/ },
  ])("names the situation for $kind", ({ kind, expected }) => {
    expect(buildBlockReason(denied, kind, PATHS.globalPath)).toMatch(expected);
  });

  it("carries the target, the matching pattern, the origin and the config path", () => {
    const reason = buildBlockReason(denied, "deny", PATHS.globalPath);
    expect(reason).toContain("/home/me/.ssh/id_rsa");
    expect(reason).toContain("always_deny");
    expect(reason).toContain("(^|/)\\.(ssh|aws)(/|$)");
    expect(reason).toContain("global configuration");
    expect(reason).toContain(PATHS.globalPath);
  });

  it("tells a UI-less session that the parent must approve", () => {
    const reason = buildBlockReason(denied, "no-ui", PATHS.globalPath);
    expect(reason).toMatch(/parent interactive session/);
    expect(reason).toMatch(/do not retry/);
  });
});

describe("appendAlwaysAllow", () => {
  it("creates the directory and a minimal document", () => {
    const file = path.join(makeRoot(), "project", ".omp", "tool-permissions.json");
    expect(appendAlwaysAllow(file, "write_file", "^src/generated/", JSON5.parse)).toBe(
      "written",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      tools: { write_file: { always_allow: [{ pattern: "^src/generated/" }] } },
    });
  });

  it("appends inside an existing nested Zed document without relocating it", () => {
    const file = path.join(makeRoot(), "tool-permissions.json");
    writeFileSync(
      file,
      `{
  // a Zed settings.json dropped in verbatim
  "agent": {
    "tool_permissions": {
      "default": "confirm",
      "tools": { "terminal": { "always_allow": [{ "pattern": "^ls\\\\b" }] } },
    },
  },
  "dock": "left",
}
`,
    );
    expect(appendAlwaysAllow(file, "terminal", "^cargo\\s+test(\\s|$)", JSON5.parse)).toBe(
      "written",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      agent: {
        tool_permissions: {
          default: "confirm",
          tools: {
            terminal: {
              always_allow: [{ pattern: "^ls\\b" }, { pattern: "^cargo\\s+test(\\s|$)" }],
            },
          },
        },
      },
      dock: "left",
    });
  });

  it.each([
    {
      shape: "bare string",
      content: '{"tools":{"terminal":{"always_allow":["^ls\\\\b"]}}}',
    },
    {
      shape: "rule object",
      content: '{"tools":{"terminal":{"always_allow":[{"pattern":"^ls\\\\b"}]}}}',
    },
  ])("does not append a duplicate written as a $shape", ({ content }) => {
    const file = path.join(makeRoot(), "tool-permissions.json");
    writeFileSync(file, content);
    expect(appendAlwaysAllow(file, "terminal", "^ls\\b", JSON5.parse)).toBe("duplicate");
    expect(readFileSync(file, "utf8")).toBe(content);
  });

  it("reuses an existing key that canonicalizes to the same tool", () => {
    const file = path.join(makeRoot(), "tool-permissions.json");
    writeFileSync(file, '{"tools":{"mcp__github__create_issue":{"default":"confirm"}}}');
    appendAlwaysAllow(file, "mcp:github:create_issue", "^x", JSON5.parse);
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      tools: Record<string, unknown>;
    };
    expect(Object.keys(written.tools)).toEqual(["mcp__github__create_issue"]);
  });

  it("leaves no temporary file behind", () => {
    const root = makeRoot();
    appendAlwaysAllow(path.join(root, "tool-permissions.json"), "terminal", "^ls\\b", JSON5.parse);
    expect(readdirSync(root)).toEqual(["tool-permissions.json"]);
  });

  it("refuses to overwrite a file it cannot parse", () => {
    const file = path.join(makeRoot(), "tool-permissions.json");
    writeFileSync(file, "{ this is not json");
    expect(() => appendAlwaysAllow(file, "terminal", "^ls\\b", JSON5.parse)).toThrow(
      /not valid JSONC/,
    );
    expect(readFileSync(file, "utf8")).toBe("{ this is not json");
  });

  it("keeps the existing file mode", () => {
    const root = makeRoot();
    mkdirSync(path.join(root, "nested"));
    const file = path.join(root, "nested", "tool-permissions.json");
    writeFileSync(file, "{}", { mode: 0o600 });
    appendAlwaysAllow(file, "terminal", "^ls\\b", JSON5.parse);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("describeCause", () => {
  it.each([
    {
      what: "a pattern rule",
      cause: {
        kind: "rule" as const,
        list: "always_deny" as const,
        origin: "global" as const,
        pattern: "\\bsudo\\b",
        scope: "any" as const,
      },
      expected: "always_deny /\\bsudo\\b/ from global configuration",
    },
    {
      // A scope-only rule has no pattern; printing `//` would hide the condition.
      what: "a scope-only rule",
      cause: {
        kind: "rule" as const,
        list: "always_confirm" as const,
        origin: "global" as const,
        pattern: "",
        scope: "outside" as const,
      },
      expected: "always_confirm scope outside from global configuration",
    },
    {
      what: "a pattern rule narrowed by scope",
      cause: {
        kind: "rule" as const,
        list: "always_confirm" as const,
        origin: "project" as const,
        pattern: "^\\.env",
        scope: "inside" as const,
      },
      expected: "always_confirm /^\\.env/ with scope inside from project configuration",
    },
    {
      what: "an escape promotion",
      cause: { kind: "escape" as const },
      expected: "symlink escape out of the project root (cannot be disabled by configuration)",
    },
    {
      what: "an uncompilable pattern",
      cause: { kind: "invalid-pattern" as const },
      expected: "a pattern in the configuration failed to compile",
    },
    {
      what: "a default",
      cause: { kind: "default" as const },
      expected: "no rule matched, so the configured default applied",
    },
  ])("describes $what", ({ cause, expected }) => {
    expect(describeCause(decisionOf({ cause }))).toBe(expected);
  });
});
