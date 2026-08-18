/**
 * The `herdr` CLI, as one call site (KAN-496).
 *
 * ## Why this is its own module now
 *
 * `HerdrBridge` has driven the herdr CLI since the beginning, through a private
 * `runHerdr`. That was correct while herdr was the only runtime that had panes:
 * the caller and the capability were the same object.
 *
 * **Under CrabCast they came apart.** CrabCast spawns its agents' panes through
 * herdr on this machine — `herdr agent list` shows every CrabCast pane, keyed by
 * the `cwd` that is also CrabCast's own address for the agent — so herdr is the
 * pane substrate for *both* runtimes while being the implementation of only one.
 * {@link CrabCastRuntime.pressPaneKey} needs it, and reaching into another
 * class's private method for it would have been the second implementation this
 * codebase keeps paying for.
 *
 * ⚠ **WHAT THIS MODULE IS NOT.** It is not a claim that CrabCast will always use
 * herdr. That is an observation of this deployment, not of their contract, and
 * `epic/KAN-203` has asked `epic/KAN-59` whether herdr stays their substrate.
 * Everything here is written so the answer *no* is a loud failure rather than a
 * quiet one: {@link paneIdForCwd} answers `null` for "no pane here", and the one
 * caller that matters turns that into an unanswered dialog the startup
 * supervisor already reports. Nothing infers success from silence.
 */

import { spawnSync } from 'child_process';

/** How long any one herdr CLI call may take. */
export const HERDR_CLI_TIMEOUT_MS = 5000;

/** An Error from {@link runHerdrCli}, carrying herdr's own error code. */
export interface HerdrCliError extends Error {
  herdrCode?: string;
}

function parseJson(text: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Run one `herdr` command and return its parsed JSON.
 *
 * Throws on every way of not having an answer — herdr unreachable, herdr
 * reporting an error of its own, a non-zero exit — because every caller here is
 * doing something to a pane and "it probably worked" is not a state any of them
 * can carry.
 */
export function runHerdrCli(args: string[]): any {
  const result = spawnSync('herdr', args, {
    encoding: 'utf8',
    timeout: HERDR_CLI_TIMEOUT_MS
  });

  if (result.error) {
    throw new Error(`herdr ${args.join(' ')} failed: ${result.error.message}`);
  }

  const stdout = (result.stdout ?? '').trim();
  const stderr = (result.stderr ?? '').trim();
  const json = parseJson(stdout);

  const reported = json?.error ?? parseJson(stderr)?.error;
  if (reported) {
    const error: HerdrCliError = new Error(
      reported.message ?? `herdr reported ${reported.code ?? 'an error'}`
    );
    // herdr's machine-readable code, kept alongside the message so callers can
    // distinguish kinds of failure without matching on prose.
    if (typeof reported.code === 'string') error.herdrCode = reported.code;
    throw error;
  }
  if (result.status !== 0) {
    throw new Error(stderr || `herdr ${args.join(' ')} exited with code ${result.status}`);
  }

  return json;
}

/**
 * The herdr pane running in `cwd`, or `null` when herdr has no pane there.
 *
 * ⚠ **AMBIGUITY IS REFUSED, NOT RESOLVED.** Two panes can share a directory —
 * a `butchr-…` pane left by the previous runtime and a `crabcast-…` pane in the
 * same workspace is the ordinary way it happens — and picking one would send a
 * keystroke into whichever herdr happened to list first. A keystroke delivered
 * to the wrong pane is the failure this whole path exists to avoid, so this
 * throws with both names rather than choosing.
 *
 * `null` versus a throw is the distinction the caller needs: `null` is *herdr
 * has no pane for this agent*, which is the answer if CrabCast ever stops using
 * herdr, and it must not read like an error in the keystroke.
 */
export function paneIdForCwd(cwd: string): string | null {
  const agents = runHerdrCli(['agent', 'list'])?.result?.agents;
  if (!Array.isArray(agents)) return null;

  const here = agents.filter((a: any) => a?.cwd === cwd && typeof a?.pane_id === 'string');
  if (here.length === 0) return null;
  if (here.length > 1) {
    throw new Error(
      `herdr lists ${here.length} panes in ${cwd} (${here
        .map((a: any) => `'${a.name}'`)
        .join(', ')}), so which one to type at is not decidable. ` +
        'Refusing rather than picking: a keystroke sent to the wrong pane is worse than none.'
    );
  }
  return here[0].pane_id;
}
