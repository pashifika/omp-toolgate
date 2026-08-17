/**
 * `project_root` resolution and path normalization (design D3, D4, D8).
 *
 * Everything a rule is matched against goes through here first, so a raw tool
 * argument never reaches a pattern: `..` is collapsed, `~` is expanded, omp
 * selector syntax is removed, symlinks are resolved and the result is expressed
 * relative to `project_root` when it stays inside it.
 *
 * POSIX paths only; Windows is an explicit non-goal.
 */

import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { NormalizedPath, PathResolver, PathScope } from "./types.ts";

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
  const candidates = ancestorsBelowHome(start, resolve(env["HOME"] ?? homedir()));

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
 * The cut happens at the first `:` that is not immediately followed by `//`,
 * which covers every selector family with one rule: archive members
 * (`dist/app.zip:META-INF/MANIFEST.MF`), SQLite (`data/app.sqlite:users:42`) and
 * line ranges (`src/main.ts:50-200`, `:raw`, `:5-16,960-973`). Skipping `://`
 * keeps a scheme intact, so `https://host/a` is returned unchanged while an
 * internal URL still accepts a selector (`local://plan.md:1-10`).
 */
export function stripSelectors(raw: string): StrippedSelector {
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) !== COLON) {
      continue;
    }
    if (raw.charCodeAt(i + 1) === SLASH && raw.charCodeAt(i + 2) === SLASH) {
      i += 2;
      continue;
    }
    return { path: raw.slice(0, i), selector: raw.slice(i + 1) };
  }
  return { path: raw, selector: undefined };
}

/**
 * Normalizes one raw path argument against a project root.
 *
 * Prefer {@link createPathResolver} when several arguments share a root: this
 * entry point canonicalizes `projectRoot` on every call.
 */
export function normalizePath(
  raw: string,
  cwd: string,
  projectRoot: string,
  env?: NodeJS.ProcessEnv,
): NormalizedPath {
  return normalizeAgainstRoot(raw, resolve(cwd), realpathDeepest(resolve(projectRoot)), env);
}

/**
 * Builds a {@link PathResolver} bound to one `cwd`, `project_root` and `env`.
 *
 * The project root is canonicalized once here, not per call.
 */
export function createPathResolver(
  cwd: string,
  projectRoot: string,
  env?: NodeJS.ProcessEnv,
): PathResolver {
  const base = resolve(cwd);
  const root = realpathDeepest(resolve(projectRoot));
  return (raw: string): NormalizedPath => normalizeAgainstRoot(raw, base, root, env);
}

/**
 * Normalizes against an already resolved `cwd` and an already canonicalized
 * `root`.
 *
 * `escaped` marks the case design D8 is about: the literal path is inside the
 * project but symlink resolution leaves it. The matched string is then the
 * resolved absolute path, so an `always_deny` on `(^|/)\.ssh(/|$)` still catches
 * `<repo>/config/id_rsa` when `<repo>/config` points at `~/.ssh`.
 */
function normalizeAgainstRoot(
  raw: string,
  cwd: string,
  root: string,
  env: NodeJS.ProcessEnv | undefined,
): NormalizedPath {
  const stripped = stripSelectors(raw);
  const literal = resolve(cwd, expandHome(stripped.path, env));
  const resolved = realpathDeepest(literal);
  const inside = isWithin(resolved, root);
  const scope: PathScope = inside ? "inside" : "outside";
  return {
    path: inside ? toProjectRelative(root, resolved) : resolved,
    scope,
    escaped: !inside && isWithin(literal, root),
    literal,
    resolved,
    selector: stripped.selector,
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

/** Expands a leading `~` or `~/`. `~user` is a non-goal and stays literal. */
function expandHome(target: string, env: NodeJS.ProcessEnv | undefined): string {
  if (target !== "~" && !target.startsWith("~/")) {
    return target;
  }
  const home = env?.["HOME"] ?? homedir();
  return target === "~" ? home : join(home, target.slice(2));
}

/**
 * Resolves symlinks as far as the filesystem allows.
 *
 * The deepest existing ancestor is passed through `realpath` and the remaining
 * segments are re-joined, so a path whose parents do not exist yet still
 * normalizes. An unreadable ancestor degrades to the literal path rather than
 * throwing.
 */
function realpathDeepest(absolute: string): string {
  let current = absolute;
  const pending: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      if (pending.length === 0) {
        return real;
      }
      pending.reverse();
      return join(real, ...pending);
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return absolute;
      }
      pending.push(basename(current));
      current = parent;
    }
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
