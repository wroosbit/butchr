import {
  CredentialSpec,
  CredentialStatus,
  CredentialStorage,
  CredentialStore,
  StorageTarget
} from '../credentials.js';
import { PROXY_TIMEOUT_MS, VALIDATE_TIMEOUT_MS, failureKind, redact, truncate } from '../jira.js';
import { CredentialAdapter, Integration } from './integration.js';

// LaunchDarkly as Butchr's second integration: a stored API token, validated
// at the moment the user submits it, with the same disclosure and scrubbing
// discipline as the Jira credential path in jira.ts.
//
// The adapter below is the same four operations KAN-86 shipped — status /
// storageTarget / setCredential / clearCredential — now declared against the
// `CredentialAdapter` interface those four operations became. Nothing here
// changed to satisfy it; the interface was written from this class.
//
// KAN-298 adds the second thing this credential is for: {@link
// LaunchDarklyIntegration.proxyRead}, one GET made on an agent's behalf. What
// it may read is not decided here — `launchdarkly-proxy.ts` owns the operation
// table and the switch, and this file never learns what a tool is. The split is
// the one `jira.ts` and `atlassian-proxy.ts` keep: a transport that knows about
// credentials and HTTP, and a table that knows about policy.
//
// There are still no LD-owned workspace types, and there is no write path of
// any kind — see `launchdarkly-proxy.ts`'s header for why that is a decision
// rather than a gap.

/** The credential in full. LaunchDarkly needs nothing but the token. */
export interface LdCredential {
  token: string;
}

export const LAUNCHDARKLY_CREDENTIAL_SPEC: CredentialSpec = {
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
 * The one leg a LaunchDarkly validation has. Jira needs three (cloud-id,
 * gateway, site) because Atlassian routes scoped and classic tokens
 * differently; LaunchDarkly has a single API host and the token goes straight
 * to it. The *shape* of a leg is kept identical to `JiraLegResult` so the UI
 * renders either trail with the same code.
 */
export type LdLeg = 'api';

/** Why a leg produced no HTTP status at all. Same split as jira.ts. */
export type LdLegFailure = 'timeout' | 'network';

/**
 * What the leg did. Non-secret by construction: a URL with no credential in
 * it, a status, and LaunchDarkly's own words about the refusal.
 */
export interface LdLegResult {
  leg: LdLeg;
  /** The endpoint tried. Never carries the token — auth is a header. */
  endpoint: string;
  /** HTTP status, when a response arrived at all. */
  status?: number;
  /** LaunchDarkly's own explanation, scrubbed and truncated. */
  detail?: string;
  /** LaunchDarkly's request id — useful in a support ticket, not a secret. */
  traceId?: string;
  /** Set instead of `status` when the request never completed. */
  failure?: LdLegFailure;
}

/**
 * Which failure mode a rejection actually was — the leg named, so the UI and
 * the log never have to guess between "bad token" and "LaunchDarkly-side
 * permission problem", which want different fixes.
 */
export type LdDiagnosis =
  /** HTTP 401: LaunchDarkly refused the token outright. */
  | 'token-rejected'
  /** HTTP 403: authenticated, but not permitted to read projects. */
  | 'ld-forbidden'
  /** Nothing answered within the deadline. */
  | 'timeout'
  /** The request failed at the transport layer. */
  | 'network'
  /** Anything else LaunchDarkly returned. */
  | 'unexpected-status';

/** Outcome of checking a token at the moment the user submits it. */
export interface LdValidationResult {
  valid: boolean;
  /** Non-secret, user-facing explanation when invalid. */
  error?: string;
  /** Machine-readable form of `error`. */
  diagnosis?: LdDiagnosis;
  /** The endpoint tried, and what it said. Non-secret by construction. */
  legs?: LdLegResult[];
}

/**
 * Pull LaunchDarkly's own explanation out of a response body. Its errors are
 * JSON `{"code": "unauthorized", "message": "…"}`; the message is routinely
 * better than anything invented here.
 */
function extractDetail(raw: string, parsed: any): string | undefined {
  const candidate =
    (typeof parsed?.message === 'string' ? parsed.message : undefined) ??
    (typeof parsed?.code === 'string' ? parsed.code : undefined) ??
    // Not JSON at all: the raw text, if it looks like prose rather than markup.
    (parsed === null && raw && !raw.trimStart().startsWith('<') ? raw : undefined);

  const text = candidate?.trim().replace(/\s+/g, ' ');
  return text || undefined;
}

/** LaunchDarkly's request id for the response, if it offered one. */
function traceOf(res: Response): { traceId?: string } {
  const id = res.headers.get('x-request-id') ?? res.headers.get('x-ld-request-id');
  return id ? { traceId: id } : {};
}

/** One line describing the leg, for the user-facing message and the log alike. */
function describeLeg(leg: LdLegResult): string {
  const what =
    leg.failure === 'timeout'
      ? 'timed out'
      : leg.failure === 'network'
        ? 'could not be reached'
        : `HTTP ${leg.status}`;
  const detail = leg.detail ? ` — ${leg.detail}` : '';
  return `${leg.endpoint} → ${what}${detail}`;
}

/** Host of an endpoint, for prose. Falls back to the whole string. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
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
export async function validateLdToken(
  token: string,
  signal: AbortSignal,
  apiOrigin: string = LD_API_ORIGIN
): Promise<LdValidationResult> {
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
  const scrub = (text: string) => redact(text, ...secrets);

  const endpoint = scrub(`${apiOrigin}${VALIDATE_PROBE}`);

  let res: Response;
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
  } catch (err: any) {
    // Rebuild rather than forward: this is the path where a helpful runtime is
    // most likely to quote something it should not.
    const failure = failureKind(err, signal);
    const leg: LdLegResult = { leg: 'api', endpoint, failure };
    return {
      valid: false,
      diagnosis: failure,
      error:
        failure === 'timeout'
          ? `LaunchDarkly did not respond within ${VALIDATE_TIMEOUT_MS}ms. Your token was neither accepted nor rejected — this is a timeout, not a refusal.${trail([leg])}`
          : `Could not reach ${hostOf(endpoint)}. Check your connection. Nothing about your token was tested.${trail([leg])}`,
      legs: [leg]
    };
  }

  let raw = '';
  try {
    raw = await res.text();
  } catch {
    // A truncated or aborted body is not itself the story; the status is.
  }
  let parsed: any = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Error responses are routinely not JSON, whatever the header claims.
  }
  // Scrub, *then* truncate. Reversing these defeats redaction outright — see
  // the comment on `truncate` in jira.ts for the incident that proved it.
  const detail = extractDetail(raw, parsed);
  const leg: LdLegResult = {
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
function trail(legs: LdLegResult[]): string {
  const lines = legs.length
    ? `\n\nTried:\n${legs.map((l) => `• ${describeLeg(l)}`).join('\n')}`
    : '';
  const traced = legs.find((l) => l.traceId);
  return lines + (traced ? `\nLaunchDarkly request id: ${traced.traceId}` : '');
}

/**
 * What one proxied read produced — LaunchDarkly's answer, or a refusal that
 * says **whose problem it is** (KAN-298).
 *
 * The same shape and the same argument as `JiraProxyOutcome`, and the argument
 * is worth repeating rather than cross-referencing because it is the whole point
 * of this type. An agent that reads a failure has one question:
 * **"is this my problem or the fleet's?"** {@link credentialFault} is a separate
 * field from the message because that question must not have to be answered by
 * parsing prose. `true` means the daemon's credential was refused or unreachable
 * and **every other agent is about to hit this too**, which is a thing to report
 * to a human rather than to retry; `false` means LaunchDarkly answered and
 * disliked *this* request, which is the agent's own to fix.
 *
 * **There is no success shape carrying an empty body.** A proxied read either
 * produces what LaunchDarkly returned or produces a refusal naming the endpoint
 * — the silent third option is the defect this whole ticket exists to remove,
 * and the one the broken `~/.claude.json` entry has been producing for a week by
 * exiting before it ever spoke MCP.
 */
export type LdProxyOutcome =
  | { ok: true; status: number; body: any }
  | {
      ok: false;
      /** HTTP status, when LaunchDarkly answered at all. Absent on a dead leg. */
      status?: number;
      /** The sentence the agent reads. Never empty, never a bare status. */
      error: string;
      /** Machine-readable, when the leg supported a diagnosis. */
      diagnosis?: LdDiagnosis;
      /** The endpoint tried and what it said. Non-secret by construction. */
      legs?: LdLegResult[];
      /** See the docblock: whose problem this is. */
      credentialFault: boolean;
    };

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
export function explainLdProxyFailure(
  status: number,
  legs: LdLegResult[]
): { error: string; diagnosis?: LdDiagnosis; credentialFault: boolean } {
  const said = legs.map((leg) => leg.detail).filter((detail): detail is string => !!detail);
  const because = said.length ? ` LaunchDarkly said: ${said[said.length - 1]}` : '';
  const planLimited = said.some((detail) => /plan does not allow/i.test(detail));

  if (status === 403 && planLimited) {
    return {
      error:
        'LaunchDarkly refused this read because THE ACCOUNT PLAN DOES NOT INCLUDE THIS FEATURE ' +
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
      error:
        "The Butchr daemon's own LaunchDarkly credential was refused (401). This is not your " +
        'query and retrying will not help — every agent using this proxy is about to see the ' +
        'same thing, and a human has to replace the credential in Butchr settings. The token is ' +
        `wrong, expired, or revoked.${because}`,
      diagnosis: 'token-rejected',
      credentialFault: true
    };
  }

  if (status === 403) {
    return {
      error:
        "The Butchr daemon's own LaunchDarkly credential authenticated but is not permitted this " +
        `read (403).${because} This is a permission problem on the LaunchDarkly side — the ` +
        "token's role does not cover this resource — rather than a mistyped token, and a human " +
        'has to widen the role or replace the credential in Butchr settings.',
      diagnosis: 'ld-forbidden',
      credentialFault: true
    };
  }

  if (status === 404) {
    return {
      error:
        `LaunchDarkly answered 404 for this read. The daemon's credential worked; the project, ` +
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
      error:
        'LaunchDarkly is rate-limiting this credential (429). It is shared by the whole fleet, ' +
        `so backing off rather than retrying immediately is the cooperative move.${because}`,
      diagnosis: 'unexpected-status',
      credentialFault: false
    };
  }
  if (status >= 500) {
    return {
      error:
        `LaunchDarkly returned HTTP ${status} — a fault on their side, not with the credential ` +
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
export class LaunchDarklyIntegration
  implements CredentialAdapter<{ token: string }, LdValidationResult & { storage?: CredentialStorage }>
{
  constructor(
    private store: CredentialStore<LdCredential> = new CredentialStore(
      LAUNCHDARKLY_CREDENTIAL_SPEC
    ),
    private apiOrigin: string = LD_API_ORIGIN,
    /** Separate from the lookup budget for the reasons on VALIDATE_TIMEOUT_MS. */
    private validateTimeoutMs: number = VALIDATE_TIMEOUT_MS
  ) {}

  /** Non-secret summary — safe to send to the UI and to log. */
  public status(): CredentialStatus {
    return this.store.status();
  }

  /** Where a token submitted right now would land, answered before entry. */
  public storageTarget(): Promise<StorageTarget> {
    return this.store.storageTarget();
  }

  /**
   * Validate a token and, only if it is good, store it.
   *
   * Same rule as the Jira path: storing an invalid credential would turn a
   * typo into a silent permanent failure discovered much later. Better to
   * refuse it while the user is still looking at the field.
   */
  public async setCredential(fields: {
    token: string;
  }): Promise<LdValidationResult & { storage?: CredentialStorage }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.validateTimeoutMs);
    try {
      const result = await validateLdToken(fields.token, controller.signal, this.apiOrigin);
      if (!result.valid) return result;

      const storage = await this.store.save({ token: fields.token });
      return { ...result, storage };
    } catch {
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
    } finally {
      clearTimeout(timer);
    }
  }

  /** Remove the credential from both backends. Idempotent. */
  public async clearCredential(): Promise<void> {
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
  public async proxyRead(path: string, beta = false): Promise<LdProxyOutcome> {
    const cred = await this.store.load();
    if (!cred) {
      // Distinct from every other refusal, and the wording matters: an agent
      // must not read "no credential" as "LaunchDarkly is down". Nothing is
      // broken — nobody has configured one.
      return {
        ok: false,
        credentialFault: true,
        error:
          'The Butchr daemon has no LaunchDarkly credential configured, so it cannot make this ' +
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
    const scrub = (text: string) => redact(text, ...secrets);
    const endpoint = scrub(`${this.apiOrigin}${path}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      let res: Response;
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
      } catch (err: any) {
        // No response at all. Rebuilt rather than forwarded: this is the path
        // where a helpful runtime is most likely to quote the request — and
        // therefore the header — back at us.
        const failure = failureKind(err, controller.signal);
        const leg: LdLegResult = { leg: 'api', endpoint, failure };
        return {
          ok: false,
          credentialFault: true,
          diagnosis: failure,
          legs: [leg],
          error:
            'The Butchr daemon could not reach LaunchDarkly at all for this read. Every agent ' +
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
      } catch {
        // A truncated or aborted body is not itself the story; the status is.
      }
      let parsed: any = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Error responses are routinely not JSON, whatever the header claims.
      }

      // Scrub, *then* truncate. Reversing these defeats redaction outright —
      // see the comment on `truncate` in jira.ts for the incident that proved it.
      const detail = extractDetail(raw, parsed);
      const leg: LdLegResult = {
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
    } finally {
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
export function createLaunchDarklyIntegration(credential: LaunchDarklyIntegration): Integration {
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
