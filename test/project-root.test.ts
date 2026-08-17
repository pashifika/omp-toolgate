import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  createPathResolver,
  normalizePath,
  resolveProjectRoot,
  stripSelectors,
} from "../src/project-root.ts";

/**
 * One real directory tree for the whole file, built at module load because the
 * `it.each` rows below are data and need the fixture paths at collection time.
 *
 * `realpathSync` is applied to the temporary directory because macOS resolves
 * `/var` to `/private/var`; without it every expected path would differ from the
 * normalized one by that prefix. All fixture paths are therefore canonical, so
 * only the symlinks created below make `realpath` observable.
 *
 * `<base>/home` acts as `$HOME`, which keeps the "walk stops below the home
 * directory" fixtures separate from `<base>/elsewhere`, a tree that is not under
 * the home directory at all.
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), "toolgate-project-root-")));
const home = join(base, "home");
const proj = join(base, "proj");
const env: NodeJS.ProcessEnv = { HOME: home };
const explicitEnv: NodeJS.ProcessEnv = { HOME: home, OMP_PROJECT_ROOT: "/tmp/explicit" };
const blankEnv: NodeJS.ProcessEnv = { HOME: home, OMP_PROJECT_ROOT: "" };

for (const directory of [
  "home/.git",
  "home/repo/.git",
  "home/repo/packages/foo/src",
  "home/repo/packages/foo/.omp",
  "home/repo/examples/zed-1.15.0/crates",
  "home/repo/vendor/inner/.git",
  "home/repo/vendor/inner/src",
  "home/wt/sub",
  "home/scratch/notes",
  "home/nogit/pkg/.omp",
  "home/.ssh",
  "elsewhere/repo/.git",
  "elsewhere/repo/sub",
  "proj/src",
  "proj/config",
  "proj/data",
  "proj/dist",
  "proj-2",
]) {
  mkdirSync(join(base, directory), { recursive: true });
}

for (const file of [
  "home/repo/packages/foo/package.json",
  // A git worktree or submodule writes `.git` as a file containing `gitdir:`.
  "home/wt/.git",
  "home/nogit/go.mod",
  "home/.ssh/id_rsa",
  "proj/src/main.ts",
  "proj/.env",
  "proj/config/.env.prod",
  "proj/data/app.sqlite",
  "proj/dist/app.zip",
  "proj-2/x",
]) {
  writeFileSync(join(base, file), "");
}

/**
 * `undefined` once the symlink fixtures exist, otherwise why they do not.
 *
 * `symlinkSync` can fail with EPERM on hardened environments, so the cases that
 * need a symlink are skipped rather than failing the whole file.
 */
const symlinkFixtureError = ((): string | undefined => {
  try {
    // Escapes the project: <proj>/secrets -> <home>/.ssh
    symlinkSync(join(home, ".ssh"), join(proj, "secrets"), "dir");
    // Stays inside the project: <proj>/link -> <proj>/src
    symlinkSync(join(proj, "src"), join(proj, "link"), "dir");
    // An alias of the project root itself, to check root canonicalization.
    symlinkSync(proj, join(base, "proj-link"), "dir");
    return undefined;
  } catch (error) {
    return String(error);
  }
})();

if (symlinkFixtureError !== undefined) {
  console.warn(`symlink cases skipped: ${symlinkFixtureError}`);
}

const itWithSymlinks = it.skipIf(symlinkFixtureError !== undefined);

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("resolveProjectRoot", () => {
  it.each([
    {
      scenario: "a subdirectory of a git repository",
      cwd: join(home, "repo/packages/foo/src"),
      env,
      expected: join(home, "repo"),
    },
    {
      scenario: "a .git file, as a worktree or submodule produces",
      cwd: join(home, "wt/sub"),
      env,
      expected: join(home, "wt"),
    },
    {
      scenario: "nested repositories, innermost first",
      cwd: join(home, "repo/vendor/inner/src"),
      env,
      expected: join(home, "repo/vendor/inner"),
    },
    {
      scenario: "a vendored directory with no .git of its own",
      cwd: join(home, "repo/examples/zed-1.15.0/crates"),
      env,
      expected: join(home, "repo"),
    },
    {
      scenario: "an ancestor .git outranking a nearer package.json",
      cwd: join(home, "repo/packages/foo/src"),
      env,
      expected: join(home, "repo"),
    },
    {
      scenario: "a language marker, because the walk found no .git",
      cwd: join(home, "nogit/pkg"),
      env,
      expected: join(home, "nogit"),
    },
    {
      scenario: "no marker at all, falling back to cwd",
      cwd: join(home, "scratch/notes"),
      env,
      expected: join(home, "scratch/notes"),
    },
    {
      scenario: "a home directory .git, which must never be selected",
      cwd: join(home, "scratch"),
      env,
      expected: join(home, "scratch"),
    },
    {
      scenario: "a tree outside the home directory, walking to the filesystem root",
      cwd: join(base, "elsewhere/repo/sub"),
      env,
      expected: join(base, "elsewhere/repo"),
    },
    {
      scenario: "OMP_PROJECT_ROOT, short-circuiting the walk",
      cwd: join(home, "repo/packages/foo/src"),
      env: explicitEnv,
      expected: "/tmp/explicit",
    },
    {
      scenario: "an empty OMP_PROJECT_ROOT, which is ignored",
      cwd: join(home, "repo/packages/foo/src"),
      env: blankEnv,
      expected: join(home, "repo"),
    },
    {
      scenario: "a .omp directory below a repository, which is not a marker",
      cwd: join(home, "repo/packages/foo"),
      env,
      expected: join(home, "repo"),
    },
    {
      scenario: "a .omp directory with no .git anywhere, which is not a marker",
      cwd: join(home, "nogit/pkg"),
      env,
      expected: join(home, "nogit"),
    },
    {
      scenario: "a non-canonical cwd, returning a resolved absolute path",
      cwd: `${home}/repo/packages/foo/src/../../..`,
      env,
      expected: join(home, "repo"),
    },
  ])("resolves $scenario", ({ cwd, env: rowEnv, expected }) => {
    expect(resolveProjectRoot(cwd, rowEnv)).toBe(expected);
  });
});

describe("stripSelectors", () => {
  it.each([
    {
      scenario: "a path with no selector",
      raw: "src/main.ts",
      path: "src/main.ts",
      selector: undefined,
    },
    {
      scenario: "an archive member",
      raw: "dist/app.zip:META-INF/MANIFEST.MF",
      path: "dist/app.zip",
      selector: "META-INF/MANIFEST.MF",
    },
    {
      scenario: "a SQLite table and key, cutting at the first colon",
      raw: "data/app.sqlite:users:42",
      path: "data/app.sqlite",
      selector: "users:42",
    },
    {
      scenario: "a line range",
      raw: "src/main.ts:50-200",
      path: "src/main.ts",
      selector: "50-200",
    },
    { scenario: "a raw modifier", raw: "src/main.ts:raw", path: "src/main.ts", selector: "raw" },
    {
      scenario: "several line ranges",
      raw: "src/main.ts:5-16,960-973",
      path: "src/main.ts",
      selector: "5-16,960-973",
    },
    {
      scenario: "a modifier followed by a range",
      raw: "src/main.ts:raw:2-4",
      path: "src/main.ts",
      selector: "raw:2-4",
    },
    {
      scenario: "an https scheme, left intact",
      raw: "https://example.com/a",
      path: "https://example.com/a",
      selector: undefined,
    },
    {
      scenario: "a tool device scheme, left intact",
      raw: "xd://ast_grep",
      path: "xd://ast_grep",
      selector: undefined,
    },
    {
      scenario: "an internal URL with no selector",
      raw: "local://plan.md",
      path: "local://plan.md",
      selector: undefined,
    },
    {
      scenario: "an internal URL with a selector",
      raw: "local://plan.md:1-10",
      path: "local://plan.md",
      selector: "1-10",
    },
  ])("splits $scenario", ({ raw, path, selector }) => {
    expect(stripSelectors(raw)).toEqual({ path, selector });
  });
});

describe("normalizePath", () => {
  it.each([
    {
      scenario: "an absolute path inside the project into a relative one",
      raw: join(proj, "src/main.ts"),
      cwd: proj,
      root: proj,
      path: "src/main.ts",
      scope: "inside",
      escaped: false,
      selector: undefined,
    },
    {
      scenario: "a file directly under the project root",
      raw: join(proj, ".env"),
      cwd: proj,
      root: proj,
      path: ".env",
      scope: "inside",
      escaped: false,
      selector: undefined,
    },
    {
      scenario: "the project root itself into an empty string",
      raw: proj,
      cwd: proj,
      root: proj,
      path: "",
      scope: "inside",
      escaped: false,
      selector: undefined,
    },
    {
      scenario: "a tilde path outside the project, which stays absolute",
      raw: "~/.ssh/id_rsa",
      cwd: proj,
      root: proj,
      path: join(home, ".ssh/id_rsa"),
      scope: "outside",
      escaped: false,
      selector: undefined,
    },
    {
      scenario: "a sibling directory sharing a prefix, which is not inside",
      raw: join(base, "proj-2/x"),
      cwd: proj,
      root: proj,
      path: join(base, "proj-2/x"),
      scope: "outside",
      escaped: false,
      selector: undefined,
    },
    {
      scenario: "a file whose parent directories do not exist yet",
      raw: join(proj, "newdir/newfile.ts"),
      cwd: proj,
      root: proj,
      path: "newdir/newfile.ts",
      scope: "inside",
      escaped: false,
      selector: undefined,
    },
    {
      scenario: "an archive member selector, which is stripped first",
      raw: "dist/app.zip:META-INF/MANIFEST.MF",
      cwd: proj,
      root: proj,
      path: "dist/app.zip",
      scope: "inside",
      escaped: false,
      selector: "META-INF/MANIFEST.MF",
    },
    {
      scenario: "a SQLite selector, which is stripped first",
      raw: "data/app.sqlite:users:42",
      cwd: proj,
      root: proj,
      path: "data/app.sqlite",
      scope: "inside",
      escaped: false,
      selector: "users:42",
    },
    {
      scenario: "a line range selector, which is stripped first",
      raw: "src/main.ts:50-200",
      cwd: proj,
      root: proj,
      path: "src/main.ts",
      scope: "inside",
      escaped: false,
      selector: "50-200",
    },
  ])("normalizes $scenario", ({ raw, cwd, root, path, scope, escaped, selector }) => {
    const result = normalizePath(raw, cwd, root, env);
    expect(result.path).toBe(path);
    expect(result.scope).toBe(scope);
    expect(result.escaped).toBe(escaped);
    expect(result.selector).toBe(selector);
  });

  it("reports the absolute literal and resolved paths beside the match string", () => {
    const result = normalizePath("src/main.ts:50-200", proj, proj, env);
    expect(result.literal).toBe(join(proj, "src/main.ts"));
    expect(result.resolved).toBe(join(proj, "src/main.ts"));
  });

  it("resolves path traversal to an absolute path outside the project", () => {
    // <proj>/src/../../../.ssh/id_rsa leaves the temporary base entirely.
    const result = normalizePath("../../../.ssh/id_rsa", join(proj, "src"), proj, env);
    expect(result.path).toBe(join(dirname(base), ".ssh/id_rsa"));
    expect(result.scope).toBe("outside");
    expect(result.escaped).toBe(false);
    expect(isAbsolute(result.path)).toBe(true);
    expect(result.path).not.toContain("..");
    expect(result.path).toMatch(/(^|\/)\.ssh(\/|$)/);
  });

  itWithSymlinks("resolves a symlinked project root before comparing", () => {
    const result = normalizePath(join(proj, "src/main.ts"), proj, join(base, "proj-link"), env);
    expect(result.path).toBe("src/main.ts");
    expect(result.scope).toBe("inside");
    expect(result.escaped).toBe(false);
  });
});

describe("Zed pattern compatibility", () => {
  it.each([
    {
      scenario: "a file directly under the project root, through the caret branch",
      raw: join(proj, ".env"),
      pattern: /(^|\/)\.env(?:\.(local|prod))?$/,
    },
    {
      scenario: "a file in a subdirectory, through the separator branch",
      raw: join(proj, "config/.env.prod"),
      pattern: /(^|\/)\.env(?:\.(local|prod))?$/,
    },
    {
      scenario: "an absolute path outside the project",
      raw: "~/.ssh/id_rsa",
      pattern: /(^|\/)\.(ssh|aws)(\/|$)/,
    },
  ])("matches $scenario", ({ raw, pattern }) => {
    expect(normalizePath(raw, proj, proj, env).path).toMatch(pattern);
  });
});

describe("symlink escape", () => {
  itWithSymlinks("flags a symlink that leaves the project", () => {
    const result = normalizePath(join(proj, "secrets/id_rsa"), proj, proj, env);
    expect(result.escaped).toBe(true);
    expect(result.scope).toBe("outside");
    expect(result.path).toBe(join(home, ".ssh/id_rsa"));
    expect(result.literal).toBe(join(proj, "secrets/id_rsa"));
    expect(result.resolved).toBe(join(home, ".ssh/id_rsa"));
    // The matched string is the resolved path, so always_deny still catches it.
    expect(result.path).toMatch(/(^|\/)\.ssh(\/|$)/);
  });

  itWithSymlinks("does not flag a symlink that stays inside the project", () => {
    const result = normalizePath(join(proj, "link/main.ts"), proj, proj, env);
    expect(result.escaped).toBe(false);
    expect(result.scope).toBe("inside");
    expect(result.path).toBe("src/main.ts");
  });
});

describe("createPathResolver", () => {
  it("resolves relative arguments against the captured cwd", () => {
    const resolvePath = createPathResolver(join(proj, "src"), proj, env);
    expect(resolvePath("main.ts").path).toBe("src/main.ts");
    expect(resolvePath("../.env").path).toBe(".env");
    expect(resolvePath("main.ts:50-200").selector).toBe("50-200");
  });

  it("expands a tilde with the captured env", () => {
    const resolvePath = createPathResolver(proj, proj, env);
    expect(resolvePath("~/.ssh/id_rsa").path).toBe(join(home, ".ssh/id_rsa"));
    expect(resolvePath("~").path).toBe(home);
    expect(resolvePath("~").scope).toBe("outside");
  });

  itWithSymlinks("canonicalizes a symlinked project root once", () => {
    const resolvePath = createPathResolver(proj, join(base, "proj-link"), env);
    expect(resolvePath("src/main.ts").path).toBe("src/main.ts");
    expect(resolvePath("secrets/id_rsa").escaped).toBe(true);
  });
});
