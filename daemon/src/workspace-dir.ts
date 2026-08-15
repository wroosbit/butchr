import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where a workspace lives, and the one place a workspace directory is deleted
 * (KAN-380, cutover gate 4).
 *
 * ## Why this file exists at all
 *
 * The directory an agent works in has two ends — creation and deletion — and
 * until this ticket only one runtime owned both. `HerdrBridge` created the
 * directory in `initPty` and deleted it in `resetWorkspace`; `CrabCastRuntime`
 * creates it in `spawnSession` (CrabCast's north star 3 is that the *caller*
 * owns the path) and **refused** to delete it, because the deleting code lived
 * inside `HerdrBridge` as a private detail of one implementation.
 *
 * CrabCast said so themselves, unprompted, while cleaning up a probe on
 * 2026-08-12: *"the workspace directory itself was NOT touched: CrabCast never
 * created it — `configure` may not `mkdir` — so it never deletes it."* So under
 * that runtime a "reset" left the previous agent's files in place under the
 * same key, and the next agent starting there inherited them. That breaks
 * invariant 7 — an agent's work stays inside `workspaces/<type>/<key>/` — which
 * is the whole of what makes a reset a complete cleanup.
 *
 * Moving the deletion here rather than copying it into the second runtime is
 * the same call `isStrictlyInside` already records: *"a second definition of
 * 'may Butchr delete this' is a second thing to get wrong, and only one of them
 * would be the one anybody audits."*
 *
 * ## THE GUARD IS STRUCTURAL, AND THAT WAS A CHOICE (KAN-380 AC2)
 *
 * The risk in this file is not that the delete fails. It is that it succeeds on
 * the wrong directory: `fs.rmSync(dir, { recursive: true })` is an `rm -rf`, and
 * the only thing between it and somewhere Butchr does not own is the check in
 * front of it. `prompts/task.md` asks for the type over the assertion where the
 * choice exists, because an assertion can be deleted by a later author and the
 * build still passes, while an unrepresentable state cannot be introduced at
 * all. Both are used here, in that order:
 *
 * 1. **The exported delete takes an ADDRESS, never a path.** There is no
 *    parameter on {@link deleteWorkspaceDir} through which any caller — the two
 *    runtimes today, whatever comes next — can name a directory. The path is
 *    derived internally by {@link workspaceDirFor}. *"Delete this arbitrary
 *    path"* is not a sentence this module's API can say.
 * 2. **The `rmSync` itself takes a {@link ContainedWorkspaceDir}**, a branded
 *    type that only {@link containWorkspaceDir} can produce. Skipping the
 *    containment check on the way to the delete is a **compile error**, not a
 *    review catch: `removeContained(workspaceDirFor(type, key))` does not
 *    typecheck. There is exactly one cast into that type in this repository and
 *    it sits on the line after the checks pass.
 * 3. **Then the assertions**, because half of this invariant is about the
 *    filesystem rather than about what the code can say. A key of `../../..`
 *    and a workspace that is a symlink to somewhere else are facts about what
 *    exists at call time; no type reaches them. That is the split
 *    `prompts/task.md` draws — the type for what the code is *able to say*, the
 *    assertion for what *actually happened* — and it is why both are here.
 *
 * **What the brand does not do, said plainly rather than left to be inferred:**
 * it constrains the one `rmSync` in this module and nothing else. Any file may
 * still `import fs` and delete whatever it likes; TypeScript has no opinion
 * about that. `daemon/scripts/verify-workspace-reset-boundary.mjs` §4 is what
 * covers the gap, by asserting that neither runtime deletes anything itself —
 * both delegate here — and that is a source-text assertion rather than a
 * type, so it is exactly as strong as somebody keeping it running.
 */

/**
 * The file Claude Code reads its MCP servers from, and — in CrabCast's own
 * words at the pin — *"from nowhere else"*.
 *
 * Declared in this leaf module and imported by both writers (`launchers.ts` for
 * the herdr path, and the residue clearance below for the CrabCast one) so the
 * name has exactly one spelling. Two writers reaching a caller-owned file by
 * two string literals is a drift nobody would notice until the day one of them
 * stopped matching.
 */
export const WORKSPACE_MCP_CONFIG = '.mcp.json';

/**
 * The one directory tree Butchr owns and may therefore destroy. Every
 * workspace is created under it (see `initPty`, and `spawnSession` in
 * `crabcast-runtime.ts`), and reset refuses to delete anything that does not
 * resolve to a place strictly inside it.
 */
export function workspacesRoot(): string {
  return path.join(os.homedir(), '.local', 'share', 'butchr', 'workspaces');
}

/** Where a workspace of this type and key lives. Must match `initPty`. */
export function workspaceDirFor(type: string, key: string): string {
  return path.join(workspacesRoot(), type, key.toLowerCase());
}

/**
 * Whether `target` sits strictly below `root` — the root itself is not
 * "inside" it, because deleting the root would take every workspace with it.
 *
 * `path.relative` rather than a `startsWith` prefix test: the latter says yes
 * to `/…/workspaces-old` for root `/…/workspaces`, and both paths must
 * already be real (symlinks resolved) for either test to mean anything.
 *
 * Exported because `reclaim.ts` deletes inside the same tree under the same
 * rule (KAN-259). It is shared rather than copied so the two cannot drift: a
 * second definition of "may Butchr delete this" is a second thing to get
 * wrong, and only one of them would be the one anybody audits.
 */
export function isStrictlyInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

declare const containmentProof: unique symbol;

/**
 * A directory this process has **proved** is strictly inside the workspaces
 * root, both by name and after resolving every symlink on the way to it.
 *
 * The brand is unforgeable from outside this module: nothing else can produce a
 * value of this type, so a function taking one is a function that cannot be
 * handed an unchecked path. See the module docblock for why that is the shape
 * chosen over one more runtime check.
 */
export type ContainedWorkspaceDir = string & { readonly [containmentProof]: true };

/**
 * What {@link containWorkspaceDir} found. Three outcomes, and `absent` is
 * deliberately not folded into `refused`:
 *
 * - `contained` — it is there and it is ours; the delete may proceed.
 * - `absent` — nothing is there. Not a refusal, and it carries no reason,
 *   because reset's caller has always been told "already gone" as
 *   `success: false` with no `error`. Collapsing it into a refusal would turn
 *   a clean no-op into a reported failure at every call site.
 * - `refused` — something is there, or something is named, that Butchr does
 *   not own. `reason` is the half of the message a human needs.
 */
export type WorkspaceContainment =
  | { readonly outcome: 'contained'; readonly dir: ContainedWorkspaceDir }
  | { readonly outcome: 'absent'; readonly dir: string }
  | { readonly outcome: 'refused'; readonly dir: string; readonly reason: string };

/**
 * Decide whether `type/key`'s workspace directory may be deleted.
 *
 * The order is load-bearing and is the same one `reclaim.ts` follows:
 *
 * 1. **Lexical first**, so a traversal key (`../..`) is refused *by name* even
 *    when it points at nothing. The answer must not depend on what happens to
 *    exist, or a key that is refused today is accepted tomorrow because
 *    somebody created a directory.
 * 2. **Then `realpath` on both sides**, and compare again. A symlink at — or
 *    above — the workspace passes the lexical test while pointing anywhere on
 *    the filesystem, so nothing is trusted until both ends are resolved.
 *
 * A path that cannot be resolved is refused rather than deleted. That is the
 * safe direction: the failure mode of refusing is a workspace that stays on
 * disk, and the failure mode of proceeding is an `rm -rf` aimed at a target
 * nobody could name.
 */
export function containWorkspaceDir(type: string, key: string): WorkspaceContainment {
  const root = workspacesRoot();
  const dir = workspaceDirFor(type, key);

  if (!isStrictlyInside(root, dir)) {
    return { outcome: 'refused', dir, reason: `'${dir}' is not inside the workspaces root` };
  }

  if (!fs.existsSync(dir)) {
    return { outcome: 'absent', dir };
  }

  let realRoot: string;
  let realTarget: string;
  try {
    realRoot = fs.realpathSync(root);
    realTarget = fs.realpathSync(dir);
  } catch (e: any) {
    return {
      outcome: 'refused',
      dir,
      reason: `'${dir}' could not be resolved (${e?.message ?? String(e)})`
    };
  }
  if (!isStrictlyInside(realRoot, realTarget)) {
    return {
      outcome: 'refused',
      dir,
      reason: `'${dir}' resolves to '${realTarget}', outside the workspaces root`
    };
  }

  // THE ONE CAST IN THE REPOSITORY THAT MINTS THIS TYPE. It is here, on the
  // line after both checks have passed, and it is what the brand is worth: a
  // reviewer auditing "can Butchr delete the wrong thing?" reads this function
  // and is done, because no other route to `removeContained` exists.
  return { outcome: 'contained', dir: dir as ContainedWorkspaceDir };
}

/**
 * The only `rm -rf` in this module, and the only one either runtime performs.
 *
 * Its parameter type is the whole point: it cannot be called with a `string`,
 * so a future edit that reaches for the delete without going through
 * {@link containWorkspaceDir} fails to compile rather than shipping.
 *
 * Not exported. An exported one would be safe — the brand still guards it — but
 * the module's API is deliberately "delete `type/key`", with no second door.
 */
function removeContained(dir: ContainedWorkspaceDir): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Delete a workspace directory, and nothing else.
 *
 * **Takes an address, never a path** — see the module docblock, guard 1. Every
 * caller in the daemon reaches deletion through this signature, so no caller
 * can aim it.
 *
 * `error` is set only when the delete was *refused* or failed; a workspace that
 * was already gone reports `success: false` with no error, which is the
 * contract `HerdrBridge.resetWorkspace` has always had and which callers in
 * `router.ts` read.
 */
export function deleteWorkspaceDir(type: string, key: string): { success: boolean; error?: string } {
  const containment = containWorkspaceDir(type, key);

  if (containment.outcome === 'absent') {
    return { success: false }; // Already gone
  }

  if (containment.outcome === 'refused') {
    const error =
      `Refusing to reset workspace '${type}/${key}': ${containment.reason}. ` +
      `Only directories strictly inside '${workspacesRoot()}' may be deleted.`;
    console.error(`[workspace-dir] ${error}`);
    return { success: false, error };
  }

  try {
    removeContained(containment.dir);
    return { success: true };
  } catch (e: any) {
    const error = `Failed to reset workspace '${containment.dir}': ${e?.message ?? String(e)}`;
    console.error('[workspace-dir]', error);
    return { success: false, error };
  }
}

/**
 * Own-property test that ignores the prototype chain, for a map whose keys are
 * caller-controlled.
 *
 * `servers['toString']` on a `JSON.parse` result inherits a function from
 * `Object.prototype`, so a plain truthiness test answers "present" for a key
 * nobody wrote and "present" for `constructor`, `valueOf` and `__proto__` too.
 * CrabCast hit exactly this in `provisionMcpConfig` and records it as *"the
 * second bug of the prototype family"* — theirs failed toward clobbering the
 * caller's file; the same idiom here would fail toward removing a key we do not
 * own. Same guard, same reason, arrived at from their write-up rather than
 * independently.
 */
function ownKey(map: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(map, key);
}

/**
 * What {@link clearWorkspaceMcpResidue} found and did. Every outcome is
 * distinguishable, deliberately: the caller logs this into `daemon.log`, and
 * "we removed nothing" and "there was nothing to remove" are different facts
 * about a cutover that four attempts failed on.
 */
export type McpResidueClearance =
  /** No workspace directory, or no `.mcp.json` in it. Nothing to do. */
  | { readonly outcome: 'absent' }
  /** The file is there and holds none of the names asked about. */
  | { readonly outcome: 'nothing-of-ours'; readonly present: readonly string[] }
  /** Keys were removed and the file rewritten. */
  | {
      readonly outcome: 'cleared';
      readonly removed: readonly string[];
      readonly kept: readonly string[];
    }
  /** Left strictly alone, and why. Never a silent skip. */
  | { readonly outcome: 'refused'; readonly reason: string };

/**
 * Remove Butchr's **own** MCP server entries from a workspace's `.mcp.json`,
 * leaving everything else in the file exactly as it was (KAN-474).
 *
 * ## The defect this exists for
 *
 * CrabCast refuses to activate an agent whose `.mcp.json` already defines a
 * server it is being asked to write and has no record of writing —
 * `provisionMcpConfig`, refusal 2 at the pinned commit: *"they are the
 * caller's, and they are not ours to take over. NOTHING WAS WRITTEN and nothing
 * was started."* Measured on 2026-08-15 across four human-driven cutover
 * attempts: **36 spawn failures, 0 activations**, every one this refusal.
 *
 * **The colliding entries are Butchr's, and they are residue.** Under herdr,
 * `writeWorkspaceMcpConfig` rewrites `.mcp.json` on *every* activation; the
 * file it leaves behind outlives the runtime that wrote it, because a workspace
 * directory is not reset between runtimes and `reclaim.ts` deliberately
 * preserves this file. 368 of the 372 workspaces on this machine carried one at
 * the time of writing, all 368 defining both `atlassian` and `butchr`.
 *
 * **Note what is NOT the defect, because the obvious fix follows from it and is
 * a no-op.** Butchr does not pre-write `.mcp.json` under CrabCast and never
 * did: `writeWorkspaceMcpConfig`'s only production caller is `herdr.ts`, inside
 * `HerdrBridge`, and `runtime-switch.ts` constructs exactly one runtime at boot.
 * *"Stop writing it when `BUTCHR_AGENT_RUNTIME=crabcast`"* is therefore already
 * true, and shipping it would have closed the ticket while leaving all 368 files
 * — and every future flip — exactly as broken.
 *
 * ## Why the keys and not the file
 *
 * CrabCast **merges** into this file rather than replacing it, and refuses only
 * on the keys it was asked to write. So a non-Butchr entry in there is honoured
 * today and is not part of the collision. Deleting the whole file would destroy
 * it — which is Butchr committing, against its own workspace, precisely the
 * offence CrabCast's refusal exists to prevent. Key-scoped removal is strictly
 * narrower, costs nothing, and needs no opinion about anybody else's entries.
 *
 * **Removing a key we wrote is not taking over the caller's file. We are the
 * caller.** This is the same ownership `spawnSession` and {@link
 * deleteWorkspaceDir} already exercise from both ends — Butchr creates the
 * workspace directory under this runtime because CrabCast will not, and deletes
 * it for the same reason.
 *
 * ## What it will not touch
 *
 * An **unparseable** file is refused and left alone rather than replaced, which
 * is the opposite of what `writeWorkspaceMcpConfig` does on the herdr path
 * (*"Butchr owns this file; a corrupt one is replaced"*). The asymmetry is the
 * point: under herdr Butchr is the sole writer, under CrabCast the file is
 * co-owned, and CrabCast's own refusal for that case names the file and says
 * `NOTHING WAS STARTED`. A better error than anything we would produce by
 * destroying the evidence first.
 *
 * **Address, never a path** — guard 1 of this module's docblock. The caller
 * cannot aim this at a file outside a workspace it named by `type`/`key`, and
 * the containment check that proves it is the same one the delete uses.
 *
 * Idempotent: a second call removes nothing and answers `nothing-of-ours`.
 */
export function clearWorkspaceMcpResidue(
  type: string,
  key: string,
  names: readonly string[]
): McpResidueClearance {
  if (names.length === 0) return { outcome: 'nothing-of-ours', present: [] };

  const containment = containWorkspaceDir(type, key);
  if (containment.outcome === 'absent') return { outcome: 'absent' };
  if (containment.outcome === 'refused') {
    return {
      outcome: 'refused',
      reason:
        `${containment.reason}. Only ${WORKSPACE_MCP_CONFIG} inside '${workspacesRoot()}' ` +
        `may be edited.`
    };
  }

  const file = path.join(containment.dir, WORKSPACE_MCP_CONFIG);
  if (!fs.existsSync(file)) return { outcome: 'absent' };

  let config: any;
  try {
    config = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    return {
      outcome: 'refused',
      reason:
        `${file} is not readable as JSON (${e?.message ?? String(e)}), so the entries to ` +
        `remove cannot be identified. IT WAS NOT REPLACED — this file may hold entries ` +
        `Butchr did not write.`
    };
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return {
      outcome: 'refused',
      reason:
        `${file} parses to ${Array.isArray(config) ? 'an array' : typeof config}, not a JSON ` +
        `object, so it has no mcpServers map to clear. It was left as it is.`
    };
  }

  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    return { outcome: 'nothing-of-ours', present: [] };
  }

  const removed = names.filter((name) => ownKey(servers, name));
  if (removed.length === 0) {
    return { outcome: 'nothing-of-ours', present: Object.keys(servers) };
  }
  for (const name of removed) delete servers[name];

  // The file is rewritten and never unlinked, even when this empties
  // `mcpServers`. An empty map collides with nothing, CrabCast merges into it
  // happily, and not deleting is one fewer thing this function can get wrong on
  // a file it only part-owns.
  try {
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  } catch (e: any) {
    return {
      outcome: 'refused',
      reason: `${file} could not be rewritten (${e?.message ?? String(e)}); it is unchanged.`
    };
  }
  return { outcome: 'cleared', removed, kept: Object.keys(servers) };
}
