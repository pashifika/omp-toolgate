/**
 * `project_root` resolution and path normalization (design D3, D4, D8).
 *
 * Everything a rule is matched against goes through here first, so a raw tool
 * argument never reaches a pattern: a recognized omp selector is removed, `~` is
 * expanded, symlinks are resolved one component at a time and the result is
 * expressed relative to `project_root` when it stays inside it.
 *
 * POSIX paths only; Windows is an explicit non-goal.
 */

import { existsSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isRecord, type NormalizedPath, type PathResolver } from "./types.ts";

/**
 * The dominant marker. A `.git` file counts as much as a `.git` directory
 * because worktrees and submodules write a file containing `gitdir:`.
 */
const GIT_MARKER = ".git";

/**
 * Fallback markers, consulted only when the whole walk contained no `.git`.
 *
 * `.omp` is deliberately absent: omp's `.omp/` directories are cwd-local by
 * convention, so treating one as a marker would let `packages/foo/.omp/` claim
 * the root of a monorepo.
 */
const LANGUAGE_MARKERS: readonly string[] = [
  "go.mod",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "composer.json",
  "Gemfile",
  "mix.exs",
];

const COLON = 0x3a;
const SLASH = 0x2f;

/** One line range: `50`, `50-`, `50-200`, `50+150`. */
const RANGE = String.raw`\d+(?:-\d*|\+\d+)?`;

/** One selector component: a mode, or a comma-separated list of ranges. */
const SELECTOR_PART = `raw|conflicts|${RANGE}(?:,${RANGE})*`;

/** A whole range/mode tail, at most two components (`raw:2-4`, `2-4:raw`). */
const SELECTOR_TAIL = new RegExp(`^(?:${SELECTOR_PART})(?::(?:${SELECTOR_PART}))?$`);

/**
 * A tail made of nothing but line numbers, the one selector form that is also an
 * ordinary filename: omp writes `report:2024` to that literal name.
 */
const BARE_NUMERIC_TAIL = /^\d+(?::\d+)?$/;

/** Prefixes after which any tail, `/` included, is an archive member path. */
const ARCHIVE_SUFFIX = /\.(?:zip|tar\.gz|tar|tgz|jar|war|ear|apk)$/i;

/** Prefixes after which a `/`-free tail is a `table` or `table:key` selector. */
const SQLITE_SUFFIX = /\.(?:sqlite3|sqlite|db3|db)$/i;

/**
 * A `$` something else still has to expand: `$HOME`, `${HOME}`, `$(pwd)`, and
 * `$1` as well, because an unset name expands to nothing and leaves `/etc/passwd`
 * behind.
 */
const PENDING_EXPANSION = /\$[\w{(]/;

/**
 * How many symlinks one resolution may follow, Linux's `SYMLOOP_MAX`. A chain
 * longer than this stops resolving and leaves the remainder literal: refusing to
 * answer is not an option here, and without a cap the pair `a -> b/../a` with a
 * dangling `b` re-enters `a` forever.
 */
const MAX_LINK_HOPS = 40;

/**
 * Resolves the project root for a session.
 *
 * `OMP_PROJECT_ROOT` wins outright. Otherwise the ancestors of `cwd` are walked
 * innermost first, once for `.git` and then once for a language marker, so a
 * nearer `packages/foo/package.json` can never outrank an ancestor repository.
 * The walk stops below the home directory and never selects it; a `cwd` outside
 * the home directory walks up to the filesystem root. With nothing found the
 * root is `cwd` itself, which is also the only possible answer when `cwd` is the
 * home directory.
 */
export function resolveProjectRoot(cwd: string, env: NodeJS.ProcessEnv): string {
  const explicit = env["OMP_PROJECT_ROOT"];
  if (explicit !== undefined && explicit !== "") {
    return resolve(explicit);
  }

  const start = resolve(cwd);
  const candidates = ancestorsBelowHome(start, resolve(env["HOME"] || homedir()));

  for (const dir of candidates) {
    if (existsSync(join(dir, GIT_MARKER))) {
      return dir;
    }
  }
  for (const dir of candidates) {
    for (const marker of LANGUAGE_MARKERS) {
      if (existsSync(join(dir, marker))) {
        return dir;
      }
    }
  }
  return start;
}

/** A raw path argument split into the path itself and its omp selector. */
export interface StrippedSelector {
  readonly path: string;
  /** Selector text, without the leading `:`. `undefined` when there is none. */
  readonly selector: string | undefined;
}

/**
 * Splits omp selector syntax off a path argument.
 *
 * The cut is taken at the first `:` not immediately followed by `//`, which
 * keeps a scheme intact — `https://host/a` is returned unchanged while
 * `local://plan.md:1-10` still yields a selector — and only when the tail is
 * recognizable as one: a range or mode (`:50-200`, `:raw:2-4`), an archive
 * member after an archive suffix (`dist/app.zip:META-INF/MANIFEST.MF`), or a
 * `/`-free table selector after a SQLite suffix (`data/app.sqlite:users:42`).
 *
 * Any other tail stays in the path. omp writes a colon path it recognizes as
 * neither selector to that literal name (`omp://tools/write.md`), so cutting an
 * unknown tail would gate `x` while `x:/../../../.ssh/authorized_keys` is the
 * file created — and would shorten an ordinary `backup-12:30:45.tar` past every
 * rule written for it.
 *
 * A tail of nothing but digits is the one selector form that is also an ordinary
 * name, so it is a selector only when `prefix` names a file that already exists:
 * `notes.md:50` on an existing file is a line selector, while `report:2024` is a
 * filename and omp writes it whole. A range, a list or a mode (`50-200`,
 * `50+150`, `5-16,960-973`, `raw`, `conflicts`, `raw:2-4`) names no file and
 * needs no such check. `base` is the directory a relative `prefix` is taken
 * against, the process directory when it is omitted.
 */
export function stripSelectors(
  raw: string,
  base?: string,
  env?: NodeJS.ProcessEnv,
): StrippedSelector {
  const cut = candidateColon(raw);
  if (cut < 0) {
    return { path: raw, selector: undefined };
  }
  const prefix = raw.slice(0, cut);
  const tail = raw.slice(cut + 1);
  if (!isSelectorTail(prefix, tail, base, env)) {
    return { path: raw, selector: undefined };
  }
  return { path: prefix, selector: tail };
}

/**
 * Normalizes one raw path argument against a project root.
 *
 * Prefer {@link createPathResolver} when several arguments share a root: this
 * entry point canonicalizes `cwd` and `projectRoot` on every call.
 */
export function normalizePath(
  raw: string,
  cwd: string,
  projectRoot: string,
  env?: NodeJS.ProcessEnv,
): NormalizedPath {
  return createPathResolver(cwd, projectRoot, env)(raw);
}

/**
 * Builds a {@link PathResolver} bound to one `cwd`, `project_root` and `env`.
 *
 * Both directories are canonicalized here, once per closure. They have to be:
 * `escaped` compares the literal path with the root, so a `/var/…` spelling of a
 * `/private/var/…` directory makes every containment test false and silently
 * disables the escape floor.
 */
export function createPathResolver(
  cwd: string,
  projectRoot: string,
  env?: NodeJS.ProcessEnv,
): PathResolver {
  // A relative `cwd` or `project_root` can only mean "relative to the process".
  const processCwd = process.cwd();
  const base = walkComponents(cwd, processCwd);
  const root = walkComponents(projectRoot, processCwd);
  return (raw: string): NormalizedPath => normalizeAgainstRoot(raw, base, root, env);
}

/**
 * Canonicalizes one path into the coordinate system every containment test in
 * this package uses: symlinks resolved component by component, relative input
 * taken against the process directory.
 *
 * Exported because `src/config.ts` builds `ToolPermissions.protectedPaths` and
 * `src/decision.ts` compares those entries against a `NormalizedPath`. Two
 * spellings of one directory made that comparison silently false once already
 * (`/var/…` versus `/private/var/…`), so both sides go through this.
 */
export function canonicalizePath(target: string): string {
  return walkComponents(target, process.cwd());
}

/**
 * Normalizes against a `base` and `root` already canonicalized by
 * {@link createPathResolver}.
 *
 * `escaped` marks the case design D8 is about: the literal path is inside the
 * project but symlink resolution leaves it. The matched string is then the
 * resolved absolute path, so an `always_deny` on `(^|/)\.ssh(/|$)` still catches
 * `<repo>/config/id_rsa` when `<repo>/config` points at `~/.ssh`.
 *
 * `literal` keeps the textual reading of the same argument, so the two together
 * say both what was asked for and what would be opened.
 *
 * A `target` that still carries an unexpanded `$name`, `${…}` or `$(…)` is never
 * `inside`: a rule written for the project cannot be assumed to cover a string
 * the shell has not expanded yet. `> $HOME/.ssh/authorized_keys` reads as a
 * project-relative name and writes in the home directory, so with its literal
 * spelling inside the project it is reported as an escape — the one answer that
 * says the gate cannot tell where this lands.
 */
function normalizeAgainstRoot(
  raw: string,
  base: string,
  root: string,
  env: NodeJS.ProcessEnv | undefined,
): NormalizedPath {
  const stripped = stripSelectors(raw, base, env);
  const target = expandHome(stripped.path, env);
  const literal = resolve(base, target);
  const resolved = walkComponents(target, base);
  const unexpanded = PENDING_EXPANSION.test(target);
  const inside = !unexpanded && isWithin(resolved, root);
  return {
    path: inside ? toProjectRelative(root, resolved) : resolved,
    scope: inside ? "inside" : "outside",
    escaped: !inside && isWithin(literal, root),
    literal,
    resolved,
    selector: stripped.selector,
    unexpanded,
  };
}

/**
 * Lists `start` and its ancestors, innermost first.
 *
 * The home directory itself is excluded and terminates the walk when `start` is
 * inside it, which is why `$HOME/.git` never becomes a project root. A `start`
 * outside the home directory walks up to the filesystem root instead.
 */
function ancestorsBelowHome(start: string, home: string): readonly string[] {
  const stopAtHome = isWithin(start, home);
  const chain: string[] = [];
  let current = start;
  while (!(stopAtHome && current === home)) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return chain;
}

/**
 * Index of the first `:` that could open a selector, or `-1` when there is none.
 *
 * `://` is a scheme separator, so `https://host/a` has no candidate at all while
 * `local://plan.md:1-10` finds the colon after the path.
 */
function candidateColon(raw: string): number {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) !== COLON) {
      continue;
    }
    if (raw.charCodeAt(i + 1) === SLASH && raw.charCodeAt(i + 2) === SLASH) {
      i += 2;
      continue;
    }
    return i;
  }
  return -1;
}

/**
 * Whether the text after the colon is a selector rather than part of the name.
 *
 * An empty tail is a trailing colon in a filename, never a selector. A tail
 * holding a `/` is one only inside an archive, where it is a member path.
 *
 * A tail of nothing but digits is a selector only on a file that already exists:
 * `report:2024` is a filename, `notes.md:50` on a real file is a line range.
 */
function isSelectorTail(
  prefix: string,
  tail: string,
  base: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
): boolean {
  if (tail === "") {
    return false;
  }
  if (ARCHIVE_SUFFIX.test(prefix)) {
    return true;
  }
  if (tail.includes("/")) {
    return false;
  }
  if (SQLITE_SUFFIX.test(prefix)) {
    return true;
  }
  if (!SELECTOR_TAIL.test(tail)) {
    return false;
  }
  if (!BARE_NUMERIC_TAIL.test(tail)) {
    return true;
  }
  // A range or a mode names no file, a bare number does: the tail is a selector
  // only on a file that is already there to be read by line. `statSync` throws
  // for everything else, a missing name included, which is the answer.
  try {
    return statSync(resolve(base ?? process.cwd(), expandHome(prefix, env))).isFile();
  } catch {
    return false;
  }
}

/** Expands a leading `~` or `~/`. `~user` is a non-goal and stays literal. */
function expandHome(target: string, env: NodeJS.ProcessEnv | undefined): string {
  if (target !== "~" && !target.startsWith("~/")) {
    return target;
  }
  // An empty HOME must fall back, not expand to "": `resolve("")` is the process
  // working directory, which would place a home path inside the project.
  const home = env?.["HOME"] || homedir();
  return target === "~" ? home : join(home, target.slice(2));
}

/**
 * Resolves `target` component by component from `base`, following each symlink
 * before the next component is applied. `base` matters only for a relative
 * `target`.
 *
 * This is the path the kernel will open. `path.resolve` collapses `link/..`
 * textually and never sees the symlink, so a path that leaves the project
 * through one is reported as staying inside it. Resolution stops at the first
 * component that cannot be resolved and the remainder is joined as written, so
 * a file whose parents do not exist yet still normalizes.
 *
 * A dangling link's own target is resolved through this same walk, `hops` deep at
 * most, so a chain of links and the directories behind them all end up resolved.
 */
function walkComponents(target: string, base: string, hops: number = MAX_LINK_HOPS): string {
  let current = isAbsolute(target) ? sep : base;
  let resolving = true;
  for (const part of target.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      current = dirname(current);
      continue;
    }
    const joined = join(current, part);
    if (!resolving) {
      current = joined;
      continue;
    }
    try {
      current = realpathSync(joined);
    } catch (error) {
      const code = isRecord(error) ? error["code"] : undefined;
      // A dangling symlink still names where a write lands: `open(…, O_CREAT)`
      // creates the link's target, not the link. `realpathSync` refuses it, so
      // read the link and resolve its own target through this same walk: adopted
      // as written, a directory link on the way to that target would stay
      // unresolved and a rule written for the real file would miss it.
      const linked = code === "ENOENT" ? readLink(joined) : undefined;
      if (linked !== undefined && hops > 0) {
        current = walkComponents(linked, current, hops - 1);
        continue;
      }
      // A component that cannot exist has no symlink to follow, so the rest is
      // taken as written and a later `..` may resume in existing territory. Any
      // other failure (EACCES, ELOOP), and a chain past `MAX_LINK_HOPS`, means
      // the target cannot be named at all: stop resolving rather than pass a
      // literal spelling off as canonical.
      current = joined;
      resolving = linked === undefined && (code === "ENOENT" || code === "ENOTDIR");
    }
  }
  return current;
}

/**
 * The literal target of `candidate` when it is a symlink, `undefined` when it is
 * not a link at all. A relative target stays as written: the caller resolves it
 * against the link's own directory, which is where the kernel reads it from.
 */
function readLink(candidate: string): string | undefined {
  try {
    return readlinkSync(candidate);
  } catch {
    return undefined;
  }
}

/** Expresses `target` relative to `root`; the root itself becomes `""`. */
function toProjectRelative(root: string, target: string): string {
  if (target === root) {
    return "";
  }
  const rel = relative(root, target);
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/**
 * Tests containment on path boundaries, not string prefixes, so `/repo-2/x` is
 * not inside `/repo`.
 */
function isWithin(target: string, base: string): boolean {
  if (target === base) {
    return true;
  }
  const rel = relative(base, target);
  if (rel === "" || isAbsolute(rel)) {
    return false;
  }
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}
