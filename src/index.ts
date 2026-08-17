/**
 * omp-toolgate — a single `tool_call` interceptor that applies Zed-style
 * `tool_permissions` rules to omp's tools.
 *
 * The extension deliberately does not shadow any built-in tool: omp implements
 * its `bash` critical-command guard, `bash.patterns`, write exclusivity and TUI
 * renderers inside the native tool definitions, and a same-name `registerTool`
 * would replace all of it (design D1).
 *
 * The host API is described here structurally, so this repository type-checks
 * without depending on the omp package. Only the members actually used appear.
 */

import { loadPermissions, type JsoncParser, type LoadedPermissions } from "./config.ts";
import { decideCalls } from "./decision.ts";
import { mapToolCall } from "./mapping.ts";
import { appendAlwaysAllow, buildBlockReason, planApproval } from "./prompt.ts";
import { createPathResolver, resolveProjectRoot } from "./project-root.ts";
import { isRecord, type PathResolver } from "./types.ts";

interface UiContext {
  select(title: string, options: string[]): Promise<unknown>;
  notify(message: string, level: string): void;
}

interface ExtensionContext {
  readonly cwd: string;
  readonly hasUI: boolean;
  readonly ui: UiContext;
}

interface ToolCallEvent {
  readonly toolName: string;
  readonly input: unknown;
}

/** What a `tool_call` handler may return to stop the call. */
interface ToolCallOutcome {
  readonly block: true;
  readonly reason: string;
}

interface ExtensionApi {
  setLabel(label: string): void;
  on(
    event: "session_start",
    handler: (event: unknown, ctx: ExtensionContext) => Promise<void>,
  ): unknown;
  on(
    event: "tool_call",
    handler: (
      event: ToolCallEvent,
      ctx: ExtensionContext,
    ) => Promise<ToolCallOutcome | undefined>,
  ): unknown;
}

/** Bun ships a JSONC parser; Node does not, so tests fall back to `json5`. */
interface BunGlobal {
  JSON5?: { parse?: (text: string) => unknown };
}

interface GateState {
  readonly cwd: string;
  readonly projectRoot: string;
  readonly resolve: PathResolver;
  loaded: LoadedPermissions;
}

async function createJsoncParser(): Promise<JsoncParser> {
  const { Bun: bun } = globalThis as { Bun?: BunGlobal };
  const bunParse = bun?.JSON5?.parse;
  if (typeof bunParse === "function") return bunParse;
  // Dynamic on purpose: `json5` is a devDependency that exists for the Node
  // test run only. omp is a Bun binary and takes the branch above, and a static
  // import would make the extension fail to load wherever node_modules is absent.
  const { default: JSON5 } = await import("json5");
  return (text: string) => JSON5.parse(text);
}

export default function ompToolgate(pi: ExtensionApi): void {
  pi.setLabel("toolgate");

  let parser: JsoncParser | undefined;
  let state: GateState | undefined;
  const announced = new Set<string>();

  async function load(cwd: string, env: NodeJS.ProcessEnv): Promise<GateState> {
    parser ??= await createJsoncParser();
    const projectRoot = resolveProjectRoot(cwd, env);
    return {
      cwd,
      projectRoot,
      resolve: createPathResolver(cwd, projectRoot, env),
      loaded: loadPermissions(projectRoot, env, parser),
    };
  }

  /**
   * Reloads whenever the working directory changed, which is how a session
   * switch or a branch reaches us without subscribing to every lifecycle event.
   */
  async function ensureState(ctx: ExtensionContext): Promise<GateState> {
    if (state === undefined || state.cwd !== ctx.cwd) {
      state = await load(ctx.cwd, process.env);
    }
    return state;
  }

  /** Notifies each distinct message once per session, prefixed exactly once. */
  function announce(ctx: ExtensionContext, message: string): void {
    if (announced.has(message)) return;
    announced.add(message);
    ctx.ui.notify(`omp-toolgate: ${message}`, "warn");
  }

  pi.on("session_start", async (_event, ctx) => {
    const current = await load(ctx.cwd, process.env);
    state = current;
    if (current.loaded.permissions === undefined) return;
    for (const warning of current.loaded.warnings) announce(ctx, warning);
  });

  pi.on("tool_call", async (event, ctx) => {
    try {
      const current = await ensureState(ctx);
      const permissions = current.loaded.permissions;
      if (permissions === undefined) return undefined;

      const mapping = mapToolCall(event.toolName, event.input, current.resolve);
      if (mapping.warning !== undefined) announce(ctx, mapping.warning);
      if (mapping.calls.length === 0) return undefined;

      const decision = decideCalls(mapping.calls, permissions);
      if (decision.mode === "allow") return undefined;
      if (decision.mode === "deny") {
        return {
          block: true,
          reason: buildBlockReason(decision, "deny", current.loaded.globalPath),
        };
      }

      // `confirm` without a UI must not become an implicit allow (design D10).
      if (!ctx.hasUI) {
        return {
          block: true,
          reason: buildBlockReason(decision, "no-ui", current.loaded.globalPath),
        };
      }

      const plan = planApproval(decision, {
        globalPath: current.loaded.globalPath,
        projectPath: current.loaded.projectPath,
      });
      const title =
        plan.notes.length === 0
          ? plan.body
          : `${plan.body}\n${plan.notes.map((note) => `  note: ${note}`).join("\n")}`;
      const answer = await ctx.ui.select(
        title,
        plan.choices.map((choice) => choice.label),
      );

      // Anything that is not one of the offered labels — a cancel, a closed
      // dialog, a future UI returning an index — is treated as a denial.
      const choice = plan.choices.find((candidate) => candidate.label === answer);
      if (choice === undefined || choice.kind === "deny") {
        return {
          block: true,
          reason: buildBlockReason(decision, "user-denied", current.loaded.globalPath),
        };
      }
      if (choice.kind === "once") return undefined;

      if (choice.file !== undefined && choice.pattern !== undefined) {
        parser ??= await createJsoncParser();
        const result = appendAlwaysAllow(
          choice.file,
          decision.virtualTool,
          choice.pattern,
          parser,
        );
        // Reload so the recorded pattern takes effect immediately.
        current.loaded = loadPermissions(current.projectRoot, process.env, parser);
        ctx.ui.notify(
          `omp-toolgate: ${result === "duplicate" ? "already present" : "recorded"} ${choice.pattern} for ${decision.virtualTool} in ${choice.file}`,
          "info",
        );
      }
      return undefined;
    } catch (error) {
      // A bug here must not silently open the gate. Block this one call and say
      // why; omp would also block on a thrown error, but then without a reason.
      const detail = isRecord(error) && typeof error["message"] === "string" ? error["message"] : String(error);
      return {
        block: true,
        reason: `omp-toolgate failed to evaluate this call and blocked it: ${detail}. Report the failure; remove the extension to bypass it.`,
      };
    }
  });
}
