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
