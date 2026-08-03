import {
  CredentialStore,
  CredentialStatus,
  JiraCredential,
  StorageTarget
} from './credentials.js';

// A minimal, strictly read-only Jira client, and the seam that lets its auth
// be replaced later without touching anything that calls it.
//
// The daemon needs Jira for exactly one reason: a Jira issue URL does not say
// whether the issue is a Task or a Story, and those map to different workspace
// types. So there is exactly one domain operation here — "what type is this
// issue?" — plus the credential-validation read that the settings UI needs.
//
// There are deliberately no write methods. Not "not yet": an unused write
// method is an argument for a wider credential scope waiting to happen, and
// writes already belong to agents, which hold their own scoped interactive
// auth. (KAN-20)

/** How long a lookup may take, end to end, before the caller gives up. */
export const LOOKUP_TIMEOUT_MS = 2000;

/**
 * How long *validation* may take. Deliberately far more generous than
 * `LOOKUP_TIMEOUT_MS`.
 *
 * Background type resolution runs on every tab change and must stay snappy —
 * 2s there is a latency budget. Validation runs once, with the user watching a
 * spinner they asked for, and may make up to four round trips (cloud ID, then
 * an identity probe and a work probe, each with a site-host fallback). Holding
 * it to the background budget would report "Atlassian did not respond" for a
 * credential that was merely on a slow link — the exact class of misdiagnosis
 * this ticket exists to remove.
 */
export const VALIDATE_TIMEOUT_MS = 8000;

/**
 * The two reads used to check a credential.
 *
 * They are not interchangeable, and the difference is the KAN-31 auth bug.
 * `/myself` needs the `read:jira-user` classic scope (granular:
 * `read:user:jira`); Butchr's settings page tells users to mint a scoped token
 * with **only** `read:jira-work`, which is all its one real operation — an
 * issue-type read — requires. So a user who followed the instructions exactly
 * had their perfectly good token rejected by the identity probe.
 *
 * `project/search` is the cheapest read covered by `read:jira-work`, and it
 * cannot 404 the way an issue fetch can: an account with no projects still
 * gets 200 and an empty page. The identity probe is still tried first, because
 * echoing back "Verified as <name>" is worth a request, but it is no longer
 * allowed to be the verdict.
 */
const IDENTITY_PROBE = '/rest/api/3/myself';
const WORK_PROBE = '/rest/api/3/project/search?maxResults=1';

/**
 * After a failure, skip the network entirely for this long.
 *
 * Without it, an unreachable Jira costs the full timeout on *every*
 * resolution — and `status` fires on each tab change, so the whole UI would go
 * sluggish the moment Atlassian had a bad afternoon. Degrading has to be
 * cheap, not just bounded.
 */
export const FAILURE_COOLDOWN_MS = 30_000;

/** Bounded so a long-lived daemon cannot grow this without limit. */
const CACHE_MAX_ENTRIES = 500;

/**
 * Which of the transport's endpoints an attempt was made against.
 *
 * These are the legs a caller has to be able to tell apart. "Rejected at the
 * gateway" and "rejected at your site" are different diagnoses with different
 * fixes, and collapsing them is what made the original failure undebuggable.
 */
export type JiraLeg = 'cloud-id' | 'gateway' | 'site';

/** Why a leg produced no HTTP status at all. */
export type JiraLegFailure = 'timeout' | 'network';

/**
 * What one leg did. Non-secret by construction: a URL with no credential in
 * it, a status, and Atlassian's own words about the refusal.
 */
export interface JiraLegResult {
  leg: JiraLeg;
  /** The endpoint tried. Never carries query credentials — auth is a header. */
  endpoint: string;
  /** HTTP status, when a response arrived at all. */
  status?: number;
  /** Atlassian's own explanation, scrubbed and truncated. */
  detail?: string;
  /** Atlassian's request/trace id — useful in a support ticket, not a secret. */
  traceId?: string;
  /** Set instead of `status` when the request never completed. */
  failure?: JiraLegFailure;
}

/** A response, plus the record of everything tried to obtain it. */
export interface JiraResponse {
  status: number;
  body: any;
  legs: JiraLegResult[];
}

/**
 * Something that can perform an authenticated read against Jira.
 *
 * This is the replacement seam. The client above it deals in REST paths and
 * knows nothing about tokens, Basic auth, or cloud IDs; swapping API-token
 * auth for OAuth 2.0 3LO later means writing another implementation of this
 * interface and changing one construction site, not a refactor.
 */
export interface JiraTransport {
  /**
   * GET a Jira REST path (e.g. `/rest/api/3/myself`).
   *
   * Implementations must reject rather than resolve on transport failure, and
   * must never let a credential reach the rejection value. The `legs` they
   * report — on the resolved value and on the rejection alike — are what makes
   * a failure diagnosable, so an implementation that returns an empty `legs`
   * is a conforming but useless one.
   */
  get(path: string, signal: AbortSignal): Promise<JiraResponse>;
  /** Non-secret description, safe for logs. */
  describe(): string;
}

/**
 * Strip secrets from anything about to be logged or shown.
 *
 * Belt and braces. Nothing here intentionally puts a token in a message, but
 * error paths are exactly where secrets leak in practice — a `fetch` failure,
 * a JSON parse error quoting its input, a stack frame with an inlined literal.
 * Every string this module logs goes through here first.
 *
 * Takes several secrets rather than one because a token has more than one
 * on-the-wire form: the raw value, the base64 Basic-auth blob built from it,
 * and its percent-encoding. Scrubbing only the raw value would let an echoed
 * request header through intact.
 */
export function redact(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret || secret.length < 8) continue;
    out = out.split(secret).join('***REDACTED***');
  }
  return out;
}

/** The error surface callers get. Never carries request headers or a token. */
class JiraRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly legs: JiraLegResult[] = []
  ) {
    super(message);
    this.name = 'JiraRequestError';
  }
}

/** Atlassian's refusals are longer than a UI line; keep the useful head. */
const MAX_DETAIL_CHARS = 200;

/**
 * Shorten for display — and never, ever before scrubbing.
 *
 * Truncating first defeats redaction outright: `split(secret)` matches the
 * whole secret, so a token whose tail has been cut off no longer matches and
 * sails straight through. The verification script caught exactly that, with
 * 46 of a 50-character token surviving into the user-facing message. Order is
 * load-bearing here, which is why truncation lives in its own function that
 * callers apply last. Exported so integrations/launchdarkly.ts truncates with
 * this exact function rather than a copy that could drift.
 */
export function truncate(text: string): string {
  return text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;
}

/**
 * Pull Atlassian's own explanation out of a response.
 *
 * Worth the effort because Atlassian's wording is routinely better than
 * anything invented here: "Unauthorized; scope does not match" says in four
 * words what a guess would take a paragraph to hedge around.
 *
 * The body is taken as *text* and parsed optimistically rather than via
 * `res.json()`, because the site host lies: a 401 from `yoursite.atlassian.net`
 * carries `Content-Type: application/json` and the plain sentence "Client must
 * be authenticated to access this resource." `res.json()` throws on that and
 * the sentence — the single most useful thing in the response — was being
 * dropped on the floor.
 */
function extractDetail(raw: string, parsed: any): string | undefined {
  const candidate =
    (Array.isArray(parsed?.errorMessages) && typeof parsed.errorMessages[0] === 'string'
      ? parsed.errorMessages[0]
      : undefined) ??
    (typeof parsed?.message === 'string' ? parsed.message : undefined) ??
    (typeof parsed?.error_description === 'string' ? parsed.error_description : undefined) ??
    (typeof parsed?.error === 'string' ? parsed.error : undefined) ??
    // Not JSON at all: the raw text, if it looks like prose rather than markup.
    (parsed === null && raw && !raw.trimStart().startsWith('<') ? raw : undefined);

  const text = candidate?.trim().replace(/\s+/g, ' ');
  return text || undefined;
}

/** One line describing a leg, for the user-facing message and the log alike. */
function describeLeg(leg: JiraLegResult): string {
  const what =
    leg.failure === 'timeout'
      ? 'timed out'
      : leg.failure === 'network'
        ? 'could not be reached'
        : `HTTP ${leg.status}`;
  const detail = leg.detail ? ` — ${leg.detail}` : '';
  return `${leg.endpoint} → ${what}${detail}`;
}

/**
 * Basic-auth transport for an Atlassian API token.
 *
 * Which base URL to use is not a free choice. Atlassian's newer *scoped* API
 * tokens are only accepted through the gateway at
 * `api.atlassian.com/ex/jira/{cloudId}`; classic full-permission tokens work
 * against the site host directly. Butchr asks for a scoped, read-only token
 * (`read:jira-work`), so the gateway is the primary path — but a user who
 * pastes a classic token should not get a mystifying failure, so a 401/403
 * from the gateway retries once against the site host, inside the same
 * deadline.
 *
 * The cloud ID comes from the site's unauthenticated `/_edge/tenant_info`
 * endpoint and is cached for the life of the transport.
 */
export class TokenJiraTransport implements JiraTransport {
  private cloudId: string | null = null;
  private cloudIdLeg: JiraLegResult | null = null;
  private authHeader: string;
  /** Every on-the-wire form of the secret, for scrubbing. Built once. */
  private secrets: string[];

  /**
   * `gatewayOrigin` is the scoped-token host. It is a parameter rather than a
   * hardcoded literal so the gateway branch can be exercised against a local
   * stub — otherwise testing it would mean firing invalid credentials at
   * Atlassian's production gateway. Nothing in the daemon overrides it.
   */
  constructor(
    private cred: JiraCredential,
    private gatewayOrigin: string = 'https://api.atlassian.com'
  ) {
    const basic = Buffer.from(`${cred.email}:${cred.token}`).toString('base64');
    this.authHeader = `Basic ${basic}`;
    this.secrets = [
      cred.token,
      basic,
      encodeURIComponent(cred.token),
      Buffer.from(cred.token).toString('base64'),
      // A leading slice, for the case redaction otherwise cannot catch: a
      // remote host that quotes back a *truncated* token. Whole-value matching
      // misses that by construction. 16 characters is long enough that a
      // false positive is not a real concern and short enough to catch a
      // meaningful cut; the length floor keeps it from firing on a token so
      // short it is not a token.
      ...(cred.token.length >= 24 ? [cred.token.slice(0, 16)] : [])
    ];
  }

  /** Scrub every encoded form of the token out of a string. */
  private scrub(text: string): string {
    return redact(text, ...this.secrets);
  }

  public describe(): string {
    // Site and account are not secrets; the token is, and is not here.
    return `api-token(${this.cred.email} @ ${this.cred.siteUrl})`;
  }

  /**
   * Read a response body without trusting its declared content type, and
   * without letting a secret survive into `detail`.
   */
  private async readBody(res: Response): Promise<{ body: any; detail?: string }> {
    let raw = '';
    try {
      raw = await res.text();
    } catch {
      // A truncated or aborted body is not itself the story; the status is.
      return { body: null };
    }
    let parsed: any = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Error responses are routinely not JSON, whatever the header claims.
    }
    // Scrub, *then* truncate. Reversing these two lines reintroduces the leak
    // described on `truncate`.
    const detail = extractDetail(raw, parsed);
    return {
      body: parsed,
      ...(detail ? { detail: truncate(this.scrub(detail)) } : {})
    };
  }

  /**
   * The cloud ID, plus the record of how that went.
   *
   * A failure here is not fatal — a classic token works against the site host
   * with no cloud ID at all — but it is highly diagnostic: it is the only leg
   * that needs no credential, so if it fails the problem is the site address
   * or the network, definitively not the token. That distinction is case 1,
   * and it used to be indistinguishable from a bad password.
   */
  private async resolveCloudId(signal: AbortSignal): Promise<string | null> {
    if (this.cloudId) return this.cloudId;
    const endpoint = `${this.cred.siteUrl}/_edge/tenant_info`;

    let res: Response;
    try {
      res = await fetch(endpoint, { signal });
    } catch (err: any) {
      this.cloudIdLeg = {
        leg: 'cloud-id',
        endpoint,
        failure: failureKind(err, signal)
      };
      return null;
    }

    const { body, detail } = await this.readBody(res);
    if (!res.ok) {
      this.cloudIdLeg = {
        leg: 'cloud-id',
        endpoint,
        status: res.status,
        ...(detail ? { detail } : {}),
        ...traceOf(res)
      };
      return null;
    }

    this.cloudId = typeof body?.cloudId === 'string' ? body.cloudId : null;
    this.cloudIdLeg = {
      leg: 'cloud-id',
      endpoint,
      status: res.status,
      ...(this.cloudId ? {} : { detail: 'response contained no cloudId' })
    };
    return this.cloudId;
  }

  private async attempt(
    leg: 'gateway' | 'site',
    base: string,
    path: string,
    signal: AbortSignal
  ): Promise<{ status?: number; body: any; leg: JiraLegResult }> {
    // The path is what identifies the endpoint; auth travels in a header, so
    // there is nothing credential-shaped in this string. Scrubbed regardless.
    const endpoint = this.scrub(`${base}${path}`);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json'
        },
        signal
      });
    } catch (err: any) {
      // Rebuild rather than forward: this is the path where a helpful runtime
      // is most likely to quote something it should not.
      return {
        body: null,
        leg: { leg, endpoint, failure: failureKind(err, signal) }
      };
    }

    const { body, detail } = await this.readBody(res);
    return {
      status: res.status,
      body,
      leg: {
        leg,
        endpoint,
        status: res.status,
        ...(detail ? { detail } : {}),
        ...traceOf(res)
      }
    };
  }

  public async get(path: string, signal: AbortSignal): Promise<JiraResponse> {
    const legs: JiraLegResult[] = [];
    const cloudId = await this.resolveCloudId(signal);
    if (this.cloudIdLeg) legs.push(this.cloudIdLeg);

    if (cloudId) {
      const viaGateway = await this.attempt(
        'gateway',
        `${this.gatewayOrigin}/ex/jira/${cloudId}`,
        path,
        signal
      );
      legs.push(viaGateway.leg);
      if (viaGateway.status !== undefined && viaGateway.status !== 401 && viaGateway.status !== 403) {
        return { status: viaGateway.status, body: viaGateway.body, legs };
      }
      // Fall through on 401/403 — probably a classic token, which the gateway
      // rejects — and also on a transport failure, since a reachable site host
      // is still worth trying when only `api.atlassian.com` is unreachable.
      // Either way both legs end up in the record, which is the point.
    }

    const viaSite = await this.attempt('site', this.cred.siteUrl, path, signal);
    legs.push(viaSite.leg);
    if (viaSite.status === undefined) {
      throw new JiraRequestError(
        this.scrub(`no leg completed: ${legs.map(describeLeg).join('; ')}`),
        undefined,
        legs
      );
    }
    return { status: viaSite.status, body: viaSite.body, legs };
  }
}

/**
 * Timeout or genuine network failure?
 *
 * These want different sentences — "Atlassian did not answer in time" versus
 * "that host does not resolve" — and until now they produced the same one.
 * The abort is checked directly rather than trusting `err.name`, because the
 * abort reason varies by runtime and undici has shipped more than one.
 * Exported for integrations/launchdarkly.ts, whose legs fail the same ways.
 */
export function failureKind(err: any, signal: AbortSignal): JiraLegFailure {
  if (signal.aborted || err?.name === 'AbortError' || err?.name === 'TimeoutError') {
    return 'timeout';
  }
  return 'network';
}

/**
 * Atlassian's trace id for the request, if it offered one.
 *
 * Derived entirely from response headers — nothing here is a function of the
 * credential — and it is the one thing Atlassian support will ask for.
 */
function traceOf(res: Response): { traceId?: string } {
  const id =
    res.headers.get('atl-traceid') ??
    res.headers.get('x-trace-id') ??
    res.headers.get('x-arequestid');
  return id ? { traceId: id } : {};
}

/**
 * Which of the failure modes a rejection actually was.
 *
 * The ticket's six cases, named. A string rather than prose so a test — or a
 * future UI that wants to link to the right help page — can assert on the
 * diagnosis without matching on wording.
 */
export type JiraDiagnosis =
  /** 1. The site address is wrong, or the site is unreachable. */
  | 'site-unreachable'
  /** 1b. Something answered, but it is not a Jira site. */
  | 'site-not-jira'
  /** 2. The gateway refused the token — typically a scope or token-type problem. */
  | 'gateway-token-rejected'
  /** 3. Authenticated at the gateway, but not permitted to read Jira. */
  | 'gateway-forbidden'
  /** 4. The site host refused the email/token pair outright. */
  | 'credentials-rejected'
  /** 3b. Authenticated at the site host, but not permitted to read Jira. */
  | 'site-forbidden'
  /** 6. Nothing answered within the deadline. */
  | 'timeout'
  /** 6b. A leg failed at the transport layer. */
  | 'network'
  /** Anything else Atlassian returned. */
  | 'unexpected-status';

/** Outcome of checking a credential at the moment the user submits it. */
export interface ValidationResult {
  valid: boolean;
  /** Non-secret, user-facing explanation when invalid. */
  error?: string;
  /** Machine-readable form of `error`. */
  diagnosis?: JiraDiagnosis;
  /** Every endpoint tried, and what it said. Non-secret by construction. */
  legs?: JiraLegResult[];
  /** Display name of the authenticated account, when valid. */
  accountName?: string;
  /** Set when the credential works but is too narrowly scoped to name itself. */
  note?: string;
}

/**
 * Turn a record of legs into the sentence the user needed in the first place.
 *
 * The rule: name the leg, name what it returned, say what that implies, and
 * quote Atlassian where Atlassian said something. The old message asserted one
 * cause out of six and was therefore wrong five times out of six — including
 * for the report that opened this ticket.
 */
export function explainLegs(legs: JiraLegResult[]): { error: string; diagnosis: JiraDiagnosis } {
  const cloud = legs.find((l) => l.leg === 'cloud-id');
  const gateway = legs.find((l) => l.leg === 'gateway');
  const site = legs.find((l) => l.leg === 'site');
  const trail = legs.length ? `\n\nTried:\n${legs.map((l) => `• ${describeLeg(l)}`).join('\n')}` : '';
  const traced = legs.find((l) => l.traceId);
  const trace = traced ? `\nAtlassian trace id: ${traced.traceId}` : '';
  const say = (error: string, diagnosis: JiraDiagnosis) => ({
    error: error + trail + trace,
    diagnosis
  });

  // The last leg is the one that decided the outcome; read backwards from it.
  const decisive = site ?? gateway ?? cloud;

  if (decisive?.failure === 'timeout') {
    return say(
      cloud?.failure === 'timeout'
        ? `Timed out reaching ${hostOf(cloud.endpoint)}. The site may be wrong, or the network slow enough that ${VALIDATE_TIMEOUT_MS}ms was not enough. Nothing about your token was tested.`
        : `Atlassian did not respond within ${VALIDATE_TIMEOUT_MS}ms. Your credential was neither accepted nor rejected — this is a timeout, not a refusal.`,
      'timeout'
    );
  }
  if (decisive?.failure === 'network') {
    return say(
      `Could not reach ${hostOf(decisive.endpoint)}. Check the site address and your connection. Nothing about your token was tested.`,
      'network'
    );
  }

  // Case 1: the unauthenticated leg failed. Definitively not the credential.
  if (cloud && (cloud.failure || (cloud.status !== undefined && cloud.status !== 200))) {
    if (cloud.failure === 'network') {
      return say(`Could not reach ${hostOf(cloud.endpoint)}. Check the site address.`, 'network');
    }
    return say(
      `${hostOf(cloud.endpoint)} answered, but not as a Jira site (HTTP ${cloud.status} from its cloud-ID endpoint). Check the site address. This request carries no credential, so your email and token were not involved.`,
      'site-not-jira'
    );
  }
  if (cloud && cloud.status === 200 && cloud.detail === 'response contained no cloudId') {
    return say(
      `${hostOf(cloud.endpoint)} responded but did not identify itself as a Jira site. Check the site address; your credential was not involved.`,
      'site-not-jira'
    );
  }

  // Cases 2/3: the gateway had an opinion.
  if (gateway?.status === 403) {
    return say(
      'The token authenticated at the Atlassian gateway but is not permitted to read Jira (403). It needs the read:jira-work scope.',
      'gateway-forbidden'
    );
  }

  // Cases 4/5: what the site host said, in the light of what the gateway said.
  if (site?.status === 401) {
    if (gateway?.status === 401) {
      // Case 5: both legs refused. Say so, and say they may differ.
      return say(
        'Both endpoints rejected this email and token (401). The gateway at api.atlassian.com refuses tokens that are missing the scope it needs; your site host refuses tokens that are wrong, expired, or revoked. Since neither accepted it, the most likely causes are a revoked token, a token pasted with a character missing, or an email that is not the one that owns the token.',
        'credentials-rejected'
      );
    }
    return say(
      `Reached ${hostOf(site.endpoint)}, but it rejected this email and token (401). The address is right and the site is up — so the token is wrong, expired, or revoked, or the email is not the account that owns it.`,
      'credentials-rejected'
    );
  }
  if (site?.status === 403) {
    return say(
      `Reached ${hostOf(site.endpoint)} and the credential authenticated, but the account is not permitted to read Jira (403).`,
      'site-forbidden'
    );
  }
  if (gateway?.status === 401 && site?.status !== undefined && site.status !== 200) {
    return say(
      `The Atlassian gateway rejected the token (401) and ${hostOf(site.endpoint)} returned HTTP ${site.status}.`,
      'gateway-token-rejected'
    );
  }
  if (site?.status === 404) {
    return say(
      `Reached ${hostOf(site.endpoint)}, but there is no Jira REST API there (404). Check the site address.`,
      'site-not-jira'
    );
  }

  const status = decisive?.status;
  return say(`Atlassian returned HTTP ${status ?? 'no response'}.`, 'unexpected-status');
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
 * The read-only Jira client. One domain operation, plus validation.
 */
export class JiraClient {
  constructor(private transport: JiraTransport) {}

  /**
   * The issue's type name as Jira spells it (`Task`, `Story`, `Bug`, …), or
   * null when it cannot be determined.
   */
  public async getIssueTypeName(key: string, signal: AbortSignal): Promise<string | null> {
    const { status, body } = await this.transport.get(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=issuetype`,
      signal
    );
    if (status !== 200) {
      throw new JiraRequestError(`issue lookup returned HTTP ${status}`, status);
    }
    const name = body?.fields?.issuetype?.name;
    return typeof name === 'string' && name ? name : null;
  }

  /**
   * Check, at submit time, whether the credential the user just typed actually
   * works — and if it does not, say precisely which leg refused it and why.
   *
   * Two probes, in order, because they answer different questions:
   *
   *  - `/myself` answers "who is this?", which is what lets the UI say
   *    "Verified as Wroos Bit" instead of a bare tick. It needs the
   *    `read:jira-user` scope.
   *  - `project/search` answers "can this credential do what Butchr needs?",
   *    under `read:jira-work` — the only scope the settings page asks for.
   *
   * Treating the first as the verdict was the bug: a token minted exactly as
   * instructed, with `read:jira-work` and nothing else, is refused by `/myself`
   * and — because the transport falls back to the site host on 401, where a
   * scoped token is never accepted — the refusal arrived as a bare site-host
   * 401 reading "Atlassian rejected the email and API token". Which is the
   * report that opened this ticket. So a 401/403 on the identity probe now
   * demotes to "no name available" and the work probe decides.
   */
  public async validate(signal: AbortSignal): Promise<ValidationResult> {
    let identity: JiraResponse | null = null;
    try {
      identity = await this.transport.get(IDENTITY_PROBE, signal);
    } catch (err: any) {
      // A transport failure here will repeat on the work probe; report it now
      // rather than paying the deadline twice.
      return failedValidation(err);
    }

    if (identity.status === 200) {
      const name = identity.body?.displayName;
      return {
        valid: true,
        legs: identity.legs,
        ...(typeof name === 'string' && name ? { accountName: name } : {})
      };
    }

    // Only a 401/403 is worth a second opinion: it is the signature of a
    // too-narrow scope as well as of a bad token. Any other status (404, 5xx)
    // is about the site or Atlassian, and the work probe would say the same.
    if (identity.status !== 401 && identity.status !== 403) {
      return { valid: false, legs: identity.legs, ...explainLegs(identity.legs) };
    }

    let work: JiraResponse;
    try {
      work = await this.transport.get(WORK_PROBE, signal);
    } catch (err: any) {
      return failedValidation(err);
    }

    if (work.status === 200) {
      return {
        valid: true,
        legs: work.legs,
        note:
          'The token can read Jira work, which is all Butchr needs. It cannot read your account profile, so there is no name to show — add the read:jira-user scope if you want one.'
      };
    }

    return { valid: false, legs: work.legs, ...explainLegs(work.legs) };
  }
}

/**
 * A rejection from the transport, rendered as a verdict.
 *
 * The legs ride on the error precisely so this is possible: a thrown request
 * is exactly the case where the caller has the least to go on and needs the
 * record of what was tried the most.
 */
function failedValidation(err: any): ValidationResult {
  const legs: JiraLegResult[] = Array.isArray(err?.legs) ? err.legs : [];
  if (legs.length) return { valid: false, legs, ...explainLegs(legs) };
  return {
    valid: false,
    diagnosis: 'network',
    error: 'Could not reach Atlassian. Check the site URL and your connection.'
  };
}

/**
 * What the rest of the daemon actually uses: issue key in, workspace-relevant
 * issue-type name out, with a cache, a hard deadline, and a promise never to
 * throw.
 *
 * Every failure mode — no credential, network down, 401, 404, timeout,
 * malformed response — resolves to null. Callers treat null as "assume the
 * default type", which is what keeps Butchr working when Jira does not.
 */
export class JiraIssueTypeService {
  private cache = new Map<string, string>();
  private inFlight = new Map<string, Promise<string | null>>();
  private failingUntil = 0;
  /** Rebuilt whenever the credential changes; null means "not loaded yet". */
  private transport: JiraTransport | null = null;
  private transportCred: string | null = null;

  /** Counts real network lookups. Cache hits do not increment it. */
  public networkLookups = 0;

  /**
   * `makeTransport` is the auth seam in its final form. This service knows
   * only that it can obtain "something that can authenticate a Jira read" from
   * a stored credential; it has no idea what a token is. Moving to OAuth 2.0
   * 3LO later means writing another `JiraTransport` and changing this one
   * default — not reshaping anything that calls it.
   */
  constructor(
    private store: CredentialStore,
    private timeoutMs: number = LOOKUP_TIMEOUT_MS,
    private now: () => number = () => Date.now(),
    private makeTransport: (cred: JiraCredential) => JiraTransport = (cred) =>
      new TokenJiraTransport(cred),
    /** Separate from `timeoutMs`: see VALIDATE_TIMEOUT_MS. */
    private validateTimeoutMs: number = VALIDATE_TIMEOUT_MS
  ) {}

  public status(): CredentialStatus {
    return this.store.status();
  }

  /**
   * Validate a credential and, only if it is good, store it.
   *
   * Storing an invalid credential would turn a typo into a silent permanent
   * fallback to `task`, discovered months later. Better to refuse it while the
   * user is still looking at the field.
   */
  public async setCredential(cred: JiraCredential): Promise<ValidationResult & { storage?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.validateTimeoutMs);
    try {
      const result = await new JiraClient(this.makeTransport(cred)).validate(
        controller.signal
      );
      if (!result.valid) return result;

      const storage = await this.store.save(cred);
      this.reset();
      return { ...result, storage };
    } catch (err: any) {
      // `validate` handles its own transport failures, so reaching here means
      // something unforeseen. Rebuild the message from scratch either way;
      // nothing from the request is echoed.
      return {
        valid: false,
        diagnosis: controller.signal.aborted ? 'timeout' : 'network',
        error: controller.signal.aborted
          ? `Atlassian did not respond within ${this.validateTimeoutMs}ms. Your credential was neither accepted nor rejected.`
          : 'Could not reach Atlassian. Check the site URL and your connection.'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Where a credential submitted *right now* would be stored.
   *
   * Asked before the secret is typed, not after. Butchr prefers the OS keyring
   * and falls back to a 0600 file, and which one you get depends on whether
   * libsecret is installed and a secret service is actually running — a fact
   * the user cannot see and has every right to know before handing over a
   * token. Reporting it only in the success message meant the choice was
   * disclosed one step too late to be a choice.
   */
  public async storageTarget(): Promise<StorageTarget> {
    return this.store.storageTarget();
  }

  public async clearCredential(): Promise<void> {
    await this.store.clear();
    this.reset();
  }

  /** Drop cached credential state, cache, and any failure cooldown. */
  private reset(): void {
    this.transport = null;
    this.transportCred = null;
    this.cache.clear();
    this.failingUntil = 0;
  }

  private async getTransport(): Promise<JiraTransport | null> {
    const cred = await this.store.load();
    if (!cred) {
      this.transport = null;
      this.transportCred = null;
      return null;
    }
    // Rebuild when the credential changes; the transport caches a cloud ID and
    // an auth header that would otherwise go stale.
    const fingerprint = `${cred.siteUrl}|${cred.email}|${cred.token.length}`;
    if (!this.transport || this.transportCred !== fingerprint) {
      this.transport = this.makeTransport(cred);
      this.transportCred = fingerprint;
    }
    return this.transport;
  }

  /**
   * The issue's Jira type name, or null if it cannot be determined right now.
   * Never throws; never takes longer than the configured timeout.
   */
  public async getIssueTypeName(key: string): Promise<string | null> {
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    // Recently failed: do not pay the timeout again yet.
    if (this.now() < this.failingUntil) return null;

    // Two tabs opening the same issue at once should cost one request.
    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const pending = this.lookup(key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  private async lookup(key: string): Promise<string | null> {
    const transport = await this.getTransport();
    if (!transport) {
      // Not configured. This is the ordinary state for a user who has never
      // opened settings, so it is not a failure and not worth a cooldown or a
      // log line on every tab change.
      return null;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      this.networkLookups++;
      const name = await new JiraClient(transport).getIssueTypeName(key, controller.signal);
      if (name) this.remember(key, name);
      return name;
    } catch (err: any) {
      this.failingUntil = this.now() + FAILURE_COOLDOWN_MS;
      // Message only — never the error object, whose properties on a fetch
      // failure can include the request that produced it.
      console.warn(
        `jira: issue-type lookup for ${key} failed (${err?.message ?? 'unknown error'}); ` +
          `falling back to the default workspace type`
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Cache a resolved type. Only successes are cached: caching a failure would
   * pin an issue to the fallback type long after Jira came back.
   *
   * An issue's type effectively never changes, so entries do not expire; the
   * map is bounded instead, evicting the oldest insertion when full.
   */
  private remember(key: string, name: string): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, name);
  }
}
