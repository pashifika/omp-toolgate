# omp-toolgate

A regex-based tool permission gate for [omp](https://github.com/oh-my-pi). It ports the
decision semantics of Zed 1.15's `agent.tool_permissions` into an omp extension and adds a
`project_root` boundary, so you can express rules omp itself cannot:

```jsonc
{
  "tools": {
    "write_file": {
      "default": "allow",
      "always_confirm": [
        { "pattern": "(^|/)\\.env(?:\\.(local|prod))?$" },
        { "pattern": "\\.(pem|key|p12|pfx)$" },
        { "scope": "outside" }, // anything outside the project root
      ],
      "always_deny": [{ "pattern": "(^|/)\\.(ssh|aws)(/|$)" }],
    },
    "terminal": {
      "default": "allow",
      "always_confirm": [{ "pattern": "\\b(sudo|doas)\\b" }],
    },
  },
}
```

## Why

omp's own approval has two axes — a tier (`read` / `write` / `exec`) and a mode
(`always-ask` / `write` / `yolo`) — plus glob patterns for `bash` only. There is no way to
say "confirm writes to `.env` and `*.pem`", and `write` / `edit` have no workspace
boundary at all: with the default `approvalMode: yolo`, a tool call can create or delete a
file anywhere on the filesystem without a prompt. omp-toolgate fills exactly those gaps.

## Install

```bash
mkdir -p ~/.omp/agent/extensions
ln -s /path/to/omp-toolgate ~/.omp/agent/extensions/omp-toolgate
```

omp discovers the directory, reads `package.json#omp.extensions`, and loads `src/index.ts`
directly — there is no build step. Verify with a one-shot session:

```bash
omp -p "call the write tool with path .env and content X=1"
```

To load it for a single session instead, use `omp -e /path/to/omp-toolgate/src/index.ts`.

**omp-toolgate assumes `tools.approvalMode: yolo`** (omp's default). It is a single gate
that runs *before* omp's approval gate. Under a non-yolo mode both gates run and you get
two prompts for the same call: omp-toolgate's, then omp's.

## Configuration

Two files, both optional:

| Scope   | Path                                                    |
| ------- | ------------------------------------------------------- |
| global  | `~/.omp/agent/tool-permissions.json`                    |
| project | `<project_root>/.omp/tool-permissions.json`             |

`PI_CODING_AGENT_DIR` moves the global one. `omp --profile <name>` does **not** — the
global path is always the default agent directory or `PI_CODING_AGENT_DIR`.

**If neither file exists, the extension does nothing at all** and omp behaves exactly as it
would without it. There is no implicit activation.

Files are JSONC: comments and trailing commas are fine. Three nestings are accepted, tried
in this order, so a Zed `settings.json` works verbatim:

```jsonc
{ "agent": { "tool_permissions": { "default": "allow", "tools": {} } } }  // a whole Zed settings.json
{ "tool_permissions": { "default": "allow", "tools": {} } }
{ "default": "allow", "tools": {} }                                       // the block on its own
```

### Rules

```jsonc
{
  "default": "allow" | "confirm" | "deny",   // omitted => confirm
  "trustedProjects": ["/Users/me/Work/*"],   // global file only
  "tools": {
    "<virtual tool>": {
      "default": "allow" | "confirm" | "deny",   // omitted => inherits the global default
      "always_deny":    [/* rules */],
      "always_confirm": [/* rules */],
      "always_allow":   [/* rules */],
    },
  },
}
```

A rule is `{ "pattern": "<regex>", "case_sensitive": false, "scope": "any" }` or the bare
string shorthand `"<regex>"`. `case_sensitive` defaults to `false`. `scope` is
omp-toolgate's own extension: `inside`, `outside`, or `any` (the default). A rule with a
`scope` and no `pattern` matches on location alone. A rule with both requires both.

### Decision order

1. A pattern that failed to compile — that virtual tool denies **every** call.
2. A symlink escape (see below) raises `allow` to `confirm`; it cannot be configured away.
3. A write to one of omp-toolgate's own configuration files raises `allow` to `confirm`; it
   cannot be configured away either, so the gate cannot be told to stop guarding its rules.
4. `always_deny` — any input matching denies immediately.
5. `always_confirm` — any input matching prompts.
6. `always_allow` — **every** input must match. `ls && rm -rf build` is not allowed by
   `^ls` alone. This asymmetry is deliberate and comes from Zed.
7. The virtual tool's `default`.
8. The global `default`.

When one real call maps to several virtual tools — one `edit` payload can edit, delete and
move at once — every virtual tool is decided separately and the strictest result wins
(`deny` > `confirm` > `allow`).

### `project_root` and paths

`project_root` is resolved once per session: `OMP_PROJECT_ROOT`, else the nearest ancestor
holding a `.git` file or directory, else the nearest ancestor holding a language marker
(`go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, `build.gradle`,
`build.gradle.kts`, `composer.json`, `Gemfile`, `mix.exs`), else the working directory. The
walk never crosses `$HOME` and never selects `$HOME` itself. `.omp` is deliberately not a
marker, because omp's `.omp` directories are cwd-local and a `packages/foo/.omp` would
hijack the root of a monorepo.

Every path argument is normalized before any pattern sees it:

1. An omp selector is stripped **only when the tail really is one**: a range or mode
   (`main.ts:50-200`, `:raw`, `:5-16,960-973`), an archive member when the prefix ends in an
   archive suffix (`app.zip:inner/x`), or a SQLite table/row when the prefix ends in a
   database suffix (`db.sqlite:users:42`). Anything else keeps the colon: omp writes such a
   path as an ordinary file, so `backup-12:30:45.tar` must be judged whole.
2. `~` is expanded and the path is made absolute against the working directory, which is
   itself canonicalized first so that both sides of every later comparison agree.
3. Symlinks are resolved **component by component, left to right**, so a `..` applies to the
   directory a symlink actually points at rather than to the name in front of it — the
   kernel's order, not the string's. Once a component does not exist the remainder is joined
   literally, so a path whose parents do not exist yet still works.
4. Inside `project_root` the result is project-relative with no `./` prefix; outside it
   stays absolute. Separators are always `/`.

Because matching happens on the project-relative form, Zed's defensive `(^|/)` prefix keeps
working unchanged: `(^|/)\.env$` matches both `.env` and `config/.env`, and
`(^|/)\.(ssh|aws)(/|$)` still matches the absolute `/Users/me/.ssh/id_rsa` of a path outside
the project.

**Symlink escape.** When the literal path is inside `project_root` but `realpath` leaves it,
the call is promoted to at least `confirm` even if the effective default is `allow`, and the
prompt shows both the literal path and its target. A repository that ships
`config -> ~/.ssh` cannot get a silent write. A matching `always_deny` still wins.

### Project files can only tighten

`<project_root>/.omp/tool-permissions.json` is usually committed, which makes it
third-party input. So by default it is merged in the tightening direction only:

- `always_deny` and `always_confirm` are unions — global rules cannot be removed.
- An untrusted project's `always_allow` is **discarded**, with a warning naming the tool and
  the count. It cannot be unioned in: `always_allow` is evaluated before the `default`, so
  one project-side allow rule would otherwise lift a global `default` of `confirm` or `deny`
  to `allow` — which is where most protection actually lives. A tightening-only file has no
  legitimate use for an allow rule.
- `default`, both global and per tool, takes the stricter of the two values.
- `tools` keys are unioned.

List a project root in the **global** file's `trustedProjects` to give that project normal
hierarchical override instead. Absolute paths and globs (`*`, `**`, `?`) are accepted. A
`trustedProjects` key inside a project file is ignored — a repository cannot declare itself
trustworthy.

Untrusted project files are additionally capped at 64 rules per virtual tool and 512
characters per pattern; anything beyond that is dropped and reported at session start. The
global file is never capped.

## Virtual tool names

omp's tool surface is wider than Zed's and has no `delete_path` tool, so calls are mapped
onto Zed's names by `(real tool, operation)`:

| Real call                                            | Virtual tool  | Checked input                     |
| ---------------------------------------------------- | ------------- | --------------------------------- |
| `write`                                              | `write_file`  | normalized path                   |
| `write` to `db.sqlite:table:key` with empty content  | `delete_path` | the database file                 |
| `edit` section with `PUT` / `CUT`                    | `edit_file`   | the section's path                |
| `edit` section with `REM`                            | `delete_path` | the section's path                |
| `edit` section with `MV DEST`                        | `move_path`   | source and destination            |
| `read`                                               | `read_file`   | normalized path                   |
| `read` of an `http(s)` URL                           | `fetch`       | the URL                           |
| `read` of `skill://<name>`                           | `skill`       | the skill's `SKILL.md`            |
| `glob`                                               | `find_path`   | each search root                  |
| `grep`, `xd://ast_grep`                              | `grep`        | the pattern and each search root  |
| `xd://ast_edit`                                      | `edit_file`   | each element of `paths`           |
| `bash`                                               | `terminal`    | the command                       |
| `hub` with `op: "start"`                             | `terminal`    | `PWD=<cwd> NAME=value … application args` |
| `hub` with `op: "send"`                              | `terminal`    | the `text` written to the process |
| `xd://debug` `launch` / `attach`                     | `terminal`    | the same launch-spec shape        |
| `xd://debug` `evaluate` / `custom_request`           | `terminal`    | the expression or command         |
| `xd://debug` `write_memory`, breakpoint conditions   | `terminal`    | the condition; none for a raw write |
| `task`                                               | `spawn_agent` | `agent` and task text             |
| `web_search`                                         | `web_search`  | the query                         |
| `manage_skill` create / update / delete              | `write_file` / `delete_path` | the skill's `SKILL.md` |
| `learn` writing a skill                              | `write_file`  | the skill's `SKILL.md`            |
| `memory_edit` forget                                 | `delete_path` | the memory id                     |
| `write` to a writable scheme (`ssh://`, `vault://`, unknown) | `write_file` | the whole URI, scope `outside` |
| `eval`, `xd://browser`, `computer`, `xd://lsp` edit actions | `eval` / `browser` / `computer` / `edit_file` | none — `default` only |
| `mcp__<server>__<tool>`                              | `mcp:<server>:<tool>` | every string argument     |

Both `mcp__server__tool` and `mcp:server:tool` work as configuration keys.

A launch is judged on its whole spec, not just its command line: the working directory and
the environment are part of the string the rules see, because `NODE_OPTIONS`, `BASH_ENV`,
`LD_PRELOAD` and `DYLD_INSERT_LIBRARIES` load code into an otherwise innocuous command. If
you run with a permissive `terminal.default`, add a rule for them:

```jsonc
{ "pattern": "\\b(NODE_OPTIONS|BASH_ENV|LD_PRELOAD|DYLD_INSERT_LIBRARIES|PYTHONSTARTUP)=" }
```

`terminal` commands are split into sub-commands first (`&&`, `||`, `;`, `|`, `|&`, a bare
`&`, newlines, `$(...)`, backticks, subshells), and a redirection to a real file becomes its
own checked entry — and additionally a `write_file` decision — so `printf x > .env` cannot
ride on an `always_allow` of `^printf`, and `printf x >> ~/.ssh/authorized_keys` is caught by
the same rule that governs a `write`. Two cases refuse to guess instead: a command whose
**name** comes out of an expansion (`$x$y -rf ~`, `$(which rm)`) and a command the splitter
cannot read at all are floored at `confirm`, because nothing there says which program runs.
An expansion in an argument position (`echo ${HOME}`, `awk '{print $1}'`) is unaffected.

Tools with no entry in the table — `todo`, `ask`, `checkpoint`, `xd://resolve`, … — pass
through ungated. A tool that *is* in the table but was called with an argument shape this
mapping does not understand gets a `default`-only decision, never an implicit allow, and
warns once per session.

**Set a strict `default` for the tools that carry no matchable input.** `eval`,
`xd://browser`, `computer` and `xd://debug write_memory` are gated on their `default` alone,
because an arbitrary code payload, a desktop action or a memory address is not text a regex
can judge. With a global `default: allow` they are effectively open, so name them:

```jsonc
"tools": {
  "eval": { "default": "confirm" },
  "browser": { "default": "confirm" },
  "computer": { "default": "deny" },
}
```

## Confirm prompts

A `confirm` decision opens a dialog listing the virtual tool, the target, its scope, and
which rule matched:

```
omp-toolgate: confirm write_file
  reason: no rule matched, so the configured default applied
  target: src/generated/api.ts [inside]

  > Allow once
    Always allow (this project): ^src/generated/api\.ts$ — covers only src/generated/api.ts
    Always allow (this project): ^src/generated/ — covers src/generated/ and everything under it
    Always allow (this project): \.ts$ — covers every file with the .ts extension, anywhere
    Always allow (global): ^src/generated/api\.ts$ — covers only src/generated/api.ts
    Always allow (global): ^src/generated/ — covers src/generated/ and everything under it
    Always allow (global): \.ts$ — covers every file with the .ts extension, anywhere
    Deny
```

The exact path comes first, and every label states what the pattern widens to, because the
directory and extension candidates are much broader than the call being approved — one click
on `\.ts$` would permanently allow writes to every TypeScript file on the machine.

Every model-supplied string in the dialog is escaped and truncated, so a tool argument
containing newlines cannot forge extra lines below the real ones.

"Always allow" appends the chosen pattern to that file's `always_allow`, creating the file
and its directory if needed, then reloads the configuration so the pattern is live for the
rest of the session. Duplicates are not appended. The write is a temporary file plus
`rename`, and omp's own `config.yml` is never touched.

**"Always allow" is offered only when it can change the next outcome.** Since
`always_allow` is evaluated after `always_deny` and `always_confirm`, a prompt caused by an
`always_confirm` rule cannot be silenced by recording a pattern — the same rule would match
again and bring the same prompt back. In that case the dialog offers only "allow once" and
"deny", and the note names the file and the rule to edit:

```
omp-toolgate: confirm write_file
  reason: always_confirm /(^|/)\.env(\.|$)/ from global configuration
  target: .env [inside]
  note: An always_confirm rule matched, and always_allow is evaluated after it, so no
        recorded pattern can stop this prompt. To stop asking, edit the rule in
        /Users/me/.omp/agent/tool-permissions.json: /(^|/)\.env(\.|$)/.

  > Allow once
    Deny
```

The other suppressions are explained in the prompt too, rather than silently dropped:

- a symlink escape offers only "allow once" and "deny";
- so does a write to omp-toolgate's own configuration file, since recording a pattern in the
  file that holds the rules would be self-defeating;
- a target with no derivable pattern (`eval`, `fetch`, an MCP tool) offers only those two;
- "always allow (this project)" disappears when the pattern is absolute, since a project
  file must stay portable;
- a command executed by path (`./deploy.sh`, `/usr/local/bin/x`) or prefixed by an
  assignment (`PAGER=x git log`) yields no pattern at all — by design, so "always allow"
  can never be attached to an arbitrary script;
- a command whose text the shell would rewrite before running it (`$'…'`, `${x-…}`,
  `${x:0:2}`) makes the split fail, which disables `always_allow` and falls through to the
  default — the gate refuses to guess what such a command will actually run.

**Anything that is not one of the offered choices — cancel, a closed dialog — counts as a
denial.** In a session without an interactive UI (`omp -p`, a subagent, a print-mode run) a
`confirm` becomes a block whose reason says approval must happen in the parent session. It
is never an implicit allow.

## Migrating from Zed

1. Copy the `agent.tool_permissions` block out of `~/.config/zed/settings.json` into
   `~/.omp/agent/tool-permissions.json`. No rewriting: comments, trailing commas and
   `{ "pattern": ..., "case_sensitive": ... }` rules are all understood. Dropping the whole
   `settings.json` in also works, since `agent.tool_permissions` is dug out of it.
2. Optionally add the two omp-only knobs: `{ "scope": "outside" }` rules and
   `trustedProjects`.
3. Keep your `terminal` patterns for destructive commands. This matters more on omp than on
   Zed: per omp's own documentation, "in `yolo`, a bare critical override is ignored", so
   omp's built-in `rm -rf /` guard does **not** fire in the default mode. Measured on this
   machine, `rm -rf /` reaches the shell and is stopped only by `rm`'s own
   `--preserve-root` failsafe. A `\b(rm|rmdir|unlink|shred|truncate|dd|mkfs)\b` entry in
   `terminal.always_confirm` is what actually stops it.

Compatibility is one-way. `scope` and `trustedProjects` are omp-toolgate extensions; a file
carrying them is not meant to be moved back into Zed.

## Known limits

- **A shell command can write where its rules cannot see.** `write_file` rules govern the
  `write` and `edit` tools and a shell *redirection*, because a redirect target is visible in
  the command string. They cannot govern a program that opens a file itself — `tee`,
  `dd of=`, `cp`, `install`, `sed -i`, `python -c`. Gating those would mean modelling every
  program's write semantics. This is why the recommended configuration confirms the
  destructive commands by name in `terminal.always_confirm` rather than relying on path
  rules to catch a shell, and why the gate's own configuration files get a floor that also
  covers `terminal`.
- **`xd://lsp` targets are unknown.** `rename`, `rename_file`, `code_actions` and a raw
  `request` can all carry a workspace edit whose files cannot be determined from the
  arguments, so they are gated on `edit_file.default` alone. `diagnostics` is deliberately
  **not** gated: the language server compiles the project whether or not that call passes
  through the gate, so gating it would be theatre rather than protection.
- **`eval` and `xd://browser` get `default` only.** Matching command patterns against
  arbitrary Python/JavaScript produces mostly false positives (`\brm\b` hits any identifier
  containing `rm`), so these map to their own virtual tools with no inputs. Tool calls made
  *from inside* an `eval` cell are still gated individually. If you want these tools gated
  harder, set `tools.approval.eval: prompt` in omp's own config.
- **`--add-dir` roots count as `outside`.** They are reachable
  (`ctx.sessionManager.getAdditionalDirectories()` returns them), but `scope` is defined
  against `project_root` on purpose: folding additional roots into `inside` would silently
  disable the `{ "scope": "outside" }` rule that exists to compensate for omp having no
  workspace boundary.
- **ReDoS is bounded, not prevented.** Patterns from an untrusted project file are capped
  in count and length, but Node's `RegExp` has no timeout, so a catastrophic-backtracking
  pattern from a repository can still stall a decision. Use `trustedProjects` only for
  repositories you actually trust.
- **Write-back reformats the file.** Recording an "always allow" pattern re-serializes the
  whole document as JSON, so comments and hand formatting in that file are lost. Keep
  hand-written notes in the file you do not write back to, or re-add them after. Do **not**
  symlink `~/.omp/agent/tool-permissions.json` at your Zed `settings.json`: the first
  "always allow (global)" would rewrite Zed's settings as plain JSON.
- **Write-back is atomic but not locked.** Two sessions approving an "always allow" for the
  same file at the same time can lose one of the two patterns. The file is never left
  truncated; it can just be missing the older of two simultaneous additions.
- **A tightened configuration is picked up on the next reload, not immediately.** The gate
  reloads when the working directory changes and after a write-back, so editing a
  configuration file mid-session takes effect on the next session or the next reload.
- **Path comparison is exact.** The inside/outside test compares byte-for-byte, so on a
  case-insensitive filesystem `/Repo/x` counts as outside `/repo`, and an NFD spelling of an
  NFC directory name counts as a different path. Write rules with the spelling your
  filesystem reports.
- **A repository can turn the gate on.** An unparseable `<project_root>/.omp/tool-permissions.json`
  still counts as "a configuration file exists", so a user with no global configuration gets
  `default: confirm` everywhere and, in a non-interactive session, every call fails closed.
  That is the safe direction, but it means a repository can make your `omp -p` runs stop.
- **POSIX paths only.** Windows is not supported.

## Development

```bash
npm install
npm test        # vitest run
npm run typecheck   # tsc --noEmit
```

There is no build. omp loads the TypeScript sources directly, and the test suite runs the
same files. `src/types.ts` is the single shared contract; `src/project-root.ts`,
`src/config.ts`, `src/decision.ts`, `src/mapping.ts` and `src/prompt.ts` each own one
capability and are pure except where they read or write configuration files.

The reference implementation this ports from is Zed 1.15.0's
`crates/agent/src/tool_permissions.rs`; `src/decision.ts` follows its `check_commands`
function directly, and `test/decision.test.ts` carries a `zed parity` block naming the
Rust test each case mirrors.
