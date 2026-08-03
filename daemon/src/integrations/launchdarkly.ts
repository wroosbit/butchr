import {
  CredentialSpec,
  CredentialStatus,
  CredentialStorage,
  CredentialStore,
  StorageTarget
} from '../credentials.js';
import { VALIDATE_TIMEOUT_MS, failureKind, redact, truncate } from '../jira.js';

// LaunchDarkly as Butchr's second integration: a stored API token, validated
// at the moment the user submits it, with the same disclosure and scrubbing
// discipline as the Jira credential path in jira.ts.
//
// This is deliberately a *minimal adapter* — status / storageTarget /
// setCredential / clearCredential, which is exactly the surface the router's
// credential handlers need — and not a framework. KAN-85 formalizes a full
// `Integration` interface later; this adapter is the seed it grows from, so
// anything added here beyond what the router calls today is scope borrowed
// from that ticket.
//
// There are no LD *features* here — no flag reads, no LD-owned workspace
// types. Those are follow-on stories; this module exists so a token can be
// stored, checked, disclosed, and scrubbed, end to end.

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
 * The LaunchDarkly integration, as the router consumes it: exactly the four
 * operations the credential handlers need, nothing more. KAN-85 turns this
 * shape into a formal `Integration` interface; until then it is defined by
 * use.
 */
export class LaunchDarklyIntegration {
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
}
