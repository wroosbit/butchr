import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
// Which Node actually runs the npx-based MCP servers, and whether it can.
//
// KAN-157. The Atlassian server's command used to be `which('npx') ?? 'npx'`,
// resolved from the daemon's own PATH at config-write time and written verbatim
// into every workspace's `.mcp.json`. That call *succeeded* on the machine where
// this bug was found: it returned `/usr/bin/npx`, an absolute path to a real
// executable, and the file it produced reads as correct. The Node behind it was
// v12.22.9, which cannot parse mcp-remote — the server died at parse time,
// Claude Code said nothing an agent could see, and the epic agent spent two
// hours with no Jira tools and no way to find out why.
//
// The sentence "resolve npx" was satisfied. What was needed was "resolve an npx
// that can run the thing we are about to ask it to run". This module is that
// second sentence, and it is the whole of the difference.
//
// ---------------------------------------------------------------------------
// WHAT ACTUALLY DECIDES THE INTERPRETER — measured, not assumed
// ---------------------------------------------------------------------------
//
// The obvious fix is "bake a better absolute npx path", and it does not work.
// Measured on the machine this bug was found on, 2026-08-05:
//
//   $ env -i PATH=/usr/bin:/bin HOME=$HOME \
//       ~/.nvm/versions/node/v20.20.2/bin/npx --version
//   Error: Cannot find module 'node:path'          <- node v12 ran it
//
// `npx` is a `#!/usr/bin/env node` script (both `/usr/bin/npx` and nvm's are
// symlinks to npm's `npx-cli.js`), so the *shebang* picks the interpreter out
// of PATH, and the absolute path in `command` decides nothing about it.
//
// Pinning one level deeper does not work either — `node <npx-cli.js>` still
// fails, because `npm exec` spawns the package's own bin as a child process and
// mcp-remote's `dist/proxy.js` is itself `#!/usr/bin/env node`:
//
//   $ env -i PATH=/usr/bin:/bin HOME=$HOME \
//       ~/.nvm/versions/node/v20.20.2/bin/node \
//       ~/.nvm/.../npm/bin/npx-cli.js -y mcp-remote https://mcp.atlassian.com/v1/mcp
//   SyntaxError: Unexpected token '.'             <- node v12 ran the child
//
// And with the good Node first on PATH, the same command works:
//
//   $ env -i PATH=~/.nvm/versions/node/v20.20.2/bin:/usr/bin:/bin HOME=$HOME \
//       ~/.nvm/versions/node/v20.20.2/bin/npx -y mcp-remote https://mcp.atlassian.com/v1/mcp
//   Connected to remote server using StreamableHTTPClientTransport
//
// So the only thing that decides which Node runs mcp-remote is **the PATH the
// server process is given**. That is why this module resolves a (node, npx)
// pair from a single directory and hands that directory back as a `pathPrefix`
// for the server's own environment: the npx we name and the Node its children
// resolve are then the same install, by construction rather than by luck.
//
// ---------------------------------------------------------------------------
// WHAT mcp-remote REQUIRES — read off the package, not guessed
// ---------------------------------------------------------------------------
//
// mcp-remote declares **no** `engines` field at all (`npm view mcp-remote
// engines` answers nothing; the package.json in the npx cache has no such key),
// so there is no number to read off the package itself. Its dependency closure
// does declare one, and that is the honest floor. Read from the resolved tree of
// mcp-remote@0.1.38 on 2026-08-05:
//
//   undici@7.29.0        >=20.18.1     <- direct dependency, the binding one
//   open@10.2.0          >=18
//   is-wsl@3.1.1         >=16
//   is-inside-container  >=14.16
//   …everything else     >= 0.4 … >=12
//
// Re-derive it rather than trusting this comment if mcp-remote moves:
//
//   npx -y -p mcp-remote node -e 'for (const p of ...)'   # or simply:
//   ls ~/.npm/_npx/*/node_modules/*/package.json | xargs -n1 \
//     node -e 'const p=require(process.argv[1]); if(p.engines?.node) \
//       console.log(p.name, p.engines.node)'
//
// The floor is therefore 20.18.1 — the strictest constraint a direct dependency
// of mcp-remote declares. It is deliberately *the declared* requirement rather
// than "whatever happens to boot": a Node that runs mcp-remote today while
// sitting below what undici says it supports is the same class of luck this
// ticket exists to remove.
//
// This is a floor we enforce, and enforcing it is safe in the direction it can
// be wrong: too strict only means preferring a newer Node from the same machine,
// and the daemon's own Node — the first candidate below — is normally the newest
// one present.
/** The Node version mcp-remote's dependency closure requires. See above. */
export const MIN_NODE_VERSION = { major: 20, minor: 18, patch: 1 };
/** `20.18.1`, for messages. */
export const MIN_NODE_VERSION_TEXT = `${MIN_NODE_VERSION.major}.${MIN_NODE_VERSION.minor}.${MIN_NODE_VERSION.patch}`;
/** Where the requirement above came from, quoted in refusals and log lines. */
export const MIN_NODE_VERSION_SOURCE = 'mcp-remote declares no engines of its own; its direct dependency undici@7 ' +
    `declares node >=${MIN_NODE_VERSION_TEXT}`;
/** `v20.20.2` / `20.20.2` → {20,20,2}; anything else → null. */
export function parseNodeVersion(reported) {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(reported.trim());
    if (!m)
        return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
/** True when `version` is at least `min`. */
export function meetsMinimum(version, min = MIN_NODE_VERSION) {
    if (version.major !== min.major)
        return version.major > min.major;
    if (version.minor !== min.minor)
        return version.minor > min.minor;
    return version.patch >= min.patch;
}
function isExecutable(file) {
    try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink();
    }
    catch {
        return false;
    }
}
/**
 * Ask a Node binary what version it is.
 *
 * Executed rather than inferred from the path: `/usr/bin/node` and
 * `~/.local/bin/node` say nothing about their version, and `~/.local/bin/node`
 * on the machine that found this bug was a symlink to a completely different
 * install. A path is a guess; `--version` is the answer.
 */
function reportedVersion(nodeBinary) {
    try {
        return execFileSync(nodeBinary, ['--version'], {
            encoding: 'utf8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    }
    catch {
        return null;
    }
}
/**
 * The directories to consider, in preference order.
 *
 * The daemon's own bin directory comes first, and that ordering is the entire
 * argument of this ticket. The core `butchr` MCP server has never had this bug
 * because it is `process.execPath` plus an absolute path to the daemon's own
 * `mcp.js` — it runs on the interpreter the daemon is already running on, which
 * cannot be too old to run the daemon. Putting that directory first gives the
 * Atlassian server the same immunity by the same means, instead of leaving it to
 * whatever PATH the client that respawned the daemon happened to have.
 *
 * It is a *preference*, not an assumption: it is validated like every other
 * candidate, and a daemon whose Node has no npx beside it falls through to PATH.
 */
function candidateDirs(searchPath) {
    const dirs = [
        { dir: path.dirname(process.execPath), origin: 'daemon' }
    ];
    for (const entry of searchPath.split(':')) {
        if (!entry)
            continue;
        if (dirs.some((d) => d.dir === entry))
            continue;
        dirs.push({ dir: entry, origin: 'path' });
    }
    return dirs;
}
/**
 * Find an npx whose Node can run mcp-remote, without consulting the cache.
 *
 * `node` and `npx` are required to be **siblings in one directory**. That is not
 * tidiness: the pair is what gets pinned, and pairing an npx from one install
 * with a Node from another would reintroduce exactly the mismatch this module
 * exists to prevent. A directory holding one but not the other is rejected with
 * that stated, so the log says "no npx beside it" rather than going quiet.
 */
export function resolveNpxRuntimeUncached(searchPath = process.env.PATH || '') {
    const candidates = [];
    const firstOnPath = firstNpxOnPath(searchPath);
    const found = (rest) => ({
        ...rest,
        candidates,
        ...(firstOnPath ? { firstNpxOnPath: firstOnPath } : {})
    });
    for (const { dir, origin } of candidateDirs(searchPath)) {
        const candidate = { dir, origin };
        candidates.push(candidate);
        const nodeBinary = path.join(dir, 'node');
        const npxBinary = path.join(dir, 'npx');
        if (!isExecutable(nodeBinary)) {
            candidate.rejected = 'no executable `node` here';
            continue;
        }
        candidate.node = nodeBinary;
        if (!isExecutable(npxBinary)) {
            candidate.rejected = 'no `npx` beside that node';
            continue;
        }
        candidate.npx = npxBinary;
        const reported = reportedVersion(nodeBinary);
        if (reported === null) {
            candidate.rejected = '`node --version` could not be run';
            continue;
        }
        candidate.version = reported;
        const parsed = parseNodeVersion(reported);
        if (!parsed) {
            candidate.rejected = `could not read a version out of ${JSON.stringify(reported)}`;
            continue;
        }
        if (!meetsMinimum(parsed)) {
            candidate.rejected =
                `${reported} is older than the ${MIN_NODE_VERSION_TEXT} mcp-remote's dependencies require`;
            continue;
        }
        return found({
            ok: true,
            npx: npxBinary,
            node: nodeBinary,
            version: reported,
            pathPrefix: [dir]
        });
    }
    const seen = candidates
        .filter((c) => c.version)
        .map((c) => `${c.node} (${c.version})`);
    return found({
        ok: false,
        problem: `No Node on this machine is new enough to run mcp-remote: it needs at least ` +
            `v${MIN_NODE_VERSION_TEXT} (${MIN_NODE_VERSION_SOURCE}). ` +
            (seen.length
                ? `Looked at ${seen.join(', ')}. `
                : `No directory searched held a \`node\` with an \`npx\` beside it. `) +
            `Install a newer Node (or put one ahead of the others on the daemon's PATH) ` +
            `and restart the daemon — or switch the Atlassian integration off, which stops ` +
            `its server being attached to agents at all.`
    });
}
// --------------------------------------------------------------- the cache --
//
// Task 4 of KAN-157: resolve once, not per config write.
//
// The bug's most confusing symptom was a *split fleet* — workspaces written
// before a daemon restart carried nvm's npx, ones written after carried
// `/usr/bin/npx`, and both looked equally plausible in the file. Resolving on
// every call is what made that possible within one daemon's lifetime as soon as
// anything perturbed PATH. Caching by search path means one daemon writes one
// answer into every workspace it provisions, and the log line below is emitted
// once rather than on every activation.
//
// Keyed by the search path rather than held as a bare singleton: a caller that
// resolves against a different PATH (the proof script does, deliberately) gets
// an answer for *that* PATH instead of a stale one for another. A daemon restart
// can still land on a different interpreter — that is the out-of-scope half of
// this ticket, the daemon's own PATH — but it can no longer happen mid-life, and
// after this change the daemon's own Node is preferred anyway.
const cache = new Map();
/** Test seam. Production never calls this; the proof script does, per section. */
export function resetNpxRuntimeCache() {
    cache.clear();
}
/**
 * The resolved runtime for a search path, computed once and logged once.
 *
 * Task 3 of KAN-157 — *do not silently prefer a different interpreter* — is the
 * logging here. The two-hour debugging session that produced this ticket was
 * spent asking which npx had been chosen and why; every rejected candidate is
 * named with its reason, and choosing anything other than the first `npx` on
 * PATH says so explicitly.
 */
export function resolveNpxRuntime(searchPath = process.env.PATH || '') {
    const cached = cache.get(searchPath);
    if (cached)
        return cached;
    const resolved = resolveNpxRuntimeUncached(searchPath);
    cache.set(searchPath, resolved);
    logResolution(resolved);
    return resolved;
}
function firstNpxOnPath(searchPath) {
    for (const dir of searchPath.split(':')) {
        if (!dir)
            continue;
        const candidate = path.join(dir, 'npx');
        if (isExecutable(candidate))
            return candidate;
    }
    return null;
}
function logResolution(resolved) {
    const rejected = resolved.candidates.filter((c) => c.rejected && c.version);
    for (const candidate of rejected) {
        console.log(`[NodeRuntime] Rejected ${candidate.node} (${candidate.version}): ${candidate.rejected}`);
    }
    if (!resolved.ok) {
        console.error(`[NodeRuntime] ${resolved.problem}`);
        return;
    }
    console.log(`[NodeRuntime] mcp-remote will run on ${resolved.node} (${resolved.version}) via ${resolved.npx}; ` +
        `PATH for that server is prefixed with ${resolved.pathPrefix?.join(':')}`);
    // The one line the next person debugging PATH needs and did not have. It
    // fires whenever the answer is not the obvious one, including — especially —
    // when resolution never looked at PATH at all because the daemon's own
    // directory won first. That case logs nothing else, so without this line
    // preferring a different interpreter would be exactly as silent as the bug.
    const first = resolved.firstNpxOnPath;
    if (first && first !== resolved.npx) {
        console.log(`[NodeRuntime] Note: this is NOT the first npx on PATH (${first}). ` +
            `It was preferred because ${resolved.candidates.find((c) => c.npx === resolved.npx)?.origin === 'daemon'
                ? "it sits beside the daemon's own node, which is known to be able to run this daemon"
                : 'the earlier candidates were rejected for the reasons logged above'}.`);
    }
}
