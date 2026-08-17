import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import JSON5 from "json5";

import {
  digPermissionsContainer,
  discoverConfigPaths,
  loadPermissions,
  PROJECT_PATTERN_LENGTH_LIMIT,
  PROJECT_PATTERN_LIMIT,
} from "../src/config.ts";
import type { LoadedPermissions } from "../src/config.ts";
import type { ToolRules } from "../src/types.ts";

/**
 * One real directory tree for the whole file, with one workspace per case.
 *
 * `realpathSync` is applied because macOS resolves `/var` to `/private/var`;
 * `trustedProjects` compares resolved paths, so the fixtures must be canonical
 * for an exact-path entry to mean what it looks like it means.
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), "toolgate-config-")));
let workspaceCount = 0;

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

interface Workspace {
  readonly projectRoot: string;
  readonly env: NodeJS.ProcessEnv;
  readonly globalPath: string;
  readonly projectPath: string;
}

/** File content: raw JSONC text, or a value to be stringified. */
type Content = string | Record<string, unknown>;

interface Fixture {
  readonly global?: Content;
  readonly project?: Content;
}

/** A fresh home directory and project root, with the requested files written. */
function createWorkspace(name: string, fixture: Fixture): Workspace {
  workspaceCount += 1;
  const root = join(base, `${workspaceCount}-${name}`);
  const home = join(root, "home");
  const projectRoot = join(root, "work", "repo");
  const workspace: Workspace = {
    projectRoot,
    env: { HOME: home },
    globalPath: join(home, ".omp", "agent", "tool-permissions.json"),
    projectPath: join(projectRoot, ".omp", "tool-permissions.json"),
  };
  mkdirSync(projectRoot, { recursive: true });
  if (fixture.global !== undefined) writeConfig(workspace.globalPath, fixture.global);
  if (fixture.project !== undefined) writeConfig(workspace.projectPath, fixture.project);
  return workspace;
}

function writeConfig(file: string, content: Content): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, undefined, 2));
}

function load(workspace: Workspace): LoadedPermissions {
  return loadPermissions(workspace.projectRoot, workspace.env, JSON5.parse);
}

/** Most cases need nothing from the workspace but the loaded result. */
function loadFixture(name: string, fixture: Fixture): LoadedPermissions {
  return load(createWorkspace(name, fixture));
}

function rulesFor(loaded: LoadedPermissions, tool: string): ToolRules {
  const permissions = loaded.permissions;
  if (permissions === undefined) throw new Error("expected a permission set, found none");
  const rules = permissions.tools[tool];
  if (rules === undefined) {
    const found = JSON.stringify(Object.keys(permissions.tools));
    throw new Error(`expected rules for "${tool}", found ${found}`);
  }
  return rules;
}

function warningMatching(loaded: LoadedPermissions, needle: RegExp): string {
  const found = loaded.warnings.find((warning) => needle.test(warning));
  if (found === undefined) {
    throw new Error(`no warning matched ${needle} in ${JSON.stringify(loaded.warnings)}`);
  }
  return found;
}

/** `count` distinct patterns, for the project-side limits. */
function manyRules(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `^generated-${index}/`);
}

interface GlobalPathCase {
  readonly label: string;
  readonly env: NodeJS.ProcessEnv;
  readonly expected: string;
}

const globalPathCases: readonly GlobalPathCase[] = [
  {
    label: "HOME",
    env: { HOME: "/home/me" },
    expected: join("/home/me", ".omp", "agent", "tool-permissions.json"),
  },
  {
    label: "the operating system home directory when HOME is unset",
    env: {},
    expected: join(homedir(), ".omp", "agent", "tool-permissions.json"),
  },
  {
    label: "PI_CODING_AGENT_DIR",
    env: { HOME: "/home/me", PI_CODING_AGENT_DIR: "/tmp/alt" },
    expected: join("/tmp/alt", "tool-permissions.json"),
  },
  {
    label: "HOME again when PI_CODING_AGENT_DIR is empty",
    env: { HOME: "/home/me", PI_CODING_AGENT_DIR: "" },
    expected: join("/home/me", ".omp", "agent", "tool-permissions.json"),
  },
];

describe("discoverConfigPaths", () => {
  it.each(globalPathCases)("takes the global file from $label", ({ env, expected }) => {
    expect(discoverConfigPaths("/work/repo", env).globalPath).toBe(expected);
  });

  it("reports the project file path even when the file does not exist", () => {
    const paths = discoverConfigPaths("/work/repo", { HOME: "/home/me" });

    expect(paths.projectPath).toBe(join("/work/repo", ".omp", "tool-permissions.json"));
  });

  it("reads the project file of the resolved root, not of a nested directory", () => {
    // A nested `.omp/` is what omp's cwd-only convention leaves behind; the gate
    // must read the resolved root and ignore those, wherever the session started.
    const workspace = createWorkspace("nested", {
      project: { tools: { write_file: { always_deny: ["^root-rule$"] } } },
    });
    const nested = join(workspace.projectRoot, "packages", "foo");
    mkdirSync(join(nested, "src"), { recursive: true });
    writeConfig(join(nested, ".omp", "tool-permissions.json"), {
      tools: { write_file: { always_allow: ["^nested-rule$"] } },
    });

    const loaded = load(workspace);

    expect(loaded.loaded).toEqual({ global: false, project: true });
    expect(rulesFor(loaded, "write_file").always_deny.map((rule) => rule.source)).toEqual([
      "^root-rule$",
    ]);
    expect(rulesFor(loaded, "write_file").always_allow).toEqual([]);
  });
});

describe("no configuration file", () => {
  it("disables the gate entirely", () => {
    const workspace = createWorkspace("absent", {});

    const loaded = load(workspace);

    expect(loaded.permissions).toBeUndefined();
    expect(loaded.warnings).toEqual([]);
    expect(loaded.loaded).toEqual({ global: false, project: false });
    expect(loaded.globalRaw).toBeUndefined();
    expect(loaded.projectRaw).toBeUndefined();
    expect(loaded.trusted).toBe(false);
    expect(loaded.globalPath).toBe(workspace.globalPath);
    expect(loaded.projectPath).toBe(workspace.projectPath);
  });
});

describe("accepted shapes", () => {
  it.each([
    {
      label: "agent.tool_permissions of a whole Zed settings.json",
      document: {
        agent: {
          tool_permissions: {
            default: "allow",
            tools: { write_file: { always_confirm: ["(^|/)\\.env$"] } },
          },
          play_sound_when_agent_done: true,
        },
        dock: "left",
      },
      expectedDefault: "allow",
      expectedTools: ["write_file"],
    },
    {
      label: "a root-level tool_permissions block",
      document: { tool_permissions: { default: "deny" }, unrelated: 1 },
      expectedDefault: "deny",
      expectedTools: [],
    },
    {
      label: "the root object itself",
      document: { default: "deny" },
      expectedDefault: "deny",
      expectedTools: [],
    },
    {
      label: "a document that mentions no permission key at all",
      document: { dock: "left" },
      expectedDefault: "confirm",
      expectedTools: [],
    },
  ])("adopts $label", ({ document, expectedDefault, expectedTools }) => {
    const loaded = loadFixture("shape", { global: document });

    expect(loaded.warnings).toEqual([]);
    expect(loaded.permissions?.default).toBe(expectedDefault);
    expect(Object.keys(loaded.permissions?.tools ?? {})).toEqual(expectedTools);
  });

  it("keeps the rules of a nested Zed block and ignores everything around it", () => {
    const loaded = loadFixture("zed-detail", {
      global: {
        agent: {
          tool_permissions: { tools: { write_file: { always_confirm: ["(^|/)\\.env$"] } } },
        },
        dock: "left",
      },
    });

    expect(rulesFor(loaded, "write_file").always_confirm.map((rule) => rule.source)).toEqual([
      "(^|/)\\.env$",
    ]);
    expect(loaded.globalRaw?.default).toBeUndefined();
    expect(Object.keys(loaded.globalRaw?.tools ?? {})).toEqual(["write_file"]);
  });

  it("accepts comments and trailing commas", () => {
    const loaded = loadFixture("jsonc", {
      global: `{
        // Everything needs a decision unless a rule says otherwise.
        "default": "confirm",
        /* Zed writes patterns exactly like this. */
        "tools": {
          "terminal": { "always_deny": ["\\\\brm\\\\b",], },
        },
      }`,
    });

    expect(loaded.warnings).toEqual([]);
    expect(loaded.permissions?.default).toBe("confirm");
    expect(rulesFor(loaded, "terminal").always_deny.map((rule) => rule.source)).toEqual([
      "\\brm\\b",
    ]);
  });

  it("discards only the file it cannot parse", () => {
    const workspace = createWorkspace("unparseable", {
      global: '{"default": "deny", oops',
      project: { tools: { terminal: { always_confirm: ["^ls"] } } },
    });

    const loaded = load(workspace);

    expect(loaded.loaded).toEqual({ global: true, project: true });
    expect(loaded.globalRaw).toBeUndefined();
    expect(warningMatching(loaded, /could not be parsed/)).toContain(workspace.globalPath);
    // The surviving file still applies, and the discarded default falls back.
    expect(loaded.permissions?.default).toBe("confirm");
    expect(rulesFor(loaded, "terminal").always_confirm.map((rule) => rule.source)).toEqual(["^ls"]);
  });

  it("discards a document that is not an object but stays enabled", () => {
    const workspace = createWorkspace("not-an-object", { global: "[1, 2, 3]" });

    const loaded = load(workspace);

    expect(loaded.globalRaw).toBeUndefined();
    expect(warningMatching(loaded, /does not contain a JSON object/)).toContain(
      workspace.globalPath,
    );
    expect(loaded.loaded.global).toBe(true);
    expect(loaded.permissions?.default).toBe("confirm");
  });

  it.each([
    { label: "default", key: "default", value: "deny", expected: "deny", warns: false },
    { label: "the default_mode alias", key: "default_mode", value: "deny", expected: "deny", warns: false },
    { label: "an unknown mode", key: "default", value: "ask", expected: "confirm", warns: true },
  ])("reads the top-level mode from $label", ({ key, value, expected, warns }) => {
    const loaded = loadFixture("top-mode", { global: { [key]: value } });

    expect(loaded.permissions?.default).toBe(expected);
    if (warns) {
      expect(warningMatching(loaded, /not one of allow\/confirm\/deny/)).toContain('"default"');
    } else {
      expect(loaded.warnings).toEqual([]);
    }
  });

  it("accepts default_mode on a tool as well", () => {
    const loaded = loadFixture("tool-alias", {
      global: { tools: { terminal: { default_mode: "allow" } } },
    });

    expect(rulesFor(loaded, "terminal").default).toBe("allow");
  });

  it.each([
    { label: "tools is not an object", document: { tools: 5 }, needle: /"tools" is not an object/ },
    {
      label: "a tool entry is not an object",
      document: { tools: { terminal: 5 } },
      needle: /"tools\.terminal" is not an object/,
    },
    {
      label: "a rule list is not an array",
      document: { tools: { terminal: { always_deny: "rm" } } },
      needle: /"tools\.terminal\.always_deny" is not an array/,
    },
    {
      label: "a rule is neither a string nor an object",
      document: { tools: { terminal: { always_deny: [5] } } },
      needle: /neither a string nor an object/,
    },
    {
      label: "a pattern is not a string",
      document: { tools: { terminal: { always_deny: [{ pattern: 5 }] } } },
      needle: /\.pattern" is not a string/,
    },
    {
      label: "case_sensitive is not a boolean",
      document: { tools: { terminal: { always_deny: [{ pattern: "^ls", case_sensitive: "yes" }] } } },
      needle: /case_sensitive" is not a boolean/,
    },
    {
      label: "trustedProjects is not an array",
      document: { trustedProjects: "/work/repo" },
      needle: /"trustedProjects" is not an array/,
    },
  ])("warns when $label", ({ document, needle }) => {
    const loaded = loadFixture("malformed", { global: document });

    expect(loaded.warnings).toEqual(expect.arrayContaining([expect.stringMatching(needle)]));
  });

  it("does not let a __proto__ tool key corrupt the permission set", () => {
    // A committed project file is third-party input, so a key that JavaScript
    // treats specially must stay an ordinary tool name.
    const loaded = loadFixture("proto-key", {
      global: '{"tools": {"__proto__": {"default": "allow"}, "terminal": {"default": "deny"}}}',
    });

    expect(rulesFor(loaded, "terminal").default).toBe("deny");
    const tools = loaded.permissions?.tools;
    expect(Object.getPrototypeOf(tools)).toBe(Object.prototype);
    expect(tools?.["always_deny"]).toBeUndefined();
  });
});

describe("digPermissionsContainer", () => {
  it("returns the live nested object of a Zed document", () => {
    const doc = JSON5.parse('{"agent":{"tool_permissions":{"default":"allow"}},"dock":"left"}') as Record<
      string,
      unknown
    >;
    const agent = doc["agent"] as Record<string, unknown>;

    const container = digPermissionsContainer(doc);

    expect(container).toBe(agent["tool_permissions"]);
    if (container === undefined) throw new Error("expected a container");
    // A write-back mutates the document in place through this reference.
    container["tools"] = { terminal: {} };
    expect(agent["tool_permissions"]).toEqual({ default: "allow", tools: { terminal: {} } });
  });

  it("prefers the location that already carries permission keys", () => {
    const doc = { agent: { tool_permissions: { typo: 1 } }, tools: { terminal: {} } };

    expect(digPermissionsContainer(doc)).toBe(doc);
  });

  it("returns an empty document itself, so a write-back has somewhere to go", () => {
    const doc = {};

    expect(digPermissionsContainer(doc)).toBe(doc);
  });

  it("returns the innermost empty object of a Zed document", () => {
    const doc = { agent: { tool_permissions: {} } };

    expect(digPermissionsContainer(doc)).toBe(doc.agent.tool_permissions);
  });

  it.each([{ doc: "nope" }, { doc: [1, 2] }, { doc: null }, { doc: 7 }])(
    "returns undefined for $doc",
    ({ doc }) => {
      expect(digPermissionsContainer(doc)).toBeUndefined();
    },
  );
});

describe("rule compilation", () => {
  it.each([
    {
      label: "a bare string as a pattern with any scope",
      rule: "^\\.env",
      expectedSource: "^\\.env",
      expectedFlags: "i",
      expectedScope: "any",
    },
    {
      label: "an object rule case-insensitively by default",
      rule: { pattern: "SECRET" },
      expectedSource: "SECRET",
      expectedFlags: "i",
      expectedScope: "any",
    },
    {
      label: "case_sensitive as no flags",
      rule: { pattern: "SECRET", case_sensitive: true },
      expectedSource: "SECRET",
      expectedFlags: "",
      expectedScope: "any",
    },
    {
      label: "a scope-only rule without a regex",
      rule: { scope: "outside" },
      expectedSource: "",
      expectedFlags: undefined,
      expectedScope: "outside",
    },
    {
      label: "an empty pattern with a scope as scope-only",
      rule: { pattern: "", scope: "inside" },
      expectedSource: "",
      expectedFlags: undefined,
      expectedScope: "inside",
    },
    {
      label: "a pattern and a scope together",
      rule: { pattern: "^\\.env", scope: "inside" },
      expectedSource: "^\\.env",
      expectedFlags: "i",
      expectedScope: "inside",
    },
  ])("compiles $label", ({ rule, expectedSource, expectedFlags, expectedScope }) => {
    const loaded = loadFixture("compile", {
      global: { tools: { write_file: { always_confirm: [rule] } } },
    });

    const compiled = rulesFor(loaded, "write_file").always_confirm[0];
    expect(compiled?.source).toBe(expectedSource);
    expect(compiled?.regex?.flags).toBe(expectedFlags);
    expect(compiled?.scope).toBe(expectedScope);
    expect(compiled?.origin).toBe("global");
  });

  it("honours case sensitivity when matching", () => {
    const loaded = loadFixture("case-matching", {
      global: {
        tools: {
          write_file: {
            always_deny: [{ pattern: "SECRET" }, { pattern: "SECRET", case_sensitive: true }],
          },
        },
      },
    });

    const [insensitive, sensitive] = rulesFor(loaded, "write_file").always_deny;
    expect(insensitive?.regex?.test("path/secret.txt")).toBe(true);
    expect(sensitive?.regex?.test("path/secret.txt")).toBe(false);
    expect(sensitive?.regex?.test("path/SECRET.txt")).toBe(true);
  });

  it("drops a rule whose scope is not a scope", () => {
    const loaded = loadFixture("bad-scope", {
      global: { tools: { write_file: { always_confirm: [{ scope: "everywhere" }, "^keep"] } } },
    });

    expect(warningMatching(loaded, /is not one of inside\/outside\/any/)).toContain(
      "always_confirm[0]",
    );
    expect(rulesFor(loaded, "write_file").always_confirm.map((rule) => rule.source)).toEqual([
      "^keep",
    ]);
  });

  it("records which file every rule came from", () => {
    const loaded = loadFixture("origins", {
      global: { tools: { terminal: { always_confirm: ["^global"] } } },
      project: { tools: { terminal: { always_confirm: ["^project"] } } },
    });

    expect(
      rulesFor(loaded, "terminal").always_confirm.map((rule) => [rule.source, rule.origin]),
    ).toEqual([
      ["^global", "global"],
      ["^project", "project"],
    ]);
  });

  it("canonicalizes MCP tool keys and merges both spellings", () => {
    const loaded = loadFixture("mcp-keys", {
      global: {
        tools: {
          mcp__github__create_issue: { always_confirm: ["^a"] },
          "mcp:github:create_issue": { default: "deny", always_confirm: ["^b"] },
        },
      },
    });

    expect(Object.keys(loaded.permissions?.tools ?? {})).toEqual(["mcp:github:create_issue"]);
    const rules = rulesFor(loaded, "mcp:github:create_issue");
    expect(rules.default).toBe("deny");
    expect(rules.always_confirm.map((rule) => rule.source)).toEqual(["^a", "^b"]);
  });
});

describe("merging an untrusted project", () => {
  it.each([
    { globalDefault: "confirm", projectDefault: "allow", expected: "confirm" },
    { globalDefault: "allow", projectDefault: "deny", expected: "deny" },
    { globalDefault: "allow", projectDefault: "confirm", expected: "confirm" },
    { globalDefault: "deny", projectDefault: "allow", expected: "deny" },
  ])(
    "resolves a tool default of $globalDefault against $projectDefault as $expected",
    ({ globalDefault, projectDefault, expected }) => {
      const loaded = loadFixture("tool-default", {
        global: { tools: { write_file: { default: globalDefault } } },
        project: { tools: { write_file: { default: projectDefault } } },
      });

      expect(loaded.trusted).toBe(false);
      expect(rulesFor(loaded, "write_file").default).toBe(expected);
    },
  );

  it.each([
    { globalDefault: "confirm", projectDefault: "allow", expected: "confirm" },
    { globalDefault: "allow", projectDefault: "deny", expected: "deny" },
    // No global file at all: the baseline is the implied `confirm`, and a
    // committed file must not be able to lower it.
    { globalDefault: undefined, projectDefault: "allow", expected: "confirm" },
    { globalDefault: "deny", projectDefault: undefined, expected: "deny" },
  ])(
    "resolves a top-level default of $globalDefault against $projectDefault as $expected",
    ({ globalDefault, projectDefault, expected }) => {
      const loaded = loadFixture("top-default", {
        global: globalDefault === undefined ? undefined : { default: globalDefault },
        project: projectDefault === undefined ? undefined : { default: projectDefault },
      });

      expect(loaded.permissions?.default).toBe(expected);
    },
  );

  it("keeps a global rule the project tries to clear with an empty array", () => {
    const loaded = loadFixture("clear-attempt", {
      global: { tools: { write_file: { always_confirm: ["\\.env$"] } } },
      project: { tools: { write_file: { always_confirm: [] } } },
    });

    expect(rulesFor(loaded, "write_file").always_confirm.map((rule) => rule.source)).toEqual([
      "\\.env$",
    ]);
  });

  it("appends new project rules after the global ones", () => {
    const loaded = loadFixture("append", {
      global: { tools: { write_file: { always_confirm: ["\\.env$"] } } },
      project: { tools: { write_file: { always_confirm: ["^migrations/"] } } },
    });

    expect(rulesFor(loaded, "write_file").always_confirm.map((rule) => rule.source)).toEqual([
      "\\.env$",
      "^migrations/",
    ]);
  });

  it("unions the tool key sets", () => {
    const loaded = loadFixture("union-keys", {
      global: { tools: { write_file: { default: "confirm" } } },
      project: { tools: { terminal: { always_deny: ["^curl"] } } },
    });

    expect(Object.keys(loaded.permissions?.tools ?? {})).toEqual(["write_file", "terminal"]);
  });

  it("does not let a project undercut what a tool inherits", () => {
    // `write_file` inherits `confirm` from the global default, so the project's
    // `allow` is measured against `confirm`, not against "unset".
    const loaded = loadFixture("undercut", {
      global: { default: "confirm", tools: { write_file: { always_confirm: ["\\.env$"] } } },
      project: { tools: { write_file: { default: "allow" } } },
    });

    expect(rulesFor(loaded, "write_file").default).toBe("confirm");
  });
});

describe("trustedProjects", () => {
  it.each([
    { entry: "<root>", expected: true },
    { entry: "<root>/", expected: true },
    { entry: "<parent>/*", expected: true },
    { entry: "<base>/*", expected: false },
    { entry: "<base>/**", expected: true },
    { entry: "<root>-other", expected: false },
    { entry: "<parent>/rep?", expected: true },
  ])("trusts $entry: $expected", ({ entry, expected }) => {
    const workspace = createWorkspace("trust", { project: { default: "allow" } });
    const resolved = entry
      .replace("<root>", workspace.projectRoot)
      .replace("<parent>", dirname(workspace.projectRoot))
      .replace("<base>", base);
    writeConfig(workspace.globalPath, { trustedProjects: [resolved], default: "confirm" });

    const loaded = load(workspace);

    expect(loaded.trusted).toBe(expected);
    // Only a trusted project may relax the global default.
    expect(loaded.permissions?.default).toBe(expected ? "allow" : "confirm");
  });

  it("lets a trusted project clear a global list", () => {
    const workspace = createWorkspace("trusted-clear", {
      project: { tools: { write_file: { always_confirm: [] } } },
    });
    writeConfig(workspace.globalPath, {
      trustedProjects: [workspace.projectRoot],
      tools: { write_file: { always_confirm: ["\\.env$"] } },
    });

    const loaded = load(workspace);

    expect(loaded.trusted).toBe(true);
    expect(rulesFor(loaded, "write_file").always_confirm).toEqual([]);
  });

  it("keeps a global list a trusted project does not mention", () => {
    const workspace = createWorkspace("trusted-absent-key", {
      project: { tools: { write_file: { default: "allow" } } },
    });
    writeConfig(workspace.globalPath, {
      trustedProjects: [workspace.projectRoot],
      default: "confirm",
      tools: { write_file: { always_confirm: ["\\.env$"] } },
    });

    const loaded = load(workspace);

    expect(rulesFor(loaded, "write_file").always_confirm.map((rule) => rule.source)).toEqual([
      "\\.env$",
    ]);
    expect(rulesFor(loaded, "write_file").default).toBe("allow");
  });

  it("ignores trustedProjects written in the project file", () => {
    const workspace = createWorkspace("self-trust", {
      global: { tools: { write_file: { always_confirm: ["\\.env$"] } } },
    });
    writeConfig(workspace.projectPath, {
      trustedProjects: [workspace.projectRoot],
      tools: { write_file: { always_confirm: [] } },
    });

    const loaded = load(workspace);

    expect(loaded.trusted).toBe(false);
    expect(loaded.projectRaw?.trustedProjects).toBeUndefined();
    expect(loaded.warnings).toEqual([]);
    expect(rulesFor(loaded, "write_file").always_confirm.map((rule) => rule.source)).toEqual([
      "\\.env$",
    ]);
  });
});

describe("invalid patterns", () => {
  it.each([{ pattern: "[bad" }, { pattern: "(unclosed" }, { pattern: "*broken" }, { pattern: "a{2,1}" }])(
    "collects $pattern instead of throwing",
    ({ pattern }) => {
      const loaded = loadFixture("invalid", {
        global: { tools: { write_file: { always_deny: [pattern] } } },
      });

      const rules = rulesFor(loaded, "write_file");
      expect(rules.invalidPatterns.map((entry) => entry.pattern)).toEqual([pattern]);
      expect(rules.always_deny).toEqual([]);
    },
  );

  it("keeps the rules that do compile and reports the failure", () => {
    const loaded = loadFixture("one-invalid", {
      global: { tools: { write_file: { always_deny: ["[bad", "\\.env$"] } } },
    });

    const rules = rulesFor(loaded, "write_file");
    expect(rules.invalidPatterns).toHaveLength(1);
    expect(rules.invalidPatterns[0]?.origin).toBe("global");
    expect(rules.invalidPatterns[0]?.message.length).toBeGreaterThan(0);
    expect(rules.always_deny.map((rule) => rule.source)).toEqual(["\\.env$"]);
    expect(warningMatching(loaded, /invalid pattern/)).toContain('"write_file"');
  });

  it("leaves other tools alone", () => {
    const loaded = loadFixture("scoped-invalid", {
      global: {
        tools: {
          write_file: { always_deny: ["[bad"] },
          terminal: { always_confirm: ["^ls"] },
        },
      },
    });

    expect(rulesFor(loaded, "write_file").invalidPatterns).toHaveLength(1);
    expect(rulesFor(loaded, "terminal").invalidPatterns).toEqual([]);
    expect(rulesFor(loaded, "terminal").always_confirm.map((rule) => rule.source)).toEqual(["^ls"]);
  });

  it("notifies the tool name and the count once per tool", () => {
    const loaded = loadFixture("two-invalid", {
      global: { tools: { write_file: { always_deny: ["[bad", "(unclosed"] } } },
    });

    expect(rulesFor(loaded, "write_file").invalidPatterns).toHaveLength(2);
    const warning = warningMatching(loaded, /invalid pattern/);
    expect(warning).toContain('"write_file"');
    expect(warning).toMatch(/\b2 invalid pattern/);
    expect(loaded.warnings.filter((entry) => /invalid pattern/.test(entry))).toHaveLength(1);
  });

  it("attributes a project pattern to the project file", () => {
    const loaded = loadFixture("project-invalid", {
      global: { tools: { terminal: { always_confirm: ["^ls"] } } },
      project: { tools: { terminal: { always_deny: ["*broken"] } } },
    });

    expect(
      rulesFor(loaded, "terminal").invalidPatterns.map((entry) => [entry.pattern, entry.origin]),
    ).toEqual([["*broken", "project"]]);
  });
});

describe("untrusted project pattern limits", () => {
  it("keeps the first rules of an over-long list and reports the drops", () => {
    const loaded = loadFixture("count-limit", {
      global: { default: "confirm" },
      project: { tools: { terminal: { always_confirm: manyRules(100) } } },
    });

    const rules = rulesFor(loaded, "terminal");
    expect(rules.always_confirm).toHaveLength(PROJECT_PATTERN_LIMIT);
    expect(rules.always_confirm[0]?.source).toBe("^generated-0/");
    expect(rules.always_confirm[PROJECT_PATTERN_LIMIT - 1]?.source).toBe("^generated-63/");
    const warning = warningMatching(loaded, /dropped/);
    expect(warning).toContain('"terminal"');
    expect(warning).toMatch(/\b36 rule/);
  });

  it("drops an over-long pattern and keeps the rest", () => {
    const long = "a".repeat(PROJECT_PATTERN_LENGTH_LIMIT + 88);
    const loaded = loadFixture("length-limit", {
      project: { tools: { terminal: { always_deny: [long, "^ok"] } } },
    });

    expect(rulesFor(loaded, "terminal").always_deny.map((rule) => rule.source)).toEqual(["^ok"]);
    expect(warningMatching(loaded, /dropped/)).toMatch(/\b1 rule/);
  });

  it("counts one budget across the three lists of a tool", () => {
    const loaded = loadFixture("cross-list-limit", {
      project: {
        tools: {
          terminal: {
            always_allow: manyRules(40),
            always_confirm: manyRules(40),
            always_deny: manyRules(40),
          },
        },
      },
    });

    const rules = rulesFor(loaded, "terminal");
    expect(rules.always_allow).toHaveLength(40);
    expect(rules.always_confirm).toHaveLength(PROJECT_PATTERN_LIMIT - 40);
    expect(rules.always_deny).toHaveLength(0);
    expect(warningMatching(loaded, /dropped/)).toMatch(/\b56 rule/);
  });

  it("does not limit the global file", () => {
    const long = "a".repeat(PROJECT_PATTERN_LENGTH_LIMIT + 88);
    const loaded = loadFixture("global-unlimited", {
      global: { tools: { terminal: { always_confirm: [...manyRules(100), long] } } },
    });

    expect(rulesFor(loaded, "terminal").always_confirm).toHaveLength(101);
    expect(loaded.warnings).toEqual([]);
  });

  it("does not limit a trusted project", () => {
    const workspace = createWorkspace("trusted-unlimited", {
      project: { tools: { terminal: { always_confirm: manyRules(100) } } },
    });
    writeConfig(workspace.globalPath, { trustedProjects: [workspace.projectRoot] });

    const loaded = load(workspace);

    expect(loaded.trusted).toBe(true);
    expect(rulesFor(loaded, "terminal").always_confirm).toHaveLength(100);
    expect(loaded.warnings).toEqual([]);
  });
});

describe("default inheritance", () => {
  it("implies confirm when a file exists but sets no default", () => {
    const loaded = loadFixture("implied-default", {
      global: { tools: { write_file: { always_confirm: ["\\.env$"] } } },
    });

    expect(loaded.permissions?.default).toBe("confirm");
  });

  it("leaves a tool without a default unset, for the decision stage to inherit", () => {
    const loaded = loadFixture("inherit-default", {
      global: { default: "allow", tools: { write_file: { always_confirm: ["\\.env$"] } } },
    });

    expect(loaded.permissions?.default).toBe("allow");
    expect(rulesFor(loaded, "write_file").default).toBeUndefined();
  });
});

describe("repeated loading", () => {
  it("sees a file written between two calls", () => {
    const workspace = createWorkspace("reload", {});

    expect(load(workspace).permissions).toBeUndefined();
    writeConfig(workspace.globalPath, { default: "deny" });

    expect(load(workspace).permissions?.default).toBe("deny");
  });
});
