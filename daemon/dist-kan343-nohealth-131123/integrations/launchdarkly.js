import { CredentialStore } from '../credentials.js';
import { PROXY_TIMEOUT_MS, VALIDATE_TIMEOUT_MS, failureKind, redact, truncate } from '../jira.js';
export const LAUNCHDARKLY_CREDENTIAL_SPEC = {
    id: 'launchdarkly',
    keyringLabel: 'Butchr — LaunchDarkly API token',
    nonSecretFields: []
};
export const LD_API_ORIGIN = 'https://app.launchdarkly.com';
/**
 * The validation read: the cheapest thing an access token authorizes.
 * `limit=1` because the answer wanted is a status code, not a project list —
 * an account with no projects still gets 200 and an empty page.
 */
const VALIDATE_PROBE = '/api/v2/projects?limit=1';
/**
 * Pull LaunchDarkly's own explanation out of a response body. Its errors are
 * JSON `{"code": "unauthorized", "message": "…"}`; the message is routinely
 * better than anything invented here.
 */
function extractDetail(raw, parsed) {
    const candidate = (typeof parsed?.message === 'string' ? parsed.message : undefined) ??
        (typeof parsed?.code === 'string' ? parsed.code : undefined) ??
        // Not JSON at all: the raw text, if it looks like prose rather than markup.
        (parsed === null && raw && !raw.trimStart().startsWith('<') ? raw : undefined);
    const text = candidate?.trim().replace(/\s+/g, ' ');
    return text || undefined;
}
/** LaunchDarkly's request id for the response, if it offered one. */
function traceOf(res) {
    const id = res.headers.get('x-request-id') ?? res.headers.get('x-ld-request-id');
    return id ? { traceId: id } : {};
}
/** One line describing the leg, for the user-facing message and the log alike. */
function describeLeg(leg) {
    const what = leg.failure === 'timeout'
        ? 'timed out'
        : leg.failure === 'network'
            ? 'could not be reached'
            : `HTTP ${leg.status}`;
    const detail = leg.detail ? ` — ${leg.detail}` : '';
    return `${leg.endpoint} → ${what}${detail}`;
}
/** Host of an endpoint, for prose. Falls back to the whole string. */
function hostOf(endpoint) {
    try {
        return new URL(endpoint).host;
    }
    catch {
        return endpoint;
    }
}
/**
 * Check a token against LaunchDarkly, and if it is refused, say precisely
 * which way and why.
 *
 * A standalone function rather than a private method so the verify scripts
 * can drive every failure mode against a local stub without constructing an
 * adapter around a real store — the same reason `JiraClient.validate` is
 * reachable on its own.
 *
 * `apiOrigin` is a parameter for the same reason `TokenJiraTransport` takes
 * `gatewayOrigin`: exercising the 401/403/timeout branches for real would
 * otherwise mean firing invalid credentials at LaunchDarkly's production API.
 * Nothing in the daemon overrides it.
 */
export async function validateLdToken(token, signal, apiOrigin = LD_API_ORIGIN) {
    // Every on-the-wire form of the secret, for scrubbing — the raw header
    // value plus the encodings a misbehaving proxy could quote back, and a
    // leading slice to catch a host echoing a *truncated* token, exactly as
    // TokenJiraTransport builds its list.
    const secrets = [
        token,
        encodeURIComponent(token),
        Buffer.from(token).toString('base64'),
        ...(token.length >= 24 ? [token.slice(0, 16)] : [])
    ];
    const scrub = (text) => redact(text, ...secrets);
    const endpoint = scrub(`${apiOrigin}${VALIDATE_PROBE}`);
    let res;
    try {
        res = await fetch(endpoint, {
            method: 'GET',
            headers: {
                // LaunchDarkly API tokens go in Authorization bare — no scheme prefix.
                Authorization: token,
                Accept: 'application/json'
            },
            signal
        });
    }
    catch (err) {
        // Rebuild rather than forward: this is the path where a helpful runtime is
        // most likely to quote something it should not.
        const failure = failureKind(err, signal);
        const leg = { leg: 'api', endpoint, failure };
        return {
            valid: false,
            diagnosis: failure,
            error: failure === 'timeout'
                ? `LaunchDarkly did not respond within ${VALIDATE_TIMEOUT_MS}ms. Your token was neither accepted nor rejected — this is a timeout, not a refusal.${trail([leg])}`
                : `Could not reach ${hostOf(endpoint)}. Check your connection. Nothing about your token was tested.${trail([leg])}`,
            legs: [leg]
        };
    }
    let raw = '';
    try {
        raw = await res.text();
    }
    catch {
        // A truncated or aborted body is not itself the story; the status is.
    }
    let parsed = null;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        // Error responses are routinely not JSON, whatever the header claims.
    }
    // Scrub, *then* truncate. Reversing these defeats redaction outright — see
    // the comment on `truncate` in jira.ts for the incident that proved it.
    const detail = extractDetail(raw, parsed);
    const leg = {
        leg: 'api',
        endpoint,
        status: res.status,
        ...(detail ? { detail: truncate(scrub(detail)) } : {}),
        ...traceOf(res)
    };
    if (res.status === 200) {
        return { valid: true, legs: [leg] };
    }
    if (res.status === 401) {
        return {
            valid: false,
            diagnosis: 'token-rejected',
            error: `LaunchDarkly rejected the token (401). The token is wrong, expired, or revoked — check it was pasted whole.${trail([leg])}`,
            legs: [leg]
        };
    }
    if (res.status === 403) {
        return {
            valid: false,
            diagnosis: 'ld-forbidden',
            error: `The token authenticated, but LaunchDarkly does not permit it to read projects (403). This is a permission problem on the LaunchDarkly side — the token's role does not cover reading, not a mistyped token.${trail([leg])}`,
            legs: [leg]
        };
    }
    return {
        valid: false,
        diagnosis: 'unexpected-status',
        error: `LaunchDarkly returned HTTP ${res.status}.${trail([leg])}`,
        legs: [leg]
    };
}
/** The tried-trail appended to every failure message, mirroring explainLegs. */
function trail(legs) {
    const lines = legs.length
        ? `\n\nTried:\n${legs.map((l) => `• ${describeLeg(l)}`).join('\n')}`
        : '';
    const traced = legs.find((l) => l.traceId);
    return lines + (traced ? `\nLaunchDarkly request id: ${traced.traceId}` : '');
}
/**
 * Turn a refused proxied read into the sentence an agent acts on.
 *
 * Exported because the refusals are the security-relevant half of this file and
 * a verify script should be able to drive every branch of them without a
 * network, a credential or a daemon.
 *
 * THE 403 IS THE INTERESTING ONE and it is why this function exists rather than
 * a `switch` inline. LaunchDarkly returns 403 for two completely different
 * situations that want opposite responses from the reader:
 *
 *  - **`"Plan does not allow this operation"`** — an account entitlement. Every
 *    AI Configs endpoint answers this on a plan without AI Configs, which is the
 *    state of the account this was built against: four of the ten mirrored
 *    operations return it. Nothing about the credential is wrong, no token
 *    change fixes it, and retrying never will. Reporting it as "the credential
 *    was refused" would send somebody to replace a perfectly good token.
 *  - **anything else 403** — the token authenticated and its role does not cover
 *    this resource, which *is* a credential problem and does want a human.
 *
 * Distinguishing them is done on LaunchDarkly's own words, which are better than
 * anything invented here — see `extractDetail`.
 */
export function explainLdProxyFailure(status, legs) {
    const said = legs.map((leg) => leg.detail).filter((detail) => !!detail);
    const because = said.length ? ` LaunchDarkly said: ${said[said.length - 1]}` : '';
    const planLimited = said.some((detail) => /plan does not allow/i.test(detail));
    if (status === 403 && planLimited) {
        return {
            error: 'LaunchDarkly refused this read because THE ACCOUNT PLAN DOES NOT INCLUDE THIS FEATURE ' +
                `(403).${because} This is an entitlement on the LaunchDarkly account, not a problem with ` +
                "the Butchr daemon's credential and not a missing resource: the token authenticated and " +
                'the endpoint exists. No token change fixes it and retrying will not help — the plan has ' +
                'to include the feature. AI Configs are the usual case. Every other operation this proxy ' +
                'serves is unaffected.',
            diagnosis: 'ld-forbidden',
            // Deliberately false. It is not the credential, and marking it a
            // credential fault would tell the whole fleet its shared token had died.
            credentialFault: false
        };
    }
    if (status === 401) {
        return {
            error: "The Butchr daemon's own LaunchDarkly credential was refused (401). This is not your " +
                'query and retrying will not help — every agent using this proxy is about to see the ' +
                'same thing, and a human has to replace the credential in Butchr settings. The token is ' +
                `wrong, expired, or revoked.${because}`,
            diagnosis: 'token-rejected',
            credentialFault: true
        };
    }
    if (status === 403) {
        return {
            error: "The Butchr daemon's own LaunchDarkly credential authenticated but is not permitted this " +
                `read (403).${because} This is a permission problem on the LaunchDarkly side — the ` +
                "token's role does not cover this resource — rather than a mistyped token, and a human " +
                'has to widen the role or replace the credential in Butchr settings.',
            diagnosis: 'ld-forbidden',
            credentialFault: true
        };
    }
    if (status === 404) {
        return {
            error: `LaunchDarkly answered 404 for this read. The daemon's credential worked; the project, ` +
                `flag, environment or AI Config asked for does not exist, or this account cannot see ` +
                `it. Check the keys — they are case-sensitive.${because}`,
            diagnosis: 'unexpected-status',
            credentialFault: false
        };
    }
    if (status === 400) {
        return {
            error: `LaunchDarkly rejected this read as malformed (400).${because}`,
            diagnosis: 'unexpected-status',
            credentialFault: false
        };
    }
    if (status === 429) {
        return {
            error: 'LaunchDarkly is rate-limiting this credential (429). It is shared by the whole fleet, ' +
                `so backing off rather than retrying immediately is the cooperative move.${because}`,
            diagnosis: 'unexpected-status',
            credentialFault: false
        };
    }
    if (status >= 500) {
        return {
            error: `LaunchDarkly returned HTTP ${status} — a fault on their side, not with the credential ` +
                `or the query.${because}`,
            diagnosis: 'unexpected-status',
            credentialFault: false
        };
    }
    return {
        error: `LaunchDarkly returned HTTP ${status}, which this proxy has no specific reading of.${because}`,
        diagnosis: 'unexpected-status',
        credentialFault: false
    };
}
/**
 * The LaunchDarkly credential, as the router consumes it: exactly the four
 * operations the credential handlers need, nothing more.
 */
export class LaunchDarklyIntegration {
    store;
    apiOrigin;
    validateTimeoutMs;
    constructor(store = new CredentialStore(LAUNCHDARKLY_CREDENTIAL_SPEC), apiOrigin = LD_API_ORIGIN, 
    /** Separate from the lookup budget for the reasons on VALIDATE_TIMEOUT_MS. */
    validateTimeoutMs = VALIDATE_TIMEOUT_MS) {
        this.store = store;
        this.apiOrigin = apiOrigin;
        this.validateTimeoutMs = validateTimeoutMs;
    }
    /** Non-secret summary — safe to send to the UI and to log. */
    status() {
        return this.store.status();
    }
    /** Where a token submitted right now would land, answered before entry. */
    storageTarget() {
        return this.store.storageTarget();
    }
    /**
     * Validate a token and, only if it is good, store it.
     *
     * Same rule as the Jira path: storing an invalid credential would turn a
     * typo into a silent permanent failure discovered much later. Better to
     * refuse it while the user is still looking at the field.
     */
    async setCredential(fields) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.validateTimeoutMs);
        try {
            const result = await validateLdToken(fields.token, controller.signal, this.apiOrigin);
            if (!result.valid)
                return result;
            const storage = await this.store.save({ token: fields.token });
            return { ...result, storage };
        }
        catch {
            // `validateLdToken` handles its own transport failures, so reaching here
            // means something unforeseen. Rebuild the message from scratch either
            // way; nothing from the request is echoed.
            return {
                valid: false,
                diagnosis: controller.signal.aborted ? 'timeout' : 'network',
                error: controller.signal.aborted
                    ? `LaunchDarkly did not respond within ${this.validateTimeoutMs}ms. Your token was neither accepted nor rejected.`
                    : 'Could not reach LaunchDarkly. Check your connection.'
            };
        }
        finally {
            clearTimeout(timer);
        }
    }
    /** Remove the credential from both backends. Idempotent. */
    async clearCredential() {
        await this.store.clear();
    }
    /**
     * One read made on an agent's behalf, through the daemon's own credential
     * (KAN-298).
     *
     * WHAT THIS DOES NOT DO, BECAUSE SOMEBODY WILL LOOK FOR IT HERE: it does not
     * decide **what** may be read. The path arrives already built by
     * `launchdarkly-proxy.ts`'s operation table from arguments it validated, and
     * this method neither parses it nor checks it. Putting a policy question
     * inside a transport is how the granted scope stops being readable off one
     * table, and it is why the equivalent split exists between `jira.ts` and
     * `atlassian-proxy.ts`.
     *
     * There is deliberately **no** `proxyWrite` beside this. Adding one is not a
     * matter of copying this method with a verb changed — see
     * `launchdarkly-proxy.ts`'s header for the decision and the four options it
     * rejected.
     *
     * THE TOKEN DOES NOT APPEAR IN THE ANSWER, by construction rather than by
     * filtering: auth travels in a header, the path is built from validated
     * arguments, and every on-the-wire form of the secret is scrubbed out of any
     * detail LaunchDarkly hands back — the same list `validateLdToken` builds, for
     * the same reason.
     *
     * Never throws.
     */
    async proxyRead(path, beta = false) {
        const cred = await this.store.load();
        if (!cred) {
            // Distinct from every other refusal, and the wording matters: an agent
            // must not read "no credential" as "LaunchDarkly is down". Nothing is
            // broken — nobody has configured one.
            return {
                ok: false,
                credentialFault: true,
                error: 'The Butchr daemon has no LaunchDarkly credential configured, so it cannot make this ' +
                    'read for you. Nothing is broken and LaunchDarkly is not down: a human configures one ' +
                    "in Butchr's settings, under Integrations."
            };
        }
        const token = cred.token;
        const secrets = [
            token,
            encodeURIComponent(token),
            Buffer.from(token).toString('base64'),
            ...(token.length >= 24 ? [token.slice(0, 16)] : [])
        ];
        const scrub = (text) => redact(text, ...secrets);
        const endpoint = scrub(`${this.apiOrigin}${path}`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
        try {
            let res;
            try {
                res = await fetch(endpoint, {
                    method: 'GET',
                    headers: {
                        // LaunchDarkly API tokens go in Authorization bare — no scheme.
                        Authorization: token,
                        Accept: 'application/json',
                        // Only where the operation asked for it. Sent unconditionally it
                        // would be a second, undeclared thing every request carries.
                        ...(beta ? { 'LD-API-Version': 'beta' } : {})
                    },
                    signal: controller.signal
                });
            }
            catch (err) {
                // No response at all. Rebuilt rather than forwarded: this is the path
                // where a helpful runtime is most likely to quote the request — and
                // therefore the header — back at us.
                const failure = failureKind(err, controller.signal);
                const leg = { leg: 'api', endpoint, failure };
                return {
                    ok: false,
                    credentialFault: true,
                    diagnosis: failure,
                    legs: [leg],
                    error: 'The Butchr daemon could not reach LaunchDarkly at all for this read. Every agent ' +
                        'using this proxy is about to see the same thing. ' +
                        (failure === 'timeout'
                            ? `Nothing answered within ${PROXY_TIMEOUT_MS}ms — this is a timeout, not a refusal, ` +
                                'so nothing has been established about the credential.'
                            : `${hostOf(endpoint)} could not be reached. Check the machine's connection.`)
                };
            }
            let raw = '';
            try {
                raw = await res.text();
            }
            catch {
                // A truncated or aborted body is not itself the story; the status is.
            }
            let parsed = null;
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                // Error responses are routinely not JSON, whatever the header claims.
            }
            // Scrub, *then* truncate. Reversing these defeats redaction outright —
            // see the comment on `truncate` in jira.ts for the incident that proved it.
            const detail = extractDetail(raw, parsed);
            const leg = {
                leg: 'api',
                endpoint,
                status: res.status,
                ...(detail ? { detail: truncate(scrub(detail)) } : {}),
                ...traceOf(res)
            };
            if (res.status >= 200 && res.status < 300) {
                // `parsed` rather than `raw`, and the null case is a real one: a 204 has
                // no body. It is reported as the success it is, with the status saying
                // which success — never as an empty object that reads like a project
                // with nothing in it.
                return { ok: true, status: res.status, body: parsed };
            }
            return { ok: false, status: res.status, legs: [leg], ...explainLdProxyFailure(res.status, [leg]) };
        }
        finally {
            clearTimeout(timer);
        }
    }
}
/**
 * LaunchDarkly as a registrable integration: a credential and no workspace
 * types.
 *
 * The empty `workspaceTypes` is the honest answer rather than a placeholder —
 * there are no LD-owned workspace types yet, and the settings UI renders the
 * row with an empty provided-types list because that is what is true. Adding
 * one later is a config in this array, not a change anywhere else.
 */
export function createLaunchDarklyIntegration(credential) {
    return {
        id: 'launchdarkly',
        name: 'LaunchDarkly',
        // As every integration is: off until turned on, with the registry
        // supplying the persisted decision. A LaunchDarkly credential that is
        // already configured on this machine migrates as enabled, which keeps the
        // shipped settings UI showing exactly what it showed before.
        enabled: false,
        workspaceTypes: [],
        credential
    };
}
