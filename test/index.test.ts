import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import ompToolgate from "../src/index.ts";
import type {
  ExtensionApi,
  ExtensionContext,
  SessionStartHandler,
  ToolCallEvent,
  ToolCallHandler,
  ToolCallOutcome,
} from "../src/index.ts";

/**
 * These tests drive the extension entry point end to end against a stub host,
 * because everything the entry point owns — turning a decision into a block,
 * failing closed without a UI, treating an unrecognized answer as a denial,
 * writing a pattern back and reloading — has no other automated cover.
 */

const roots: string[] = [];
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROJECT_ROOT", "HOME"] as const;
const savedEnv = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  readonly repo: string;
  readonly globalFile: string;
  readonly projectFile: string;
  readonly ctx: ExtensionContext;
  readonly sessionStart: SessionStartHandler;
  readonly toolCall: ToolCallHandler;
  readonly notifications: string[];
  readonly prompts: { title: string; options: string[] }[];
}

interface HarnessOptions {
  /** Contents of the global configuration file; omitted means the file is absent. */
  global?: string;
  /** Contents of the project configuration file; omitted means the file is absent. */
  project?: string;
  hasUI?: boolean;
  /** Answers the approval dialog. Returning `undefined` models a cancel. */
  answer?: (options: string[]) => unknown;
  /** Makes the dialog throw, to exercise the handler's own failure path. */
  selectThrows?: boolean;
}

function harness(options: HarnessOptions): Harness {
  const root = mkdtempSync(path.join(tmpdir(), "toolgate-index-"));
  roots.push(root);
  const agentDir = path.join(root, "agent");
  const repo = path.join(root, "repo");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(path.join(repo, "src"), { recursive: true });

  const globalFile = path.join(agentDir, "tool-permissions.json");
  const projectFile = path.join(repo, ".omp", "tool-permissions.json");
  if (options.global !== undefined) writeFileSync(globalFile, options.global);
  if (options.project !== undefined) {
    mkdirSync(path.dirname(projectFile), { recursive: true });
    writeFileSync(projectFile, options.project);
  }

  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["OMP_PROJECT_ROOT"] = repo;
  process.env["HOME"] = root;

  const notifications: string[] = [];
  const prompts: { title: string; options: string[] }[] = [];
  const ctx: ExtensionContext = {
    cwd: repo,
    hasUI: options.hasUI ?? true,
    ui: {
      async select(title: string, choices: string[]): Promise<unknown> {
        prompts.push({ title, options: choices });
        if (options.selectThrows === true) throw new Error("dialog exploded");
        return options.answer?.(choices);
      },
      notify(message: string): void {
        notifications.push(message);
      },
    },
  };

  let sessionStart: SessionStartHandler | undefined;
  let toolCall: ToolCallHandler | undefined;
  const pi: ExtensionApi = {
    setLabel(): void {},
    // The host API is overloaded, so the stub records handlers generically and
    // narrows here; this is a test seam, not a claim about the value's shape.
    on(event: string, handler: unknown): unknown {
      if (event === "session_start") sessionStart = handler as SessionStartHandler;
      if (event === "tool_call") toolCall = handler as ToolCallHandler;
      return undefined;
    },
  };
  ompToolgate(pi);

  if (sessionStart === undefined || toolCall === undefined) {
    throw new Error("the extension did not register both handlers");
  }
  return {
    repo,
    globalFile,
    projectFile,
    ctx,
    sessionStart,
    toolCall,
    notifications,
    prompts,
  };
}

function call(toolName: string, input: unknown): ToolCallEvent {
  return { toolName, input };
}

const GUARDED = JSON.stringify({
  default: "allow",
  tools: {
    write_file: {
      default: "allow",
      always_confirm: [{ pattern: "(^|/)\\.env$" }],
      always_deny: [{ pattern: "(^|/)\\.ssh(/|$)" }],
    },
    delete_path: { default: "confirm" },
  },
});

describe("registration", () => {
  it("registers exactly the two handlers it needs", () => {
    const events: string[] = [];
    const pi: ExtensionApi = {
      setLabel(): void {},
      on(event: string): unknown {
        events.push(event);
        return undefined;
      },
    };
    ompToolgate(pi);
    expect(events).toEqual(["session_start", "tool_call"]);
  });
});

describe("gate disabled", () => {
  it("passes every call through when no configuration file exists", async () => {
    const host = harness({});
    await host.sessionStart(undefined, host.ctx);
    expect(await host.toolCall(call("write", { path: ".env", content: "x" }), host.ctx)).toBe(
      undefined,
    );
    expect(await host.toolCall(call("bash", { command: "sudo rm -rf /" }), host.ctx)).toBe(
      undefined,
    );
    expect(host.notifications).toEqual([]);
    expect(host.prompts).toEqual([]);
  });
});

describe("applying a decision", () => {
  it("lets an allowed call through untouched", async () => {
    const host = harness({ global: GUARDED });
    expect(
      await host.toolCall(call("write", { path: "src/a.ts", content: "x" }), host.ctx),
    ).toBe(undefined);
    expect(host.prompts).toEqual([]);
  });

  it("blocks a denied call and names the rule in the reason", async () => {
    const host = harness({ global: GUARDED });
    const outcome = await host.toolCall(
      call("write", { path: ".ssh/id_rsa", content: "x" }),
      host.ctx,
    );
    expect(outcome?.block).toBe(true);
    expect(outcome?.reason).toContain("denied write_file");
    expect(outcome?.reason).toContain("(^|/)\\.ssh(/|$)");
    expect(outcome?.reason).toContain(host.globalFile);
    expect(host.prompts).toEqual([]);
  });

  it("maps an edit REM section to delete_path and confirms it", async () => {
    const host = harness({ global: GUARDED, hasUI: false });
    const outcome = await host.toolCall(
      call("edit", { input: "[src/a.ts#1A2B]\nREM" }),
      host.ctx,
    );
    expect(outcome?.block).toBe(true);
    expect(outcome?.reason).toContain("delete_path");
  });

  it("passes an ungated tool through without a decision", async () => {
    const host = harness({ global: GUARDED });
    expect(await host.toolCall(call("todo", { op: "view" }), host.ctx)).toBe(undefined);
    expect(host.prompts).toEqual([]);
  });
});

describe("confirm without a UI", () => {
  it("blocks and points at the parent session", async () => {
    const host = harness({ global: GUARDED, hasUI: false });
    const outcome = await host.toolCall(call("write", { path: ".env", content: "x" }), host.ctx);
    expect(outcome?.block).toBe(true);
    expect(outcome?.reason).toContain("no interactive UI");
    expect(outcome?.reason).toContain("parent interactive session");
    expect(host.prompts).toEqual([]);
  });
});

describe("confirm with a UI", () => {
  const projectDefaultConfirm = JSON.stringify({
    tools: { write_file: { default: "confirm" } },
  });

  it("runs the tool and writes nothing when the user allows once", async () => {
    const host = harness({
      global: GUARDED,
      project: projectDefaultConfirm,
      answer: (choices) => choices[0],
    });
    const before = readFileSync(host.projectFile, "utf8");
    expect(
      await host.toolCall(call("write", { path: "src/generated/a.ts", content: "x" }), host.ctx),
    ).toBe(undefined);
    expect(host.prompts).toHaveLength(1);
    expect(host.prompts[0]?.options[0]).toBe("Allow once");
    expect(readFileSync(host.projectFile, "utf8")).toBe(before);
  });

  it("blocks when the user denies", async () => {
    const host = harness({
      global: GUARDED,
      project: projectDefaultConfirm,
      answer: (choices) => choices.at(-1),
    });
    const outcome = await host.toolCall(
      call("write", { path: "src/generated/a.ts", content: "x" }),
      host.ctx,
    );
    expect(outcome?.block).toBe(true);
    expect(outcome?.reason).toContain("the user denied it");
  });

  it.each([
    { what: "a cancel", answer: (): unknown => undefined },
    { what: "an index instead of a label", answer: (): unknown => 0 },
    { what: "an unknown string", answer: (): unknown => "Sure, go ahead" },
  ])("treats $what as a denial", async ({ answer }) => {
    const host = harness({ global: GUARDED, project: projectDefaultConfirm, answer });
    const outcome = await host.toolCall(
      call("write", { path: "src/generated/a.ts", content: "x" }),
      host.ctx,
    );
    expect(outcome?.block).toBe(true);
    expect(outcome?.reason).toContain("the user denied it");
  });

  it("records the chosen pattern and stops asking for the rest of the session", async () => {
    const host = harness({
      global: GUARDED,
      project: projectDefaultConfirm,
      answer: (choices) => choices.find((choice) => choice.startsWith("Always allow (this project)")),
    });

    expect(
      await host.toolCall(call("write", { path: "src/generated/a.ts", content: "x" }), host.ctx),
    ).toBe(undefined);
    expect(host.prompts).toHaveLength(1);

    const written: unknown = JSON.parse(readFileSync(host.projectFile, "utf8"));
    expect(written).toEqual({
      tools: {
        write_file: {
          default: "confirm",
          always_allow: [{ pattern: "^src/generated/" }],
        },
      },
    });
    expect(host.notifications.join("\n")).toContain("recorded ^src/generated/");

    // The reload must make the recorded pattern effective immediately.
    expect(
      await host.toolCall(call("write", { path: "src/generated/b.ts", content: "y" }), host.ctx),
    ).toBe(undefined);
    expect(host.prompts).toHaveLength(1);
  });

  it("withholds always-allow when an always_confirm rule caused the prompt", async () => {
    const host = harness({ global: GUARDED, answer: (choices) => choices[0] });
    await host.toolCall(call("write", { path: ".env", content: "x" }), host.ctx);
    expect(host.prompts[0]?.options).toEqual(["Allow once", "Deny"]);
    expect(host.prompts[0]?.title).toContain("always_allow is evaluated after it");
  });
});

describe("warnings", () => {
  it("notifies each startup warning once", async () => {
    const host = harness({
      global: JSON.stringify({ tools: { write_file: { always_deny: ["[bad"] } } }),
    });
    await host.sessionStart(undefined, host.ctx);
    await host.sessionStart(undefined, host.ctx);
    const invalid = host.notifications.filter((message) => message.includes("invalid pattern"));
    expect(invalid).toHaveLength(1);
    expect(invalid[0]).toContain('tool "write_file"');
    expect(invalid[0]).toContain("omp-toolgate:");
  });

  it("warns once when a major tool arrives with an unexpected argument shape", async () => {
    const host = harness({ global: GUARDED });
    // `write_file.default` is allow here, so the call proceeds — but on the
    // tool's default only, never on an implicit allow, and it must be reported.
    expect(await host.toolCall(call("write", { content: "no path here" }), host.ctx)).toBe(
      undefined,
    );
    expect(await host.toolCall(call("write", { content: "again" }), host.ctx)).toBe(undefined);
    expect(host.notifications).toEqual([
      'omp-toolgate: write was called without a string "path"; only the write_file default applies.',
    ]);
  });
});

describe("failure containment", () => {
  it("blocks the call when the gate itself throws", async () => {
    const host = harness({
      global: GUARDED,
      project: JSON.stringify({ tools: { write_file: { default: "confirm" } } }),
      selectThrows: true,
    });
    const outcome = await host.toolCall(
      call("write", { path: "src/generated/a.ts", content: "x" }),
      host.ctx,
    );
    expect(outcome?.block).toBe(true);
    expect(outcome?.reason).toContain("failed to evaluate this call");
    expect(outcome?.reason).toContain("dialog exploded");
  });
});
