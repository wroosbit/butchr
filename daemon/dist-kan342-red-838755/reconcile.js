import { delay, monotonicNow, nudgeResumedAgent } from './nudge.js';
/**
 * Bringing the fleet back after the machine came back.
 *
 * This is the step that did not exist. On KAN-21's outage the daemon restarted
 * (eventually), herdr restarted, and neither of them had any opinion about the
 * two agents that had been working ninety seconds earlier — because nothing had
 * written down that they existed. With the registry doing that, restoration is
 * this file: read the intent, ask herdr what is really there, and start what is
 * missing.
 *
 * NOTHING HERE TOUCHES THE BROWSER, which is the point. Activation was already
 * a daemon-side operation that the extension merely *calls*; the extension
 * never owned the lifecycle, it triggered it. So restoration can go through the
 * very same `handleActivateByKey` a sidepanel toggle uses, with no tab, no
 * sidepanel and nobody logged in.
 */
/** How long to keep waiting for herdr's server before giving up on it. */
const HERDR_READY_TIMEOUT_MS = 60_000;
const HERDR_POLL_INTERVAL_MS = 1_000;
/**
 * Gap between restores. Agent startup is the expensive part of a boot — each
 * one is a node process, an MCP server or two and a model connection — and
 * starting six at once on a machine that is also finishing its own boot is how
 * a restoration turns into the thing that makes the machine unusable.
 */
const RESTORE_STAGGER_MS = 3_000;
/**
 * Wait for herdr's server to answer before deciding anything.
 *
 * `listHerdrAgents` returns an empty list both when herdr has no agents and
 * when herdr could not be reached at all — a distinction that does not matter
 * to a status display and matters enormously here, because "herdr is not up
 * yet" would otherwise read as "every agent is missing" and start a second copy
 * of a fleet that was about to appear. At boot this is not hypothetical: the
 * daemon's unit only orders itself `After=herdr.service`, which says herdr was
 * *launched* first, not that its socket is accepting.
 */
async function waitForHerdr(herdrBridge) {
    const deadline = monotonicNow() + HERDR_READY_TIMEOUT_MS;
    for (;;) {
        if (herdrBridge.herdrReachable())
            return true;
        if (monotonicNow() >= deadline)
            return false;
        await delay(HERDR_POLL_INTERVAL_MS);
    }
}
/**
 * Restore every agent the registry says should be running and herdr does not
 * have. Never throws: this runs at daemon startup, and a daemon that refuses to
 * come up because a restore failed is strictly worse than one that comes up and
 * says so.
 */
export async function reconcileAgents(opts) {
    const { registry, herdrBridge, router, cause, log } = opts;
    const expected = registry.expected();
    if (expected.length === 0) {
        log('[reconcile] The agent registry records no agents that should be running.');
        return { expected: 0, outcomes: [] };
    }
    log(`[reconcile] Registry expects ${expected.length} agent(s) to be running.`);
    if (!(await waitForHerdr(herdrBridge))) {
        log(`[reconcile] herdr did not become reachable within ${HERDR_READY_TIMEOUT_MS / 1000}s; ` +
            `skipping restoration rather than starting a second copy of a fleet that may already exist. ` +
            `The ${expected.length} expected agent(s) will be reported as missing.`);
        return { expected: expected.length, outcomes: [] };
    }
    // herdr's own view, taken once: what actually survived.
    const alive = new Set(herdrBridge.listHerdrAgents().filter((agent) => agent.agentRuntime).map((agent) => agent.name));
    const outcomes = [];
    let restored = 0;
    for (const record of expected) {
        const { agentName, type, key } = record;
        if (alive.has(agentName)) {
            log(`[reconcile] ${agentName} is already running; leaving it alone.`);
            outcomes.push({ agentName, type, key, result: 'already-running' });
            continue;
        }
        // Not the first one: stagger between *starts*, not before the first.
        if (restored > 0)
            await delay(RESTORE_STAGGER_MS);
        restored++;
        log(`[reconcile] Restoring ${agentName} (${type}/${key}) in ${record.workDir}`);
        let response = null;
        try {
            await router.handleActivateByKey({
                type,
                key,
                url: record.url,
                defaultAgent: record.defaultAgent,
                // Restoration is not a new activation, so it must not orphan an agent
                // that had a parent before the power went out. The supervisor of
                // record travels with the rest of the argument list: this call is the
                // daemon standing in for whoever originally made it, and the registry
                // is the only party that still remembers who that was.
                activatedBy: record.activatedBy ?? null,
                resume: cause
                // ---------------------------------------------------------------
                // `override: true` WAS HERE, AND KAN-258 IS WHY IT IS NOT (2026-08-11)
                // ---------------------------------------------------------------
                //
                // Its argument was good and its condition inverts under exactly the
                // circumstance that triggers it. It read:
                //
                //   *"These agents were being carried when the power went out, so the
                //   machine has already demonstrated it can hold them."*
                //
                // **A hard power-off is the machine demonstrating that it could
                // not.** On 2026-08-10 the human held the button on a box at load
                // 29.14 with ten agents on four cores; the registry recorded those
                // ten as active, so the next boot restored exactly the fleet that had
                // just failed — serially, staggered, and with the gate switched off
                // by this line. Two minutes' uptime, load 29 again. It happened at a
                // cold boot both times.
                //
                // The second half of the argument — that refusing at boot *"would
                // recreate exactly the silent loss this ticket exists to remove"* —
                // is answered rather than dismissed. A refusal here is now loud in
                // three places instead of silent in none: this log line carries the
                // gate's own figures, the registry still records the agent as active,
                // and `list_agents` reports it under `missingAgents`, which exists
                // precisely to surface work that has stopped. A board-keyed agent is
                // additionally retried by the board reconciler within a cycle. **The
                // fear was loss, and the answer to loss is retry-and-say-so, not
                // gate-off.**
            }, (msg) => {
                response = msg;
            });
        }
        catch (e) {
            const error = e?.message ?? String(e);
            log(`[reconcile] Restoring ${agentName} threw: ${error}`);
            outcomes.push({ agentName, type, key, result: 'failed', error });
            continue;
        }
        // A capacity refusal is not a failure, and saying so is half of KAN-258.
        // The machine declined to carry this agent *right now*; it is still wanted,
        // it is still in the registry, and something will come back for it. A log
        // that reported this as a failed restore would send the reader looking for
        // a broken agent instead of a full machine.
        if (!response?.success && response?.refusedBy === 'capacity') {
            const error = response?.error ?? 'no reason given';
            log(`[reconcile] DEFERRED ${agentName} (${type}/${key}): the machine cannot carry it yet, ` +
                `so nothing was started and nothing was overridden. It stays in the registry as ` +
                `active and will be reported under missingAgents until it comes up; a board-keyed ` +
                `agent is retried by the board reconciler within a cycle. This is the gate working, ` +
                `not an outage.\n${error}`);
            outcomes.push({ agentName, type, key, result: 'deferred', error });
            continue;
        }
        if (!response?.success) {
            const error = response?.error ?? 'activation returned no response';
            log(`[reconcile] Could not restore ${agentName}: ${error}`);
            outcomes.push({ agentName, type, key, result: 'failed', error });
            continue;
        }
        const outcome = {
            agentName,
            type,
            key,
            result: 'restored',
            resumedConversation: response.resumedConversation === true
        };
        // The half of a resume that is not respawning. An agent whose conversation
        // came back has all of its memory and no turn to take: Claude Code resumes
        // at an empty prompt and waits, which is precisely how two agents sat idle
        // on the day this ticket was filed until a human retyped their
        // instructions. The other branch needs no message — its prompt went in on
        // the command line and it is already working.
        if (outcome.resumedConversation) {
            const nudge = await nudgeResumedAgent({
                herdrBridge,
                type,
                key,
                cause,
                defaultAgent: record.defaultAgent,
                log
            });
            outcome.nudged = nudge.nudged;
            if (nudge.error)
                outcome.error = nudge.error;
        }
        else {
            log(`[reconcile] ${agentName} had no conversation to restore; ` +
                `it started with the degraded-resume prompt and is already working.`);
        }
        outcomes.push(outcome);
    }
    return { expected: expected.length, outcomes };
}
