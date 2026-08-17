# omp-toolgate

Applies Zed-style regular-expression permissions to [omp](https://github.com/oh-my-pi) tool calls and makes filesystem decisions relative to a `project_root` boundary.

omp's native approval combines a tier (`read`, `write`, or `exec`) with a mode (`always-ask`, `write`, or `yolo`), plus glob patterns for `bash`. It cannot express policies such as “confirm writes to `.env` and `*.pem`.” Its `write` and `edit` tools also have no workspace boundary, so under the default `approvalMode: yolo`, a tool call can create or delete a file anywhere without prompting.

omp-toolgate fills those gaps through one `tool_call` interceptor. The `project_root` is the session boundary used to classify paths as inside or outside the current project.

## Highlights

- **Drop-in configuration:** accepts optional JSONC files, including a complete Zed `settings.json`.
- **Predictable decisions:** checks deny rules against any input, requires allow rules to cover every input, and applies the strictest result when one call has several operations.
- **Broad tool coverage:** maps omp file, shell, debug, agent, search, skill, browser, desktop, and MCP operations onto configurable virtual tool names.
- **Repository-safe overrides:** treats committed project configuration as untrusted and allows it to tighten global policy without silently weakening it.
- **Explainable confirmation:** shows what matched, offers narrowly scoped persistent choices when safe, and fails closed when interactive approval is unavailable.

## Contents

- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [`project_root` and path normalization](#project_root-and-path-normalization)
- [Project files can only tighten](#project-files-can-only-tighten)
- [Virtual tool names](#virtual-tool-names)
- [Confirm prompts](#confirm-prompts)
- [Migrating from Zed](#migrating-from-zed)
- [Known limits](#known-limits)
- [Requirements](#requirements)
- [Development](#development)
- [License](#license)

## Install

Install the v1.0.0 release directly from GitHub:

```bash
omp plugin install 'github:pashifika/omp-toolgate#v1.0.0'
```

Alternatively, add this repository's marketplace catalog. This route also enables `omp plugin discover` and `omp plugin upgrade`:

```bash
omp plugin marketplace add pashifika/omp-toolgate
omp plugin install omp-toolgate@omp-toolgate
```

Remove an installation with the command for its route:

```bash
omp plugin uninstall omp-toolgate                 # route 1
omp plugin uninstall omp-toolgate@omp-toolgate    # route 2
```

## Quick start

Save this minimal policy as `~/.omp/agent/tool-permissions.json`. It allows calls by default but requires confirmation before writing `.env` anywhere in the project:

```jsonc
{
  "default": "allow",
  "tools": {
    "write_file": {
      "always_confirm": [
        { "pattern": "(^|/)\\.env$" },
      ],
    },
  },
}
```

Verify that the extension is active:

```bash
omp -p "call the write tool with path .env and content X=1"
```

Because `omp -p` has no interactive UI, a live installation blocks this call and reports that `write_file` requires approval in the parent interactive session.

## Configuration

omp-toolgate reads two optional configuration files:

| Scope | Path |
| --- | --- |
| Global | `~/.omp/agent/tool-permissions.json` |
| Project | `<project_root>/.omp/tool-permissions.json` |

`PI_CODING_AGENT_DIR` relocates the global file. `omp --profile <name>` does not: the path always uses the default agent directory or `PI_CODING_AGENT_DIR`.

If neither file exists, omp-toolgate does nothing and omp behaves exactly as it would without the extension. A configuration file must exist to activate the gate.

Both files use JSONC, so comments and trailing commas are accepted. omp-toolgate tries three document shapes in this order.

A complete Zed settings document:

```jsonc
{
  "agent": {
    "tool_permissions": {
      "default": "allow",
      "tools": {},
    },
  },
}
```

A root-level `tool_permissions` block:

```jsonc
{
  "tool_permissions": {
    "default": "allow",
    "tools": {},
  },
}
```

The permissions block by itself:

```jsonc
{
  "default": "allow",
  "tools": {},
}
```

### A baseline to start from

[`samples/tool-permissions.json`](samples/tool-permissions.json) is a complete policy that goes further than the Quick start: it confirms writes and reads over credential paths, writes outside `project_root`, `eval` and `browser`, the shell programs that open files themselves, environment-variable injection, and credential-management and exfiltration commands. Copy it to `~/.omp/agent/tool-permissions.json` and it works unedited.

It is a starting point to trim, not a guarantee. Its header states the posture, which rules to delete first when confirmations get noisy, and what it does not cover — search tools, MCP tools, and anything a program decides at run time rather than in the text of its arguments. Read the [Known limits](#known-limits) before relying on it. `test/samples.test.ts` holds the file to the decisions it advertises, so a weakened baseline fails the suite.

### Rule shape

A complete configuration can set a global default, trusted projects, and rules for individual virtual tools:

```jsonc
{
  "default": "confirm",
  "trustedProjects": ["/Users/me/Work/*"],
  "tools": {
    "write_file": {
      "default": "allow",
      "always_deny": [
        { "pattern": "(^|/)\\.(ssh|aws)(/|$)" },
      ],
      "always_confirm": [
        { "scope": "outside" },
      ],
      "always_allow": [
        { "pattern": "^dist/" },
      ],
    },
  },
}
```

The accepted permission modes are `allow`, `confirm`, and `deny`. Omitting the global default implies `confirm` when at least one configuration file exists. Omitting a virtual tool's default makes it inherit the global default. `default_mode` is also accepted as a Zed-compatible alias for `default`.

A rule can be an object:

```jsonc
{
  "pattern": "(^|/)\\.env$",
  "case_sensitive": false,
  "scope": "inside",
}
```

It can also use a bare string as shorthand for its pattern:

```jsonc
"(^|/)\\.env$"
```

`case_sensitive` defaults to `false`. The `scope` field is an omp-toolgate extension with three values:

| Scope | Matches |
| --- | --- |
| `inside` | Paths inside `project_root` |
| `outside` | Paths outside `project_root` |
| `any` | Any location; this is the default |

A scope-only rule matches by location. When a rule has both `pattern` and `scope`, both conditions must match. An explicit `inside` or `outside` scope never matches non-path inputs such as commands, URLs, or queries.

### Decision order

omp-toolgate evaluates a virtual tool in this order:

1. If any pattern for that virtual tool fails to compile, every call to the tool is denied.
2. A symlink escape raises an `allow` result to `confirm`. Configuration cannot disable this floor.
3. A write to either omp-toolgate configuration file raises `allow` to `confirm`. Configuration cannot disable this floor.
4. `always_deny` denies immediately when any input matches.
5. `always_confirm` prompts when any input matches.
6. `always_allow` allows only when every input matches at least one allow rule. For example, `^ls` alone cannot allow `ls && rm -rf build`.
7. The virtual tool's `default` applies.
8. The global `default` applies.

This ANY/ALL asymmetry comes from Zed: one denied or confirmed input decides the call, while every input must be covered before an allow rule decides it.

When one real call maps to several virtual tools, omp-toolgate evaluates each one independently and keeps the strictest result: `deny` beats `confirm`, and `confirm` beats `allow`. One `edit` payload can edit, delete, and move files at once, so its result is `deny` if any mapped operation denies, `confirm` if any operation confirms, and `allow` only when every operation allows.

## `project_root` and path normalization

omp-toolgate resolves `project_root` once per session in this order:

1. `OMP_PROJECT_ROOT`.
2. The nearest ancestor containing a `.git` file or directory.
3. The nearest ancestor containing one of these language markers: `go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, `build.gradle`, `build.gradle.kts`, `composer.json`, `Gemfile`, or `mix.exs`.
4. The working directory.

The ancestor walk never crosses `$HOME` and never selects `$HOME` itself. A `.git` file counts because worktrees and submodules use one.

The `.omp` directory is deliberately not a project marker. omp treats `.omp` directories as working-directory-local, so allowing `packages/api/.omp` to select a root could hijack the boundary of a monorepo.

Before a pattern sees a path, omp-toolgate normalizes it in this order:

1. It strips an omp selector only when the tail is recognized:
   - a range or mode such as `main.ts:50-200`, `main.ts:raw`, or `main.ts:5-16,960-973`;
   - an archive member when the prefix has an archive suffix, such as `app.zip:inner/x`;
   - a SQLite table or row when the prefix has a database suffix, such as `db.sqlite:users:42`.

   Any other colon stays in the path. omp writes an unrecognized colon path as an ordinary filename, so `backup-12:30:45.tar` must be judged whole.
2. It expands `~` and makes the path absolute against the working directory. The working directory is canonicalized first so later comparisons use the same coordinates.
3. It resolves symlinks component by component from left to right. A `..` therefore applies to the directory a symlink points to, matching kernel behavior instead of collapsing the string first. Once a component does not exist, the remaining components are joined literally so paths whose parents have not been created still work.
4. It expresses an inside path relative to `project_root` without a leading `./`. An outside path stays absolute. Separators are always `/`.

Patterns match the resulting project-relative or absolute path. Zed's defensive `(^|/)` prefix therefore continues to work:

- `(^|/)\.env$` matches `.env` and `config/.env`.
- `(^|/)\.(ssh|aws)(/|$)` matches an outside path such as `/Users/me/.ssh/id_rsa`.

### Symlink escapes

A symlink escape occurs when the literal path is inside `project_root` but its resolved target is outside.

omp-toolgate promotes such a call to at least `confirm`, even when its effective default or an `always_allow` rule says `allow`. The prompt shows both the literal path and the resolved target. A repository containing `config -> ~/.ssh` therefore cannot silently write through `config`.

A matching `always_deny` still wins.

## Project files can only tighten

The project file at `<project_root>/.omp/tool-permissions.json` is commonly committed to a repository, so omp-toolgate treats it as third-party input. Unless the global configuration explicitly trusts the project, the merge only tightens policy:

- `always_deny` is a union, so project configuration can add refusals but never remove a global one.
- `always_confirm` is a union too, with one exception: for a virtual tool that would `deny` without the project file, the project's `always_confirm` list is discarded and reported. `always_confirm` outranks every `default`, so keeping it there would turn a refusal into a prompt. Against an `allow` or `confirm` baseline a prompt is a tightening, so the list survives.
- An untrusted project's `always_allow` list is discarded outright. A warning names the virtual tool and the number of discarded rules.
- Global and per-tool defaults use the stricter value.
- Global and project virtual-tool keys are unioned.

Both discards exist for the same reason: `always_allow` and `always_confirm` are evaluated ahead of every `default`. One committed allow rule would otherwise lift a global `confirm` or `deny` default to `allow`, and one committed confirm rule would lower a `deny` to a prompt. A tightening-only file has no legitimate use for either.

To permit normal hierarchical overrides, list the project root in the global file's `trustedProjects` array:

```jsonc
{
  "trustedProjects": [
    "/Users/me/Work/*",
    "/Users/me/Source/**",
  ],
}
```

Entries must be absolute paths or absolute globs. The supported glob operators are `*`, `**`, and `?`. A relative entry, including one beginning with `~`, is ignored and reported.

Only the global file can establish trust. A `trustedProjects` key inside a project file is ignored, so a repository cannot declare itself trustworthy.

A trusted project overrides rather than appends: a rule list it mentions replaces the global list for that virtual tool, and a list it mentions as empty clears the global one. A list it does not mention keeps the global rules.

Untrusted project files are also limited to:

- 64 rules per virtual tool across the surviving rule lists.
- 512 characters per pattern.

Anything beyond those limits is dropped and reported at session start. The global file and trusted project files are not capped.

## Virtual tool names

omp's tool surface is wider than Zed's and has no `delete_path` tool. omp-toolgate maps real calls onto Zed-style virtual tool names according to the real tool and operation:

| Real call | Virtual tool | Checked input |
| --- | --- | --- |
| `write` | `write_file` | normalized path |
| `write` to `db.sqlite:table:key` with empty content | `delete_path` | the database file |
| `edit` section with `PUT` / `CUT` | `edit_file` | the section's path |
| `edit` section with `REM` | `delete_path` | the section's path |
| `edit` section with `MV DEST` | `move_path` | source and destination |
| `read` | `read_file` | normalized path |
| `read` of an `http(s)` URL | `fetch` | the URL |
| `read` of `skill://<name>` | `skill` | the skill's `SKILL.md` |
| `glob` | `find_path` | each search root |
| `grep`, `xd://ast_grep` | `grep` | the pattern and each search root |
| `xd://ast_edit` | `edit_file` | each element of `paths` |
| `bash` | `terminal` | the command |
| `hub` with `op: "start"` | `terminal` | `PWD=<cwd> NAME=value … application args` |
| `hub` with `op: "send"` | `terminal` | the `text` written to the process |
| `xd://debug` `launch` / `attach` | `terminal` | the same launch-spec shape |
| `xd://debug` `evaluate` / `custom_request` | `terminal` | the expression or command |
| `xd://debug` `write_memory`, breakpoint conditions | `terminal` | the condition; none for a raw write |
| `task` | `spawn_agent` | `agent` and task text |
| `web_search` | `web_search` | the query |
| `manage_skill` create / update / delete | `write_file` / `delete_path` | the skill's `SKILL.md` |
| `learn` writing a skill | `write_file` | the skill's `SKILL.md` |
| `memory_edit` forget | `delete_path` | the memory id |
| `write` to a writable scheme (`ssh://`, `vault://`, unknown) | `write_file` | the whole URI, scope `outside` |
| `eval`, `xd://browser`, `computer`, `xd://lsp` edit actions | `eval` / `browser` / `computer` / `edit_file` | none — `default` only |
| `mcp__<server>__<tool>` | `mcp:<server>:<tool>` | every string argument |

Both `mcp__server__tool` and `mcp:server:tool` work as configuration keys.

That table is the complete set of names a rule can ever gate. A `tools` key outside it — `create_directory` and `copy_path`, which exist only in the protected-path floor, or a name from a newer omp than the one installed — is reported once at session start as a key no call maps to. The rest of the configuration loads and applies normally: omp's tool surface grows, and a name that is not real yet is not an error.

### Launch specifications

A launch is judged on its whole specification, not only its command line. The working directory and environment are part of the string seen by `terminal` rules because variables such as `NODE_OPTIONS`, `BASH_ENV`, `LD_PRELOAD`, and `DYLD_INSERT_LIBRARIES` can load code into an otherwise innocuous command.

When `terminal.default` is permissive, add a rule for those variables:

```jsonc
{
  "pattern": "\\b(NODE_OPTIONS|BASH_ENV|LD_PRELOAD|DYLD_INSERT_LIBRARIES|PYTHONSTARTUP)="
}
```

### Shell commands and redirections

Before applying rules, omp-toolgate splits `terminal` commands at:

- `&&`, `||`, `;`, `|`, and `|&`;
- a bare `&`;
- newlines;
- command substitutions using `$(...)` or backticks;
- subshells.

It unquotes and rejoins words so quoting cannot hide a command name from a pattern.

A redirection to a real file becomes its own checked `terminal` input and an additional `write_file` decision. Therefore:

- `printf x > .env` cannot rely on an `always_allow` rule for `^printf`.
- `printf x >> ~/.ssh/authorized_keys` is checked by the same path rule as a direct `write`.

Read redirections remain `terminal` inputs but do not become `write_file` calls. File-descriptor duplication, here-documents, here-strings, and redirections to `/dev/null` do not add a file target.

Two cases refuse to guess and are floored at `confirm` when a permissive result would otherwise allow them:

- the command name comes from an expansion, such as `$x$y -rf ~` or `$(which rm)`;
- the splitter cannot determine what the shell will run.

An expansion in argument position, such as `echo ${HOME}` or `awk '{print $1}'`, does not hide the command name and remains eligible for normal matching.

### Ungated and default-only tools

A tool without a mapping, such as `todo`, `ask`, `checkpoint`, or `xd://resolve`, passes through ungated.

Any mapped tool called with an argument shape omp-toolgate does not understand gets a default-only decision rather than an implicit allow. When the real tool is `write`, `edit`, `bash`, or `read`, it also reports the unrecognized shape once per session, so a silent hole becomes visible.

Set explicit defaults for virtual tools that carry no matchable input. Arbitrary code, desktop actions, and memory addresses are not text a regular expression can reliably judge:

```jsonc
{
  "tools": {
    "eval": {
      "default": "confirm",
    },
    "browser": {
      "default": "confirm",
    },
    "computer": {
      "default": "deny",
    },
  },
}
```

With a global `default: allow`, these tools are otherwise effectively open.

## Confirm prompts

A `confirm` decision opens an interactive dialog. It lists the virtual tool, every target and scope, and the rule or default that caused the decision.

For a project listed in `trustedProjects`, a path confirmation can look like this:

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

The exact path comes first. Every persistent option states what its pattern covers because the directory and extension choices are much broader than the current call. Choosing `\.ts$`, for example, permanently allows the matching operation on every TypeScript file.

Every model-supplied string is escaped and truncated before display. Newlines and control characters in a tool argument cannot forge extra dialog lines or push the real explanation out of view.

### Recording an allow rule

“Always allow” appends the chosen pattern to the selected file's `always_allow` list. omp-toolgate creates the file and directory when needed, avoids duplicates, and reloads the configuration so the rule applies for the rest of the session.

The write uses a temporary file followed by `rename`. It never modifies omp's `config.yml`.

Project-side “always allow” choices are offered only for trusted projects. An untrusted project's allow rules would be discarded during loading, so the dialog offers global recording instead.

### Suppressed choices

“Always allow” appears only when the recorded pattern could change the next outcome. Otherwise the dialog explains why and offers only safe choices.

The following cases suppress persistent choices:

- A symlink escape offers only “Allow once” and “Deny.”
- A write to omp-toolgate's own configuration offers only those choices because recording an allow pattern in the file holding the rules would be self-defeating.
- A command the splitter cannot read offers only those choices because no recorded pattern can describe what the shell will run.
- A path with an unexpanded shell expression offers only those choices because its destination is unknown.
- A virtual tool with no derivable pattern, such as `eval`, `fetch`, or an MCP tool, offers only those choices.
- An `always_confirm` rule cannot be silenced by `always_allow`, which is evaluated later. The prompt names the configuration file and rule that must be edited.
- A project choice is omitted when its candidate pattern is absolute because project files must remain portable.
- All project choices are omitted when the project is not listed in the global file's `trustedProjects`.
- A command executed by path, such as `./deploy.sh` or `/usr/local/bin/x`, yields no persistent command pattern.
- An assignment-prefixed command such as `PAGER=x git log` also yields no persistent command pattern.
- Shell syntax that rewrites its own text, including `$'…'`, `${x-…}`, and `${x:0:2}`, makes the split fail. The gate refuses to guess what the shell will run.

When an `always_confirm` rule caused the prompt, the dialog explains the precedence directly:

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

Anything other than an offered choice counts as denial, including canceling or closing the dialog.

A session without an interactive UI, including `omp -p`, a subagent, or another print-mode run, cannot approve a `confirm` decision. The call is blocked and the reason says approval must happen in the parent interactive session. Confirmation never becomes an implicit allow.

A blocked call's reason names the configuration file that decision actually came from: the project file for a project rule, the global file for a global rule, both loaded files when only a `default` applied, and the file holding a pattern that failed to compile. The decision floors configuration cannot disable — a symlink escape, a write to omp-toolgate's own configuration, an unexpanded target, an unreadable command — name no file, and say so, because editing one would not lift them.

If the gate itself fails while evaluating a call, it blocks that call and reports the failure instead of silently opening the gate.

## Migrating from Zed

1. Copy the `agent.tool_permissions` block from `~/.config/zed/settings.json` to `~/.omp/agent/tool-permissions.json`. Comments, trailing commas, and `{ "pattern": ..., "case_sensitive": ... }` rules work without rewriting. Copying the complete `settings.json` also works because omp-toolgate finds the nested block.
2. Optionally add omp-toolgate's two extensions: `{ "scope": "outside" }` rules and `trustedProjects`.
3. Keep `terminal` patterns for destructive commands. This matters more under omp's default `yolo` mode: according to omp's documentation, “in `yolo`, a bare critical override is ignored.” Its built-in `rm -rf /` guard therefore does not fire in that mode. On the machine used to verify this behavior, the command reached the shell and only `rm`'s own `--preserve-root` failsafe stopped it.

A practical destructive-command rule is:

```jsonc
{
  "pattern": "\\b(rm|rmdir|unlink|shred|truncate|dd|mkfs)\\b"
}
```

Place it in `terminal.always_confirm`.

Compatibility is one-way. Zed does not understand omp-toolgate's `scope` or `trustedProjects` fields, so a file using them is not intended to move back into Zed.

## Known limits

- **A shell command can write where path rules cannot see.** `write_file` rules govern the `write` and `edit` tools and shell redirections because their targets are visible. They cannot govern a program that opens a file itself, including `tee`, `dd of=`, `cp`, `install`, `sed -i`, or `python -c`. Supporting that would require modeling every program's write semantics. Confirm destructive programs by name in `terminal.always_confirm` instead of relying on path rules to catch them. omp-toolgate applies a separate confirmation floor to writes involving its own configuration files, including `terminal` commands.

- **`xd://lsp` targets are unknown.** `rename`, `rename_file`, `code_actions`, and raw `request` operations can carry workspace edits whose files cannot be determined from their arguments. They use `edit_file.default` alone. `diagnostics` is deliberately ungated because the language server compiles the project whether or not the call passes through omp-toolgate.

- **`eval` and `xd://browser` use defaults only.** Matching command patterns against arbitrary Python or JavaScript produces mostly false positives; for example, `\brm\b` can match identifiers rather than shell commands. These operations map to their own virtual tools without inputs. Tool calls made from inside an `eval` cell are still gated individually. To gate `eval` more strictly, set `tools.approval.eval: prompt` in omp's own configuration.

- **`--add-dir` roots count as outside.** Additional directories are reachable through `ctx.sessionManager.getAdditionalDirectories()`, but `scope` is intentionally defined only against `project_root`. Treating additional roots as inside would silently disable the `{ "scope": "outside" }` rule that compensates for omp's missing workspace boundary.

- **ReDoS is bounded, not prevented.** Untrusted project patterns are capped in count and length, but neither Node's nor Bun's `RegExp` has a timeout. A catastrophic-backtracking pattern from a repository can still stall a decision. Use `trustedProjects` only for repositories you trust. The global file is not capped at all, so the same care applies to patterns you write by hand. Two shapes have already been measured stalling this gate: `\S+=\S*`, which can split one shell word at any `=` where `[^\s=]+=\S*` cannot, and two greedy `[^\n]*` scans in one pattern, whose cost grows cubically — put the first scan in a lookahead, which is atomic. `test/samples.test.ts` times every rule in the published sample against input built from that rule's own words for exactly this reason.

- **Write-back reformats the file.** Recording an “always allow” rule serializes the complete document as JSON, removing comments and hand formatting. Keep handwritten notes in a file that is not written back, or restore them afterward. This bites hardest on a copy of [`samples/tool-permissions.json`](samples/tool-permissions.json): every explanatory comment in it is gone after the first “always allow (global)”, so keep the pristine copy or choose “this project” instead, which writes the project file. Do not symlink `~/.omp/agent/tool-permissions.json` to your Zed `settings.json`: the first global write-back would rewrite the Zed file as plain JSON.

- **Write-back is atomic but not locked.** Two sessions recording patterns in the same file at the same time can lose one pattern. The file is never left truncated, but it may be missing the older of two simultaneous additions.

- **Manual changes apply on the next reload.** The gate reloads when the working directory changes and after its own write-back. Tightening a configuration manually during a session takes effect in the next session or at the next reload, not immediately.

- **Path comparison is exact.** Inside/outside checks compare paths byte for byte. On a case-insensitive filesystem, `/Repo/x` counts as outside `/repo`. An NFD spelling of an NFC directory name also counts as a different path. Write rules using the spelling reported by the filesystem.

- **A repository can turn the gate on.** An unparseable `<project_root>/.omp/tool-permissions.json` still means a configuration file exists. With no global configuration, the effective default becomes `confirm` everywhere. In a non-interactive session, every such call fails closed, so a repository can cause `omp -p` runs to stop.

- **POSIX paths only.** Windows is not supported.

## Requirements

- omp.
- POSIX path semantics; Windows is unsupported.
- omp's default `tools.approvalMode: yolo` is the intended operating mode. Under a non-`yolo` mode, omp-toolgate and omp's own approval gate both run, so the same call can prompt twice: first from omp-toolgate, then from omp.
- Node.js 22 or later, or Bun 1.3 or later, for development.

omp loads `src/index.ts` directly from `package.json#omp.extensions`; the package has no build step.

## Development

For local development, link a working copy, place it in the extension directory, or load it for one session:

```bash
omp plugin link /path/to/omp-toolgate                       # symlink a working copy
mkdir -p ~/.omp/agent/extensions                            # or place it in the extensions dir
ln -s /path/to/omp-toolgate ~/.omp/agent/extensions/omp-toolgate
omp -e /path/to/omp-toolgate/src/index.ts                   # one session only
```

Install dependencies and run the checks:

```bash
npm install
npm test        # vitest run
npm run typecheck   # tsc --noEmit
```

The suite is seven Vitest files of over 600 tests, plus `tsc --noEmit` type checking. There is no build; tests execute the same TypeScript sources that omp loads. `test/samples.test.ts` loads `samples/tool-permissions.json` through the real loader, so the published baseline fails the suite if it stops producing the decisions it advertises or if a rule in it starts costing more than a bounded amount of time to evaluate.

`src/index.ts` default-exports the `ompToolgate(pi)` factory and registers the extension. The remaining modules each own one part of the gate:

| Module | Responsibility |
| --- | --- |
| `src/types.ts` | Shared configuration, decision, path, and mapping contracts |
| `src/project-root.ts` | Project-root discovery and path normalization |
| `src/config.ts` | Configuration discovery, validation, compilation, merging, and limits |
| `src/decision.ts` | Rule evaluation and shell-command splitting |
| `src/mapping.ts` | Real-to-virtual tool mapping |
| `src/prompt.ts` | Confirmation plans and persistent allow-rule write-back |

The reference implementation is Zed 1.15.0's `crates/agent/src/tool_permissions.rs`. `src/decision.ts` follows its `check_commands` behavior, and `test/decision.test.ts` contains a `zed parity` block that names the corresponding Rust tests.

## License

omp-toolgate is licensed under the MIT License. See [LICENSE](LICENSE).
