// Why a live `claude` tree carries no workspace marker (KAN-537).
//
// NOT A `verify-` SCRIPT — it asserts nothing and exits nowhere. It is driven
// by `verify-supervisor-cost-exclusion.mjs`: section 5 runs it over the real
// /proc, and section 5c runs it over fixtures and watches it go red. Nothing
// else calls it, and that is the coverage boundary this header owes its reader.
//
// WHAT THIS EXISTS TO SEPARATE
//
// `verify-supervisor-cost-exclusion.mjs` section 5 asserted that EVERY live
// `claude` tree carries the `--workspace-type` marker. On 2026-08-18 that
// assertion was red on a pristine `main` worktree with no branch changes at
// all, and it stayed red across three agents who each began by suspecting
// their own work (KAN-517, KAN-532, then this ticket). CI never saw it: a
// runner has no agent trees, so the condition cannot arise there and
// `verify-runnable-set` passes the script correctly and uselessly.
//
// The two unmarked trees were measured, and the answer is neither of the two
// the ticket proposed. They were not a marking defect, and they did not
// predate the marker. They were `story/kan-117` and `epic/kan-59`, both parked
// at Claude Code's `--dangerously-load-development-channels` confirmation
// dialog, 1h20m in. **The marker lives on the butchr MCP server's argv
// (launchers.ts), and an MCP server is not spawned until that dialog is
// answered** — so those trees held no process that could have carried a
// marker. The old assertion was therefore unsatisfiable in principle for the
// whole of every agent's bring-up, which is about twelve seconds ordinarily
// and unbounded when a dialog goes unanswered.
//
// So the property worth asserting is narrower and sharper than the one that
// was there, and this module is the split:
//
//   * a tree that HOLDS a butchr core MCP server and carries no marker is the
//     KAN-145 defect — a marker written where nothing reads it. It is red, and
//     it is red in CI too the moment a runner ever has such a tree.
//   * a tree that holds NO such server cannot carry a marker, so its bareness
//     is a fact about bring-up rather than about marking. It is reported,
//     counted and named, and it is not a failure.
//
// WHY THIS REPORTS AN OBSERVATION AND REFUSES TO NAME A CAUSE
//
// `no-server` is deliberately not called `bringing-up`. A tree with no server
// is consistent with two very different worlds — an agent that has not
// finished starting, and an agent whose server started and died — and /proc
// cannot tell them apart. KAN-537's fourth acceptance criterion names exactly
// the failure that would be: *a check that reports "environmental" whenever it
// cannot explain itself has reproduced the defect with better manners.* So the
// finding is the thing that was measured (no server process in this tree), the
// caller prints the tree's age beside it so a reader can see which world is
// plausible, and nobody here infers the rest.
//
// WHY THE SERVER IS FOUND BY ITS ENTRYPOINT AND NOT BY THE MARKER
//
// Finding the server by the marker would be circular: the whole question is
// what a missing marker means. So the server is found by the path
// `coreMcpServerDefinitions()` actually spawns, read from launchers.ts rather
// than written down here, and matched on its trailing segments so that a
// daemon running from a different checkout than the one under test still
// matches. A literal path would have matched only the checkout the script
// happens to be running from, which on this fleet is never the one that
// launched the agents.
//
// WHY CWD IS ATTRIBUTION ONLY, WHICH IS NOT A REVERSAL OF KAN-145
//
// agent-cost.ts declines `/proc/<pid>/cwd` as the CLASSIFIER, because a cwd is
// a thing a running process may change and the marker is a thing the daemon
// placed deliberately. Nothing here touches that. `cwd` is read only to give
// an unmarked tree a NAME in the report — `story/kan-117` reads better than
// `pid 55494` — and no verdict depends on it. Under `run-ci-verify-set.mjs`'s
// `HOME` sandbox `workspacesRoot()` points at a temporary directory, so the
// attribution degrades to `null` there; that is why it may not decide
// anything, and why the caller prints the root it resolved.

import * as path from 'path';
import * as fs from 'fs';

/** The finding that IS a defect. Exported so a caller cannot spell it wrong. */
export const MARKING_FAILURE = 'server-unmarked';

/** Whether a diagnosis is the defect, as opposed to a fact about bring-up. */
export function isMarkingFailure(diagnosis) {
  return diagnosis.finding === MARKING_FAILURE;
}

/**
 * How many trailing path segments of the core server's entrypoint identify it.
 *
 * Three, which is `daemon/dist/mcp.js` — enough that an unrelated `mcp.js`
 * belonging to some other tool does not match, and short enough that a butchr
 * checkout anywhere on disk does. See the header for why not the whole path.
 */
const ENTRYPOINT_SEGMENTS = 3;

/** `/x/y/daemon/dist/mcp.js` -> `daemon/dist/mcp.js`. */
function entrypointTailOf(entrypoint) {
  const parts = entrypoint.split(/[/\\]+/).filter((p) => p.length > 0);
  return parts.slice(-ENTRYPOINT_SEGMENTS).join(path.sep);
}

/** Read one process's argv from /proc; an unreadable pid yields no argv. */
function procArgv(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    const parts = raw.split('\0');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    return parts;
  } catch {
    return [];
  }
}

/** Read one process's cwd from /proc, or null if it cannot be resolved. */
function procCwd(pid) {
  try {
    return fs.realpathSync(`/proc/${pid}/cwd`);
  } catch {
    return null;
  }
}

/**
 * Build the diagnostic against a built daemon.
 *
 * `distDir` is the built daemon every caller already resolves for its own
 * imports. Everything in `overrides` exists so section 5c can drive the exact
 * same `diagnose` from a fixture with no /proc and no daemon at all — the same
 * injection `classifyTree` takes, and for the same reason.
 */
export async function unmarkedTreeDiagnostic(distDir, overrides = {}) {
  const { coreMcpServerDefinitions, CORE_MCP_SERVER } = await import(
    path.join(distDir, 'launchers.js')
  );
  const { workspacesRoot, isStrictlyInside } = await import(
    path.join(distDir, 'workspace-dir.js')
  );

  // Read defensively rather than with `?.`/`??`: every way this can come back
  // empty has to reach the refusal below, and a shorthand that produces
  // `undefined` for three different reasons cannot say which one happened.
  const core = coreMcpServerDefinitions()[CORE_MCP_SERVER];
  const args = core === undefined || core === null ? null : core.args;
  const entrypoint = Array.isArray(args) && args.length > 0 ? args[0] : null;
  if (typeof entrypoint !== 'string' || entrypoint.length === 0) {
    // Refusing rather than falling back. A diagnostic that cannot find the
    // server it is looking for would call every tree `no-server`, which is the
    // benign answer -- so it would report a clean fleet while having measured
    // nothing at all. That is the exact failure KAN-537 was filed about.
    throw new Error(
      'launchers.coreMcpServerDefinitions() names no entrypoint for the core MCP server -- ' +
        'refusing to diagnose, because a diagnostic that cannot find the server calls every ' +
        'unmarked tree benign'
    );
  }

  const readArgv = overrides.readArgv === undefined ? procArgv : overrides.readArgv;
  const readCwd = overrides.readCwd === undefined ? procCwd : overrides.readCwd;
  const tail =
    overrides.entrypointTail === undefined ? entrypointTailOf(entrypoint) : overrides.entrypointTail;
  const root =
    overrides.workspacesRoot === undefined ? workspacesRoot() : overrides.workspacesRoot;

  /** Whether one argv is the core MCP server's. */
  const isCoreServer = (argv) =>
    argv.some((arg) => arg === tail || arg.endsWith(path.sep + tail));

  /**
   * Which workspace a cwd names, or null. Attribution only -- see the header.
   * `<root>/<type>/<key>` is `workspaceDirFor`'s shape; anything deeper is a
   * subdirectory of a workspace and still names it.
   */
  const workspaceOf = (cwd) => {
    if (cwd === null) return null;
    if (!isStrictlyInside(root, cwd)) return null;
    const rel = path.relative(root, cwd).split(path.sep);
    if (rel.length < 2) return null;
    return `${rel[0]}/${rel[1]}`;
  };

  /**
   * Diagnose one tree that `classifyTree` found no marker on.
   *
   * `tree` is `{ root, pids }`. The caller has already established there is no
   * marker; this says what that absence is a fact about.
   */
  const diagnose = (tree) => {
    const serverPids = tree.pids.filter((pid) => isCoreServer(readArgv(pid)));
    const cwd = readCwd(tree.root);
    return {
      root: tree.root,
      finding: serverPids.length > 0 ? MARKING_FAILURE : 'no-server',
      serverPids,
      cwd,
      workspace: workspaceOf(cwd)
    };
  };

  return { diagnose, entrypoint, entrypointTail: tail, workspacesRoot: root };
}
