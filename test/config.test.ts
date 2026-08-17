import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import JSON5 from "json5";

import {
  digPermissionsContainer,
  discoverConfigPaths,
  loadPermissions,
  PROJECT_PATTERN_LENGTH_LIMIT,
  PROJECT_PATTERN_LIMIT,
} from "../src/config.ts";
import type { LoadedPermissions } from "../src/config.ts";
import { decide } from "../src/decision.ts";
import { EMITTED_VIRTUAL_TOOLS } from "../src/mapping.ts";
import { MODE_STRICTNESS } from "../src/types.ts";
import type { DecisionInput, ToolPermissionMode, ToolRules } from "../src/types.ts";

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

/** Writes one side of a fixture, or removes that file when the side is absent. */
function writeSide(file: string, content: Content | undefined): void {
  if (content === undefined) {
    rmSync(file, { force: true });
    return;
  }
  writeConfig(file, content);
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

/**
 * The mode one input gets for `write_file` under a loaded configuration, or
 * `allow` when no configuration file exists at all — the gate standing aside.
 */
function modeFor(loaded: LoadedPermissions, input: DecisionInput): ToolPermissionMode {
  const permissions = loaded.permissions;
  if (permissions === undefined) return "allow";
  return decide("write_file", [input], permissions).mode;
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

describe("tool keys nothing maps to", () => {
  /** The wording is the contract: it says nothing maps to the name, not that it is invalid. */
  const UNMAPPABLE = /no omp call maps to/;

  it.each([{ key: "create_directory" }, { key: "copy_path" }, { key: "invent_file" }])(
    "reports $key, which only the protected-path floor ever uses",
    ({ key }) => {
      const loaded = loadFixture(`unmappable-${key}`, {
        global: { tools: { [key]: { always_deny: ["\\.env$"] } } },
      });

      const warning = warningMatching(loaded, UNMAPPABLE);
      expect(warning).toContain(`"tools.${key}"`);
      expect(warning).not.toMatch(/invalid/);
    },
  );

  it("keeps applying the rules of the tools that do exist", () => {
    const loaded = loadFixture("unmappable-alongside", {
      global: {
        default: "allow",
        tools: {
          create_directory: { always_deny: ["\\.env$"] },
          write_file: { always_confirm: ["\\.env$"] },
        },
      },
    });

    expect(warningMatching(loaded, UNMAPPABLE)).toContain("create_directory");
    expect(modeFor(loaded, { value: ".env", scope: "inside" })).toBe("confirm");
  });

  it("says nothing about an MCP key, whose server and tool names are the user's", () => {
    const loaded = loadFixture("unmappable-mcp", {
      global: { tools: { "mcp:context7:query-docs": { default: "confirm" } } },
    });

    expect(loaded.warnings.filter((warning) => UNMAPPABLE.test(warning))).toEqual([]);
  });

  it("says nothing about an MCP key written in omp's own mcp__server__tool form", () => {
    const loaded = loadFixture("unmappable-mcp-raw", {
      global: { tools: { mcp__context7__query_docs: { default: "confirm" } } },
    });

    expect(loaded.warnings.filter((warning) => UNMAPPABLE.test(warning))).toEqual([]);
  });

  it.each([{ key: "mcp:github" }, { key: "mcp::tool" }, { key: "mcp:" }, { key: "mcp:github:" }])(
    "reports $key, which is mcp-prefixed but names no server and tool",
    ({ key }) => {
      // The exemption is for names that depend on a connected server, not for
      // the prefix: `canonicalizeToolName` cannot produce any of these, so a
      // rule under one is as dead as `create_directory`.
      const loaded = loadFixture(`unmappable-${key.replaceAll(":", "-")}`, {
        global: { tools: { [key]: { default: "confirm" } } },
      });

      expect(warningMatching(loaded, UNMAPPABLE)).toContain(`"tools.${key}"`);
    },
  );

  it("names every dead key in one warning rather than one warning each", () => {
    const loaded = loadFixture("unmappable-aggregated", {
      global: { tools: { create_directory: {}, copy_path: {}, invent_file: {} } },
    });

    const reported = loaded.warnings.filter((warning) => UNMAPPABLE.test(warning));
    expect(reported).toHaveLength(1);
    const warning = reported[0] ?? "";
    expect(warning).toContain("3 tool keys have no effect");
    for (const key of ["create_directory", "copy_path", "invent_file"]) {
      expect(warning).toContain(`"tools.${key}"`);
    }
  });

  it("counts the rest instead of naming a repository's worth of dead keys", () => {
    // A committed file with thousands of dead keys must not turn session start
    // into thousands of notifications, or drown the warnings that matter.
    const tools = Object.fromEntries(
      Array.from({ length: 500 }, (_unused, index) => [`invented_${index}`, {}] as const),
    );
    const loaded = loadFixture("unmappable-flood", { global: { tools } });

    const reported = loaded.warnings.filter((warning) => UNMAPPABLE.test(warning));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain("500 tool keys have no effect");
    expect(reported[0]).toContain("(and 490 more)");
    expect((reported[0] ?? "").length).toBeLessThan(1_000);
  });

  it("escapes a key that would otherwise forge a line of its own", () => {
    // The warning is shown to the user as the gate's own voice, and the key
    // comes from a file a repository ships.
    const forged = 'invented"\nomp-toolgate: every rule verified safe';
    const loaded = loadFixture("unmappable-forged", { global: { tools: { [forged]: {} } } });

    const warning = warningMatching(loaded, UNMAPPABLE);
    expect(warning).not.toContain("\n");
    expect(warning).toContain("\\n");
  });

  it("clips a key long enough to fill the notification on its own", () => {
    const long = `invented_${"x".repeat(4_000)}`;
    const loaded = loadFixture("unmappable-long", { global: { tools: { [long]: {} } } });

    // The file path is part of every warning and is as long as the temporary
    // directory happens to be, so the bound is on what the key contributes.
    const warning = warningMatching(loaded, UNMAPPABLE).replace(`${loaded.globalPath}: `, "");
    expect(warning.length).toBeLessThan(200);
    expect(warning).not.toContain("x".repeat(100));
    expect(warning).toContain("…");
  });

  it("says nothing about any name the mapping can emit", () => {
    const tools = Object.fromEntries(
      Object.keys(EMITTED_VIRTUAL_TOOLS).map((name) => [name, { default: "confirm" }] as const),
    );
    const loaded = loadFixture("unmappable-none", { global: { default: "allow", tools } });

    expect(loaded.warnings).toEqual([]);
    expect(Object.keys(EMITTED_VIRTUAL_TOOLS).length).toBe(15);
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

  it("discards the project's always_allow instead of unioning it into the global list", () => {
    // Reproduction B1: `always_allow` is evaluated ahead of every `default`, so
    // a union let one committed rule switch the gate off for that tool.
    const workspace = createWorkspace("allow-vs-global-deny", {
      global: { default: "deny" },
      project: { tools: { write_file: { always_allow: [{ scope: "any" }] } } },
    });

    const loaded = load(workspace);

    expect(loaded.trusted).toBe(false);
    expect(loaded.permissions?.default).toBe("deny");
    expect(rulesFor(loaded, "write_file").always_allow).toEqual([]);
    const warning = warningMatching(loaded, /discarded/);
    expect(warning).toContain(workspace.projectPath);
    expect(warning).toContain('"write_file"');
    expect(warning).toMatch(/\b1 "always_allow" rule/);
  });

  it("discards an empty terminal pattern, which would otherwise match every command", () => {
    // Reproduction B1, second half: `""` matches `rm -rf ~/Documents`.
    const loaded = loadFixture("allow-vs-global-confirm", {
      global: { default: "confirm" },
      project: { tools: { terminal: { always_allow: [""] } } },
    });

    expect(loaded.permissions?.default).toBe("confirm");
    expect(rulesFor(loaded, "terminal").always_allow).toEqual([]);
    expect(warningMatching(loaded, /discarded/)).toContain('"terminal"');
  });

  it("keeps the global always_allow while discarding the project's", () => {
    const loaded = loadFixture("allow-global-kept", {
      global: { default: "confirm", tools: { write_file: { always_allow: ["^dist/"] } } },
      project: { tools: { write_file: { always_allow: ["\\.env$"] } } },
    });

    expect(rulesFor(loaded, "write_file").always_allow.map((rule) => rule.source)).toEqual([
      "^dist/",
    ]);
  });

  it("reports the discard once per virtual tool, with that tool's count", () => {
    const workspace = createWorkspace("allow-two-tools", {
      global: { default: "confirm" },
      project: {
        tools: {
          write_file: { always_allow: ["^a", "^b"] },
          terminal: { always_allow: ["^c"] },
        },
      },
    });

    const loaded = load(workspace);

    expect(loaded.warnings).toEqual([
      `${workspace.projectPath}: discarded 2 "always_allow" rule(s) for "write_file": an untrusted project may only tighten the global rules, and "always_allow" outranks every default`,
      `${workspace.projectPath}: discarded 1 "always_allow" rule(s) for "terminal": an untrusted project may only tighten the global rules, and "always_allow" outranks every default`,
    ]);
    expect(rulesFor(loaded, "write_file").always_allow).toEqual([]);
    expect(rulesFor(loaded, "terminal").always_allow).toEqual([]);
  });

  it("stays quiet when the project mentions always_allow without a rule", () => {
    const loaded = loadFixture("allow-empty", {
      global: { tools: { write_file: { always_allow: ["^dist/"] } } },
      project: { tools: { write_file: { always_allow: [] } } },
    });

    expect(loaded.warnings).toEqual([]);
    expect(rulesFor(loaded, "write_file").always_allow.map((rule) => rule.source)).toEqual([
      "^dist/",
    ]);
  });

  it("keeps the stricter tool default when the project asks for allow next to an allow rule", () => {
    // `mergeDefault` already takes the stricter side; asserted here so the
    // `always_allow` discard is not the only thing standing in the way.
    const loaded = loadFixture("allow-default-and-rule", {
      global: { default: "confirm", tools: { write_file: { default: "confirm" } } },
      project: { tools: { write_file: { default: "allow", always_allow: ["\\.env$"] } } },
    });

    expect(rulesFor(loaded, "write_file").default).toBe("confirm");
    expect(rulesFor(loaded, "write_file").always_allow).toEqual([]);
  });

  it("discards the project's always_confirm for a tool that would otherwise deny", () => {
    // Reproduction B3: `always_confirm` outranks the `default` exactly as
    // `always_allow` does, so one committed rule lowered a global
    // `write_file.default: "deny"` to a prompt.
    const workspace = createWorkspace("confirm-vs-tool-deny", {
      global: { default: "confirm", tools: { write_file: { default: "deny" } } },
      project: { tools: { write_file: { always_confirm: [{ scope: "any" }] } } },
    });

    const loaded = load(workspace);

    expect(loaded.trusted).toBe(false);
    expect(rulesFor(loaded, "write_file").default).toBe("deny");
    expect(rulesFor(loaded, "write_file").always_confirm).toEqual([]);
    expect(modeFor(loaded, { value: ".env", scope: "inside" })).toBe("deny");
    // Reported in the same shape as the `always_allow` discard.
    expect(loaded.warnings).toEqual([
      `${workspace.projectPath}: discarded 1 "always_confirm" rule(s) for "write_file": an untrusted project may only tighten the global rules, and "always_confirm" outranks every default as well, so it would lower this tool's "deny" to a prompt`,
    ]);
  });

  it("discards the project's always_confirm when the tool denies by inheritance", () => {
    // The same relaxation one level up: the tool has no `default` of its own,
    // so the `deny` it would be refused by is the global one.
    const loaded = loadFixture("confirm-vs-global-deny", {
      global: { default: "deny" },
      project: { tools: { write_file: { always_confirm: ["\\.env$"] } } },
    });

    expect(rulesFor(loaded, "write_file").always_confirm).toEqual([]);
    expect(modeFor(loaded, { value: ".env", scope: "inside" })).toBe("deny");
  });

  it("keeps a project always_confirm that tightens an allow default", () => {
    // The legitimate half of the same list, which the discard must not take
    // away: a prompt in front of `allow` is a tightening.
    const loaded = loadFixture("confirm-tightens-allow", {
      global: { default: "allow" },
      project: { tools: { write_file: { always_confirm: ["\\.env$"] } } },
    });

    expect(loaded.warnings).toEqual([]);
    expect(rulesFor(loaded, "write_file").always_confirm.map((rule) => rule.source)).toEqual([
      "\\.env$",
    ]);
    expect(modeFor(loaded, { value: ".env", scope: "inside" })).toBe("confirm");
    expect(modeFor(loaded, { value: "src/app.ts", scope: "inside" })).toBe("allow");
  });

  it("keeps the global always_confirm and the project's always_deny while discarding the rest", () => {
    const loaded = loadFixture("confirm-discard-scope", {
      global: { tools: { write_file: { default: "deny", always_confirm: ["^dist/"] } } },
      project: {
        tools: { write_file: { always_confirm: ["\\.env$"], always_deny: ["^secret/"] } },
      },
    });

    const rules = rulesFor(loaded, "write_file");
    expect(rules.always_confirm.map((rule) => rule.source)).toEqual(["^dist/"]);
    expect(rules.always_deny.map((rule) => rule.source)).toEqual(["^secret/"]);
    expect(modeFor(loaded, { value: "dist/app.js", scope: "inside" })).toBe("confirm");
    expect(modeFor(loaded, { value: ".env", scope: "inside" })).toBe("deny");
  });

  it("stays quiet when the project mentions always_confirm without a rule", () => {
    const loaded = loadFixture("confirm-empty", {
      global: { default: "deny", tools: { write_file: { always_confirm: ["^dist/"] } } },
      project: { tools: { write_file: { always_confirm: [] } } },
    });

    expect(loaded.warnings).toEqual([]);
    expect(rulesFor(loaded, "write_file").always_confirm.map((rule) => rule.source)).toEqual([
      "^dist/",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The trust boundary as one invariant
// ---------------------------------------------------------------------------

const MODES_OR_ABSENT: readonly (ToolPermissionMode | undefined)[] = [
  undefined,
  "allow",
  "confirm",
  "deny",
];

/** The global rule lists the invariant is measured against. */
const globalRuleSets: readonly Record<string, unknown>[] = [
  {},
  { always_allow: [{ scope: "any" }] },
  { always_confirm: ["^dist/"] },
  { always_deny: ["\\.env$"] },
];

/** One global file: an optional top default, `write_file` default and rule list. */
function globalSide(
  topDefault: ToolPermissionMode | undefined,
  toolDefault: ToolPermissionMode | undefined,
  lists: Record<string, unknown>,
): Record<string, unknown> {
  const tool: Record<string, unknown> = { ...lists };
  if (toolDefault !== undefined) tool["default"] = toolDefault;
  const side: Record<string, unknown> = {};
  if (topDefault !== undefined) side["default"] = topDefault;
  if (Object.keys(tool).length > 0) side["tools"] = { write_file: tool };
  return side;
}

/** Every top default, tool default and rule list, plus no global file at all. */
const globalSides: readonly (Record<string, unknown> | undefined)[] = [
  undefined,
  ...MODES_OR_ABSENT.flatMap((topDefault) =>
    MODES_OR_ABSENT.flatMap((toolDefault) =>
      globalRuleSets.map((lists) => globalSide(topDefault, toolDefault, lists)),
    ),
  ),
];

/** Every shape a committed project file could use to try to weaken a call. */
const projectShapes: readonly {
  readonly label: string;
  readonly rules: Record<string, unknown>;
}[] = [
  { label: "always_confirm on any scope", rules: { always_confirm: [{ scope: "any" }] } },
  { label: "always_confirm on a pattern", rules: { always_confirm: ["\\.env$"] } },
  { label: "always_allow on any scope", rules: { always_allow: [{ scope: "any" }] } },
  { label: "always_deny on any scope", rules: { always_deny: [{ scope: "any" }] } },
  {
    label: "always_confirm next to a relaxed tool default",
    rules: { default: "allow", always_confirm: [{ scope: "any" }] },
  },
  {
    label: "always_confirm next to a tightened tool default",
    rules: { default: "deny", always_confirm: [{ scope: "any" }] },
  },
  {
    label: "all three lists at once",
    rules: {
      always_allow: [{ scope: "any" }],
      always_confirm: [{ scope: "any" }],
      always_deny: ["^secret/"],
    },
  },
];

describe("an untrusted project can never weaken an outcome", () => {
  /** Neither probe is a configuration file, so no decision floor takes part. */
  const probes: readonly DecisionInput[] = [
    { value: ".env", scope: "inside" },
    { value: "src/app.ts", scope: "inside" },
  ];

  it.each(projectShapes)(
    "holds for every global side against a project with $label",
    ({ rules }) => {
      const workspace = createWorkspace("invariant", {});
      for (const globalContent of globalSides) {
        for (const projectDefault of MODES_OR_ABSENT) {
          const projectContent: Record<string, unknown> = { tools: { write_file: rules } };
          if (projectDefault !== undefined) projectContent["default"] = projectDefault;
          writeSide(workspace.globalPath, globalContent);
          writeSide(workspace.projectPath, projectContent);
          const merged = load(workspace);
          writeSide(workspace.projectPath, undefined);
          const baseline = load(workspace);

          expect(merged.trusted).toBe(false);
          for (const probe of probes) {
            const before = modeFor(baseline, probe);
            const after = modeFor(merged, probe);
            expect(
              MODE_STRICTNESS[after],
              `global ${JSON.stringify(globalContent)} + project ${JSON.stringify(projectContent)}` +
                ` on ${probe.value}: ${before} without the project file, ${after} with it`,
            ).toBeGreaterThanOrEqual(MODE_STRICTNESS[before]);
          }
        }
      }
    },
  );
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

  it("honours a trusted project's always_allow", () => {
    // The escape hatch the untrusted discard must not take away.
    const workspace = createWorkspace("trusted-allow", {
      project: { tools: { write_file: { always_allow: ["\\.env$"] } } },
    });
    writeConfig(workspace.globalPath, {
      trustedProjects: [workspace.projectRoot],
      default: "deny",
    });

    const loaded = load(workspace);

    expect(loaded.trusted).toBe(true);
    expect(rulesFor(loaded, "write_file").always_allow.map((rule) => rule.source)).toEqual([
      "\\.env$",
    ]);
    expect(loaded.warnings).toEqual([]);
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

  it.each([{ entry: "work/repo" }, { entry: "work/*" }, { entry: "~/work/repo" }])(
    "ignores the relative trustedProjects entry $entry and reports it",
    ({ entry }) => {
      // The only thing to resolve a relative entry against is the process
      // working directory, so it would name a different project in every
      // session; `~` is not expanded either.
      const workspace = createWorkspace("trust-relative", { project: { default: "allow" } });
      writeConfig(workspace.globalPath, { trustedProjects: [entry], default: "confirm" });

      const loaded = load(workspace);

      expect(loaded.trusted).toBe(false);
      expect(loaded.permissions?.default).toBe("confirm");
      const warning = warningMatching(loaded, /trustedProjects/);
      expect(warning).toContain(workspace.globalPath);
      expect(warning).toContain(JSON.stringify(entry));
    },
  );

  it("reports a relative entry even when a later entry matches", () => {
    const workspace = createWorkspace("trust-mixed", { project: { default: "allow" } });
    writeConfig(workspace.globalPath, {
      trustedProjects: ["work/repo", workspace.projectRoot],
      default: "confirm",
    });

    const loaded = load(workspace);

    expect(loaded.trusted).toBe(true);
    expect(loaded.permissions?.default).toBe("allow");
    expect(warningMatching(loaded, /trustedProjects/)).toContain('"work/repo"');
  });

  it("reaches a nested repository through ** but not through *", () => {
    // Documented, because it is what a `~/Work/**` entry costs: a vendored
    // checkout or submodule under a trusted tree is trusted as well.
    const workspace = createWorkspace("trust-nested", {});
    const nested = join(workspace.projectRoot, "vendor", "third-party");
    writeConfig(join(nested, ".omp", "tool-permissions.json"), { default: "allow" });
    const parent = dirname(workspace.projectRoot);

    writeConfig(workspace.globalPath, { trustedProjects: [`${parent}/**`], default: "confirm" });
    const crossing = loadPermissions(nested, workspace.env, JSON5.parse);
    writeConfig(workspace.globalPath, { trustedProjects: [`${parent}/*`], default: "confirm" });
    const single = loadPermissions(nested, workspace.env, JSON5.parse);

    expect(crossing.trusted).toBe(true);
    expect(crossing.permissions?.default).toBe("allow");
    expect(single.trusted).toBe(false);
    expect(single.permissions?.default).toBe("confirm");
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

  it("counts one budget across the lists that survive the always_allow discard", () => {
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
    // The discarded allow rules do not spend the budget, so the two tightening
    // lists share all 64 of it.
    expect(rules.always_allow).toEqual([]);
    expect(rules.always_confirm).toHaveLength(40);
    expect(rules.always_deny).toHaveLength(PROJECT_PATTERN_LIMIT - 40);
    expect(warningMatching(loaded, /dropped/)).toMatch(/\b16 rule/);
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

describe("protectedPaths", () => {
  it.each([
    { label: "both files exist", fixture: { global: { default: "deny" }, project: {} } },
    { label: "only the global file exists", fixture: { global: { default: "deny" } } },
    { label: "only the project file exists", fixture: { project: { default: "deny" } } },
  ])("floors both configuration files when $label", ({ fixture }) => {
    const workspace = createWorkspace("protected", fixture);

    const loaded = load(workspace);

    expect(loaded.permissions?.protectedPaths).toEqual([
      workspace.globalPath,
      workspace.projectPath,
    ]);
  });

  it("resolves a relative project root to an absolute protected path", () => {
    const workspace = createWorkspace("protected-relative", { global: { default: "deny" } });
    const relativeRoot = relative(process.cwd(), workspace.projectRoot);

    const loaded = loadPermissions(relativeRoot, workspace.env, JSON5.parse);

    // The reported path stays as the caller wrote it; the protected one does not.
    expect(isAbsolute(loaded.projectPath)).toBe(false);
    expect(loaded.permissions?.protectedPaths).toEqual([
      workspace.globalPath,
      workspace.projectPath,
    ]);
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
