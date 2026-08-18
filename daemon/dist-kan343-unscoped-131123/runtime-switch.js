import os from 'os';
import path from 'path';
import { CrabCastLink, CRABCAST_PIN, defaultCrabCastSocket } from './crabcast-link.js';
import { CrabCastRuntime } from './crabcast-runtime.js';
import { HerdrBridge } from './herdr.js';
/** The environment variable that selects a runtime. */
export const RUNTIME_ENV_VAR = 'BUTCHR_AGENT_RUNTIME';
/** Where to reach CrabCast, when one is selected. */
export const CRABCAST_SOCKET_ENV_VAR = 'BUTCHR_CRABCAST_SOCKET';
/**
 * The mode this daemon runs in, from the environment.
 *
 * An unrecognised value falls back to `herdr` **and says so**. That direction
 * of fallback is the safe one and the choice is not symmetric: falling back to
 * the default runtime costs nothing, while falling back to CrabCast on a
 * misspelling would move a whole fleet onto an unproven path because somebody
 * typed `crabcst`.
 */
export function selectedRuntimeMode(env = process.env) {
    const raw = env[RUNTIME_ENV_VAR];
    if (raw === undefined || raw.trim() === '') {
        return { mode: 'herdr', source: 'default', rawValue: raw ?? null, fallbackReason: null };
    }
    const value = raw.trim().toLowerCase();
    if (value === 'crabcast') {
        return { mode: 'crabcast', source: 'environment', rawValue: raw, fallbackReason: null };
    }
    if (value === 'herdr') {
        return { mode: 'herdr', source: 'environment', rawValue: raw, fallbackReason: null };
    }
    return {
        mode: 'herdr',
        source: 'default',
        rawValue: raw,
        fallbackReason: `${RUNTIME_ENV_VAR} is set to "${raw}", which is not one of herdr | crabcast. ` +
            'Falling back to herdr — an unreadable setting is never a licence to move the fleet ' +
            'onto a different runtime.'
    };
}
/** Where CrabCast's socket is, for this daemon. */
export function crabCastSocketPath(env = process.env) {
    const raw = env[CRABCAST_SOCKET_ENV_VAR];
    if (raw && raw.trim())
        return path.resolve(raw.trim().replace(/^~(?=$|\/)/, os.homedir()));
    return defaultCrabCastSocket();
}
/**
 * Build the runtime this daemon will use, and the report that describes it.
 *
 * **In `herdr` mode nothing in this function touches CrabCast**: no
 * {@link CrabCastLink} is constructed, no socket is opened, no census poll is
 * started, and `crabcast-runtime.js` contributes nothing but an unused import
 * binding. That is criterion 3, and it is enforced by construction rather than
 * by care — the CrabCast branch is the only place a link is ever built.
 */
export function createAgentRuntime(options) {
    const env = options?.env ?? process.env;
    const log = options?.log ?? ((m) => console.log(m));
    const decision = selectedRuntimeMode(env);
    const decidedAt = new Date().toISOString();
    if (decision.fallbackReason)
        log(`[runtime] ${decision.fallbackReason}`);
    if (decision.mode === 'crabcast') {
        const socketPath = crabCastSocketPath(env);
        const link = new CrabCastLink({ socketPath, log: (m) => log(`[crabcast] ${m}`) });
        const runtime = new CrabCastRuntime({ link, log: (m) => log(`[CrabCastRuntime] ${m}`) });
        const report = {
            mode: 'crabcast',
            implementation: runtime.constructor.name,
            source: decision.source,
            rawValue: decision.rawValue,
            fallbackReason: null,
            decidedAt,
            summary: `Agents are served by CrabCast over ${socketPath} ` +
                `(adapter proved against CrabCast ${CRABCAST_PIN.slice(0, 12)}). ` +
                `Selected by ${RUNTIME_ENV_VAR}=${decision.rawValue}. ` +
                'This is not the default; unset that variable and restart to return to HerdrBridge.',
            crabcast: { socketPath, pinnedCommit: CRABCAST_PIN }
        };
        log(`[runtime] ${report.summary}`);
        return { runtime, report };
    }
    const runtime = new HerdrBridge();
    const report = {
        mode: 'herdr',
        implementation: runtime.constructor.name,
        source: decision.source,
        rawValue: decision.rawValue,
        fallbackReason: decision.fallbackReason,
        decidedAt,
        summary: 'Agents are served by HerdrBridge, in this process. ' +
            (decision.source === 'default'
                ? `${RUNTIME_ENV_VAR} is not set, which is the default and the only supported ` +
                    'configuration today. No CrabCast connection exists.'
                : `Selected explicitly by ${RUNTIME_ENV_VAR}=${decision.rawValue}. No CrabCast ` +
                    'connection exists.')
    };
    log(`[runtime] ${report.summary}`);
    return { runtime, report };
}
