import {
  CredentialStore,
  CredentialStatus,
  JiraCredential,
  StorageTarget
} from './credentials.js';

// A minimal Jira client — three domain reads, one proxied read, one proxied
// write — and the seam that lets its auth be replaced later without touching
// anything that calls it.
//
// WHAT THIS IS ALLOWED TO READ, AND WHY THAT CHANGED
//
// This header used to assert one domain operation, then two. Each widening is
// recorded rather than quietly absorbed, because the number is the argument
// against the next one. **Three** domain operations now:
//
//   1. "what type is this issue?" — a Jira issue URL does not say whether the
//      issue is a Task or a Story, and those map to different workspace types.
//   2. "what does this issue look like right now?" — status, `updated`,
//      comment ids, and issue links, for the poller in jira-poll.ts.
//   3. "which issues does the board say should be running?" — one bounded JQL
//      search returning `key`, `status` and `issuetype`, for the reconciler in
//      board-reconcile.ts.
//
// (1) and (2) arrived on 2026-08-03 with KAN-75, when the human widened the
// credential surface to **status and comment reads** and chose polling over
// webhooks explicitly, so that a ticket moved on the board or commented on
// while its agent was mid-turn reaches the agents it concerns instead of
// waiting for somebody to remember to nudge.
//
// (3) arrived on 2026-08-08 with KAN-221, when the human made Jira the store of
// desired state for the whole fleet: *"it should be jira controlled"*. It is a
// search rather than N per-key GETs, and {@link JiraClient.getIssueSnapshot}'s
// own doc-comment argues against exactly that — so the disagreement is worth
// stating rather than leaving for a reader to trip over. **That argument is
// about the poller's needs and does not apply here.** It reasons that a search
// "cannot carry `issuelinks` or comment ids per issue", which would make it a
// search *plus* a GET per issue and no saving at all. The reconciler needs
// neither links nor comments — `key`, `status`, `issuetype`, nothing else — for
// which one search is one request covering the whole fleet, and the per-key
// failure isolation the poller values is a liability here rather than a feature:
// a reconciler wants one verdict about the whole board, not a board it saw
// three-quarters of.
//
//   4. "what did an agent ask to read?" — {@link JiraClient.proxyRead}, the
//      transport half of the daemon-side Atlassian proxy (KAN-272,
//      atlassian-proxy.ts).
//
// (4) arrived on 2026-08-11 and is the one widening that is **not** a new thing
// the daemon wants to know; it is the same reads, asked for by somebody else.
// Its shape is deliberately unlike the three above: it takes a path rather than
// a domain question, because it has no domain question of its own — and that
// would be a hole in this file's own argument if the path came from the caller.
// It does not. `atlassian-proxy.ts` holds a fixed table of operations, each
// building its own path from validated arguments, and no operation anywhere
// takes a path, a URL or a REST fragment from an agent. The granted scope is
// that table, and it is `read:jira-work` — the same scope items 1 to 3 already
// needed, so this too costs the user nothing to grant. Read the table, not this
// method, to know what the credential is used for.
//
// Plus the credential-validation read the settings UI needs. All four
// operations fit inside the same `read:jira-work` scope the settings page has
// always asked for, so no read widening has ever cost the user anything to
// grant.
//
//   5. "what did an agent ask to WRITE?" — {@link JiraClient.proxyWrite}, the
//      transport half of the daemon-side Atlassian write path (KAN-291).
//
// THE RULE THAT CHANGED, WHAT REPLACED IT, AND WHY
//
// This heading read THE RULE THAT DID NOT CHANGE until 2026-08-11, and under it:
//
//     There are deliberately no write methods. Not "not yet": an unused write
//     method is an argument for a wider credential scope waiting to happen, and
//     writes already belong to agents, which hold their own scoped interactive
//     auth. (KAN-20, unchanged by KAN-75.)
//
// **That rule was right, and the premise it rested on is gone.** Its own
// justification names the condition: *writes already belong to agents, which
// hold their own scoped interactive auth*. The interactive auth is precisely
// what the human instructed be removed — the per-agent `mcp-remote` OAuth
// session whose expiry took the fleet's Jira down for twelve hours on
// 2026-08-10 — so the sentence "writes already belong to agents" stops being
// true of the arrangement being built, and a rule whose premise has been
// deleted is not a rule that survives by being restated. KAN-272 carried the
// human's reversal of KAN-39's invariant 2 and deliberately left it unspent;
// KAN-291 is the change that spends it. Leaving the old text in place would
// have been the worse outcome of the two available: a header asserting a rule
// the code no longer follows is read as a description and used as a licence,
// and this board has already been bitten by a stale derivation.
//
// WHAT IS TRUE NOW, WHICH IS NARROWER THAN "THERE ARE WRITE METHODS"
//
//   - **One** write method, {@link JiraClient.proxyWrite}, and it is a POST.
//     There is no PUT, no PATCH and no DELETE anywhere in this file, and the
//     operations that would need them are KAN-293's to add deliberately.
//   - It is **the same shape as `proxyRead` and for the same reason**: it takes
//     a path and a body rather than a domain question, because it has no domain
//     question of its own. Neither comes from an agent. `atlassian-proxy.ts`
//     holds a fixed table whose entries build the whole path *and the whole
//     body* from arguments matched against a regex; there is no operation
//     anywhere that takes a path, a URL, a REST fragment or a JSON body from a
//     caller. **Read that table, not this method, to know what the credential
//     can write.**
//   - Nothing else in this file writes. The poller still reports news by typing
//     at a terminal rather than by writing to Jira, and the reconciler still
//     only reads the board. The daemon has not acquired opinions it expresses
//     into Jira on its own account — every write here is one an agent asked for
//     and is attributed to it in the audit line `router.ts` emits.
//   - **The scope is no longer free.** Items 1 to 4 fit inside `read:jira-work`,
//     which is why no previous widening cost the user anything to grant. A
//     transition needs `write:jira-work`. That is a genuine new cost to the
//     person who mints the token, the settings page now says so before they
//     type one, and it is the reason the write lives behind its own proxy mode
//     which is off unless an operator sets it.

/** How long a lookup may take, end to end, before the caller gives up. */
export const LOOKUP_TIMEOUT_MS = 2000;

/**
 * How long a *poll* read may take.
 *
 * Deliberately its own budget rather than `LOOKUP_TIMEOUT_MS`. That 2s figure
 * is a latency budget: an issue-type lookup runs on every tab change with a
 * user waiting on the result, so a slow Jira has to become a fallback quickly.
 * Nothing waits on a poll — it is a background timer, and giving up on a merely
 * slow response would turn a slow link into permanent blindness to comments.
 * Still bounded well inside the poll interval, so a stalled read cannot pile
 * ticks on top of each other.
 */
export const POLL_TIMEOUT_MS = 5000;

/**
 * How long the *board search* may take.
 *
 * Its own budget again, and more generous than a poll's for the reason that
 * makes this read different from the other two: it is one request that Jira has
 * to answer by running a JQL query across a whole account's issues, where the
 * others are indexed lookups of one key. Ten seconds is still an order of
 * magnitude inside the reconciler's cycle, so a slow search cannot stack ticks.
 *
 * Giving up early would be the expensive mistake here, not the cheap one. A
 * timeout is a failed read, a failed read converges nothing (KAN-221), and a
 * budget tight enough to trip on a merely slow Jira would turn a bad afternoon
 * into a fleet that nothing manages — which is the same silent stall the guard
 * exists to make loud.
 */
export const BOARD_TIMEOUT_MS = 10_000;

/**
 * How long a *proxied* read may take — the Atlassian proxy, KAN-272.
 *
 * Its own budget for a fourth reason again, and the most generous of the four.
 * The other three are background: a tab change, a poll tick, a reconciler
 * cycle, none of them with anybody waiting. A proxied read is a **foreground**
 * request — an agent has made a tool call and its model is blocked until this
 * answers — and the cost of giving up early is not a slower UI, it is an agent
 * told "Atlassian did not respond" about a Jira that was merely having a slow
 * minute. That is the misdiagnosis this whole file exists to stop producing.
 *
 * Bounded well inside `mcp.ts`'s own 30s daemon-request deadline, so a stalled
 * read is reported by *this* end, with legs and a diagnosis, rather than by the
 * agent's end as a bare "Daemon request timed out" that names nothing.
 */
export const PROXY_TIMEOUT_MS = 15_000;

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

/**
 * Which Atlassian host a path belongs to (KAN-292).
 *
 * The transport's own spelling of `atlassian-proxy.ts`'s `ProxyProduct`. It is
 * restated here rather than imported because the dependency runs the other way
 * — this file is the seam the proxy borrows, and a transport that imported the
 * proxy's types would make the low-level module depend on the policy one.
 */
export type TransportProduct = 'jira' | 'confluence' | 'site';

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
   *
   * `product` (KAN-292) selects which host the path is appended to, and does
   * **nothing else**. It defaults to `jira`, so every caller that predates
   * Confluence keeps the behaviour it had. See {@link TokenJiraTransport.baseFor}
   * for what each value routes at, and note that it cannot widen anything: the
   * path is still built by `atlassian-proxy.ts` from validated arguments, and a
   * product only decides which of three fixed origins it is joined to.
   */
  get(path: string, signal: AbortSignal, product?: TransportProduct): Promise<JiraResponse>;
  /**
   * POST a Jira REST path with a JSON body (KAN-291).
   *
   * Same contract as {@link get} in every respect that matters — reject rather
   * than resolve on transport failure, never let a credential reach the
   * rejection value, always report legs — and one addition: **the body is
   * serialised by the implementation, from an object the caller built**. An
   * implementation that took a pre-serialised string would let a caller
   * assemble JSON, and assembling JSON is how a caller ends up able to send a
   * field nobody meant to grant.
   *
   * On this interface rather than on a separate one because the alternative was
   * a `WritableJiraTransport` that every implementation would implement anyway:
   * the auth, the cloud-ID resolution and the gateway/site fallback are the
   * whole of what a transport is, and they are identical for both verbs.
   */
  post(path: string, body: unknown, signal: AbortSignal): Promise<JiraResponse>;
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
 * against the site host directly. Butchr asks for a scoped token — 
 * `read:jira-work`, plus `write:jira-work` only if the operator intends to
 * enable the write proxy (KAN-291) — so the gateway is the primary path. But a
 * user who
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
    method: 'GET' | 'POST',
    path: string,
    // `requestBody`, not `body`: the response body is destructured under that
    // name a few lines down, and two different bodies sharing one identifier in
    // one method is precisely the sort of thing that reads fine and sends the
    // wrong one.
    requestBody: unknown,
    signal: AbortSignal
  ): Promise<{ status?: number; body: any; leg: JiraLegResult }> {
    // The path is what identifies the endpoint; auth travels in a header, so
    // there is nothing credential-shaped in this string. Scrubbed regardless.
    const endpoint = this.scrub(`${base}${path}`);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json',
          // Only on a request that has one. Sending `Content-Type` on a GET is
          // harmless but says something untrue about the request, and this
          // file's whole argument is that a thing which says more than it does
          // is the defect.
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {})
        },
        // Serialised here rather than by the caller — see `JiraTransport.post`.
        ...(method === 'POST' ? { body: JSON.stringify(requestBody ?? {}) } : {}),
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

  /**
   * Where a product's requests go, at each of the two legs.
   *
   * THE GATEWAY BASE IS THE ONLY THING A PRODUCT CHANGES. At the site host,
   * Jira and Confluence are already distinguished by the path itself —
   * Confluence's own paths begin `/wiki` — so the site leg is identical for
   * both and this returns the bare site URL for each.
   *
   * `site` is the exception in the other direction: `/_edge/tenant_info` is
   * site metadata served by neither product's API, and it has **no gateway
   * form at all**. Returning `null` for its gateway base is what makes
   * {@link request} skip that leg rather than spend a request discovering the
   * same thing on every call.
   */
  private baseFor(product: TransportProduct, cloudId: string | null) {
    switch (product) {
      case 'confluence':
        return {
          gateway: cloudId ? `${this.gatewayOrigin}/ex/confluence/${cloudId}` : null,
          site: this.cred.siteUrl
        };
      case 'site':
        return { gateway: null, site: this.cred.siteUrl };
      case 'jira':
      default:
        return {
          gateway: cloudId ? `${this.gatewayOrigin}/ex/jira/${cloudId}` : null,
          site: this.cred.siteUrl
        };
    }
  }

  public async get(
    path: string,
    signal: AbortSignal,
    product: TransportProduct = 'jira'
  ): Promise<JiraResponse> {
    return this.request('GET', path, undefined, signal, product);
  }

  /**
   * The write half (KAN-291). Identical routing to {@link get}, deliberately.
   *
   * A separate path for writes — skipping the gateway, say, or not falling back
   * to the site host — would mean a write could succeed where a read failed or
   * the reverse, and the fleet would have two different answers to "is Atlassian
   * reachable". One router, both verbs.
   */
  public async post(path: string, body: unknown, signal: AbortSignal): Promise<JiraResponse> {
    return this.request('POST', path, body, signal);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    signal: AbortSignal,
    product: TransportProduct = 'jira'
  ): Promise<JiraResponse> {
    const legs: JiraLegResult[] = [];
    const cloudId = await this.resolveCloudId(signal);
    if (this.cloudIdLeg) legs.push(this.cloudIdLeg);

    const base = this.baseFor(product, cloudId);

    if (base.gateway) {
      const viaGateway = await this.attempt('gateway', base.gateway, method, path, body, signal);
      legs.push(viaGateway.leg);
      if (viaGateway.status !== undefined && viaGateway.status !== 401 && viaGateway.status !== 403) {
        return { status: viaGateway.status, body: viaGateway.body, legs };
      }
      // Fall through on 401/403 — probably a classic token, which the gateway
      // rejects — and also on a transport failure, since a reachable site host
      // is still worth trying when only `api.atlassian.com` is unreachable.
      // Either way both legs end up in the record, which is the point.
    }

    const viaSite = await this.attempt('site', base.site, method, path, body, signal);
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
 * What one issue looks like at the instant it was read.
 *
 * Deliberately the *smallest* shape the poller can do its job with. Notably
 * absent: comment bodies and authors. Bodies are not needed because a nudge is
 * a pointer and never content — the recipient re-reads the ticket, which is
 * where the words live and stay current. Authors are not needed because they
 * cannot answer the only question that would justify keeping them: every agent
 * reaches Jira through the same shared account, so `author` on a comment says
 * "somebody in this fleet" and never which agent. Holding data that cannot
 * decide anything is how a read-only client grows a reason to widen its scope.
 */
export interface JiraIssueSnapshot {
  /** The key as Jira spells it, echoed back from the response when it has one. */
  key: string;
  /** `In Progress`, `Done`, … or null when the response carried no status. */
  statusName: string | null;
  /** Jira's own `updated` stamp. Diagnostic only; the poller diffs on events. */
  updated: string | null;
  /** Comment ids, in the order Jira returned them. Ids only — see above. */
  commentIds: string[];
  /** Keys of every issue linked to this one, in either direction, de-duplicated. */
  linkedKeys: string[];
  /**
   * The key of the issue this one sits under on the board, or null.
   *
   * Jira's **own** `parent` — the epic a task belongs to, the epic a story
   * belongs to — and deliberately not a synonym for anything else that has been
   * called a parent around here. KAN-230: the poller had one relation named
   * `parent` and it meant `activatedBy`, the agent that *staffed* another agent.
   * The two coincide whenever an epic activates its own task directly and come
   * apart everywhere else, and since the board reconciler started most agents
   * (KAN-221/222, which passes no `activatedBy` and is right not to) they come
   * apart in the common case: a task with `activatedBy: null` whose epic is
   * live and has no way to be told the task's PR is waiting.
   *
   * Carried here rather than fetched separately because it arrives in the same
   * GET for the cost of one more name in {@link WATCH_FIELDS} — see there.
   */
  parentKey: string | null;
}

/**
 * The `fields` this read asks for. One GET, no expansion, nothing extra.
 *
 * `parent` is the newest and the one worth a sentence, because it is free and
 * that is not obvious. Jira returns exactly the fields a request names, so
 * adding it costs no extra round trip and no extra rate-limit budget — the
 * arithmetic in `POLL_INTERVAL_MS` (jira-poll.ts) is unchanged. It is also the
 * reason this constant is exported: a proof that fed the parser its own body
 * would pass with `parent` missing from here and the feature dead in
 * production, so `verify-jira-parent-topology.mjs` asserts on the request
 * rather than on a snapshot it built itself.
 */
export const WATCH_FIELDS = 'status,updated,comment,issuelinks,parent';

/**
 * One issue as the board reconciler needs to see it (KAN-221).
 *
 * Three fields, and the third is the one with a history. `issueTypeName` is
 * carried because it comes back in the same payload for free and because the
 * alternative — deriving a workspace type from the issue's URL — is a defect
 * this codebase has already paid for. KAN-196: a URL-guessed type fell back to
 * `task` and started `task/KAN-39` alongside a live `epic/KAN-39`, and the
 * collision's failure mode was killing the epic agent's PTY. A loop that
 * guesses types recreates that on a timer.
 *
 * It is `string | null` rather than `string` for the same reason
 * {@link JiraIssueSnapshot.statusName} is: a response that carried no type is
 * an unanswered question, and the caller's job is to decline to act on it. It
 * must **not** be defaulted here — see
 * `workspaceTypeForJiraIssueTypeStrict` in integrations/atlassian-integration.ts
 * for why this read gets the strict mapping and URL resolution keeps the
 * lenient one.
 */
export interface JiraBoardIssue {
  key: string;
  /** `In Progress`, `In Review`, … or null when the row carried no status. */
  statusName: string | null;
  /** `Task`, `Story`, `Epic`, … as Jira spells it, or null when absent. */
  issueTypeName: string | null;
  /**
   * Who the issue is assigned to, or null for **genuinely unassigned**.
   *
   * KAN-256 is why this is read at all, and the null is load-bearing rather
   * than incidental. The reconciler's query has two conditions and its
   * stand-down sentence named only one of them, so a ticket that was In
   * Progress with an empty assignee was reported as *"the board does not have
   * it In Progress or In Review"* — a false statement in a log line, which on
   * 2026-08-10 sent an operator to check the status of an epic whose status was
   * correct. Distinguishing *no assignee* from *somebody else's* needs the
   * field itself; the set difference between the two queries cannot do it.
   *
   * `null` here means Jira returned no assignee. It does **not** mean the field
   * was absent from the response — the board search always asks for it — and
   * nothing downstream may treat the two as the same, which is why the account
   * id and the display name are separate fields rather than one string.
   */
  assigneeAccountId: string | null;
  /** The assignee's display name, for log lines that name a person. */
  assigneeDisplayName: string | null;
}

/**
 * A page of board results, and whether it was the whole answer.
 *
 * `complete` is not a nicety. "The board wants these five issues" and "the
 * board wants these five issues *and some number of others I did not see*" are
 * different facts, and a reconciler that acts on the second stands down every
 * agent whose ticket fell off the page. A partial page is therefore treated as
 * a failed read rather than as a result — see {@link JiraBoardOutcome}.
 */
export interface JiraBoardPage {
  issues: JiraBoardIssue[];
  complete: boolean;
}

/**
 * The `fields` the board search asks for. Nothing else is read.
 *
 * `assignee` joined the list for KAN-256. The main query cannot need it — every
 * row it returns satisfies `assignee = currentUser()` by construction — but the
 * *diagnostic* query drops that half of the condition deliberately, and then the
 * field is the only thing that separates *nobody* from *somebody else*. One
 * field list rather than two: a second one would be a second thing to keep in
 * step with `boardPageFrom`, for one string.
 */
const BOARD_FIELDS = 'status,issuetype,assignee';

/**
 * How many issues one board search may return.
 *
 * "Bounded" in *one bounded JQL per cycle* is this number. A hundred is far
 * above any fleet this machine can carry — the capacity model derives 18 to 21
 * task agents from this hardware — so exceeding it means the query is not the
 * one anybody intended, and the completeness check turns that into a refusal to
 * converge rather than into a mass stand-down.
 */
export const BOARD_MAX_RESULTS = 100;

/**
 * The search endpoint, established by running it rather than by remembering it.
 *
 * `/rest/api/3/search` — the one most references still name — answers **HTTP
 * 410 Gone** on this site, with a body reading *"The requested API has been
 * removed. Please migrate to the /rest/api/3/search/jql API."* Probed against
 * the live instance on 2026-08-08 before this client was written. Recorded here
 * because a 410 is the failure this whole design is built to survive quietly:
 * the guard would have converged nothing, forever, correctly and invisibly.
 */
const SEARCH_PATH = '/rest/api/3/search/jql';

/**
 * The Jira client. Three domain reads, validation, and — since KAN-291 — one
 * proxied read and one proxied write.
 *
 * It stopped being "the read-only Jira client" on 2026-08-11; see the module
 * header for what replaced that rule and why the premise it rested on is gone.
 * The write is a single POST made on an agent's behalf and never on the
 * daemon's own account.
 */
export class JiraClient {
  constructor(private transport: JiraTransport) {}

  /**
   * The status, comment ids, and links of one issue, in a single GET.
   *
   * One request per key rather than a JQL search over the whole fleet. A search
   * would be fewer requests, and it cannot carry `issuelinks` or comment ids
   * per issue in the same response — so it would trade one request per issue
   * for one request per issue *plus* a search, which is not a saving. Per-key
   * also fails per-key: a renamed or deleted ticket costs its own poll a 404
   * instead of taking the whole sweep down with it.
   */
  public async getIssueSnapshot(key: string, signal: AbortSignal): Promise<JiraIssueSnapshot> {
    const { status, body } = await this.transport.get(
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=${WATCH_FIELDS}`,
      signal
    );
    if (status !== 200) {
      throw new JiraRequestError(`issue snapshot returned HTTP ${status}`, status);
    }
    return snapshotFrom(key, body);
  }

  /**
   * Every issue a JQL query matches, in one request.
   *
   * The whole fleet's desired state for the price of one round trip, which is
   * what makes a per-cycle read affordable at all. See the module header for
   * why this coexists with {@link getIssueSnapshot}'s argument against it.
   */
  public async searchBoard(
    jql: string,
    maxResults: number,
    signal: AbortSignal
  ): Promise<JiraBoardPage> {
    const { status, body } = await this.transport.get(
      `${SEARCH_PATH}?jql=${encodeURIComponent(jql)}` +
        `&fields=${BOARD_FIELDS}&maxResults=${maxResults}`,
      signal
    );
    if (status !== 200) {
      throw new JiraRequestError(`board search returned HTTP ${status}`, status);
    }
    return boardPageFrom(body, maxResults);
  }

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
   * Perform one read on behalf of an agent, and hand back everything about how
   * it went (KAN-272).
   *
   * WHY THIS ONE TAKES A PATH WHEN NOTHING ELSE HERE DOES
   *
   * Because it has no domain question. The three methods above are named for
   * what the daemon wants to know; this is named for who is asking. The path
   * comes from `atlassian-proxy.ts`'s operation table — never from an agent,
   * never from a request body — and that table is the granted scope. See the
   * module header, item 4.
   *
   * WHY IT DOES NOT THROW ON A NON-200
   *
   * Every other method here throws, and is right to: a 404 from the poller is
   * an exception on a background timer and nobody is waiting on it. Here a
   * caller *is* waiting, the status is the most useful thing in the answer, and
   * the response body of a 400 carries Jira's own explanation of what was wrong
   * with the query. Throwing would discard both and leave the agent with a
   * message this file invented. So the status and the legs come back and
   * {@link JiraIssueTypeService.proxyRead} decides what they mean.
   */
  public async proxyRead(
    path: string,
    signal: AbortSignal,
    product: TransportProduct = 'jira'
  ): Promise<JiraResponse> {
    return this.transport.get(path, signal, product);
  }

  /**
   * Perform one write on behalf of an agent (KAN-291).
   *
   * Everything the docblock above says about `proxyRead` applies unchanged —
   * why it takes a path when nothing else here does, and why it does not throw
   * on a non-200 — and the body is subject to the same rule as the path: it
   * comes from `atlassian-proxy.ts`'s table, built there from validated
   * arguments, never forwarded from a request.
   *
   * ONE THING IS DIFFERENT, AND IT IS THE 204.
   *
   * Jira answers a successful transition with **204 No Content**. So for this
   * one operation an empty body is the *success* shape, which sits awkwardly
   * beside `JiraProxyOutcome`'s promise that there is no success shape carrying
   * an empty body. The promise is kept where it matters: what that sentence
   * exists to forbid is an empty answer that cannot be told apart from a failed
   * one, and the status distinguishes these completely — a 204 is Jira saying
   * it did the thing, and every failure carries a status and a leg. The
   * distinction is asserted rather than assumed: see the write section of
   * `verify-atlassian-proxy-write-scope.mjs`.
   */
  public async proxyWrite(path: string, body: unknown, signal: AbortSignal): Promise<JiraResponse> {
    return this.transport.post(path, body, signal);
  }

  /**
   * Is this credential still accepted at all? One cheap authenticated read.
   *
   * WHY THIS EXISTS — a defect found by KAN-291's probe, in KAN-272's code, on
   * the **read** path as much as the write one.
   *
   * A revoked token against `/rest/api/3/issue/KAN-291` produces
   * `cloud-id=200 gateway=401 site=404`, because Jira answers **404, not 401**,
   * for an issue the caller cannot see — it will not tell an unauthenticated
   * stranger that an issue exists. The final status is therefore 404, and
   * {@link explainProxyFailure} reads a 404 as a query fault and tells the agent
   * *"The daemon's credential worked; the issue does not exist."* Every word of
   * that is wrong, and it is precisely the confident misdiagnosis this file was
   * written to end: the fleet's credential is dead, every agent is about to hit
   * it, and each one is being told it mistyped an issue key.
   *
   * WHY A PROBE RATHER THAN JUST BELIEVING THE 401 LEG. Because a **classic**
   * API token legitimately 401s at the gateway and succeeds at the site host —
   * that fallback is the whole reason `attempt` tries both — so a genuinely
   * missing issue *also* reads `gateway=401 site=404`. Treating any 401 leg as a
   * dead credential would send a human to rotate a perfectly good token every
   * time an agent mistyped a key, which is the same class of confident error
   * pointing the other way. Only asking the credential a question it can answer
   * separates them.
   *
   * WHY `IDENTITY_PROBE` AND NOT `WORK_PROBE`, WHICH IS WHAT VALIDATION USES
   * AND WHAT WAS TRIED FIRST. `WORK_PROBE` — `/rest/api/3/project/search` — is
   * **readable anonymously** on a site that permits anonymous browsing, and
   * wroosbit.atlassian.net is one. Measured 2026-08-11 with a deliberately
   * bogus token: `cloud-id=200 gateway=401 site=200`, a clean 200 for a
   * credential that does not exist. As a liveness check it answers "yes" for
   * every dead token, which is worse than not checking: it would have made this
   * whole method a confident second opinion that was always wrong in the same
   * direction. `/rest/api/3/myself` answered 401 for the same token, because it
   * is about *who you are* and there is no anonymous answer to that.
   *
   * The known ambiguity, stated because `validate` documents it at length: a
   * *scoped* token holding only `read:jira-work` is also refused by `/myself`.
   * It does not bite here, and the reason is structural rather than lucky — a
   * scoped token is accepted **at the gateway**, so its gateway leg succeeds and
   * this method is never reached. Everything that arrives here already has a
   * refused gateway leg, which means a classic token or a dead one, and a live
   * classic token answers `/myself` with a 200.
   *
   * It costs one extra request, on a failure path, only when a credential-
   * bearing leg was refused. Nothing pays for it on the happy path.
   */
  public async credentialStillWorks(signal: AbortSignal): Promise<'live' | 'refused' | 'unknown'> {
    try {
      const { status } = await this.transport.get(IDENTITY_PROBE, signal);
      if (status === 200) return 'live';
      if (status === 401 || status === 403) return 'refused';
      return 'unknown';
    } catch {
      // A dead leg here says nothing about the credential — the network is the
      // more likely explanation, and claiming either way would be inventing a
      // diagnosis, which is the habit this file exists to break.
      return 'unknown';
    }
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
 * Read a snapshot out of whatever Jira returned, trusting none of it.
 *
 * Every field is optional on the way in and defaulted on the way out: a
 * response missing `comment` is an issue with no comments to this reader, not
 * an exception on a background timer. The one thing that is *not* softened is
 * the issue key — a snapshot that cannot name its issue would be filed against
 * the wrong one — so the requested key stands in when the body has none.
 */
export function snapshotFrom(key: string, body: any): JiraIssueSnapshot {
  const fields = body?.fields ?? {};

  const commentIds: string[] = Array.isArray(fields?.comment?.comments)
    ? fields.comment.comments
        .map((comment: any) => (comment?.id === undefined ? '' : String(comment.id)))
        .filter((id: string) => id.length > 0)
    : [];

  // Both directions, because "blocks" and "is blocked by" are the same link
  // seen from two ends and both ends are parties to the news. De-duplicated
  // because two link types between the same pair of issues is one neighbour.
  const linked = new Set<string>();
  if (Array.isArray(fields?.issuelinks)) {
    for (const link of fields.issuelinks) {
      for (const side of [link?.inwardIssue, link?.outwardIssue]) {
        const linkedKey = typeof side?.key === 'string' ? side.key.trim() : '';
        if (linkedKey) linked.add(linkedKey);
      }
    }
  }

  // An issue with no parent is the ordinary case for an epic, and a response
  // that did not carry the field at all is the case when somebody narrows
  // WATCH_FIELDS. Both read as "no parent", which routes to nobody — the same
  // safe direction every other field in this parser defaults towards.
  const parentKey =
    typeof fields?.parent?.key === 'string' && fields.parent.key.trim()
      ? fields.parent.key.trim()
      : null;

  return {
    key: typeof body?.key === 'string' && body.key ? body.key : key,
    statusName: typeof fields?.status?.name === 'string' ? fields.status.name : null,
    updated: typeof fields?.updated === 'string' ? fields.updated : null,
    commentIds,
    linkedKeys: [...linked],
    parentKey
  };
}

/**
 * The outcome of a poll read, with the one distinction the poller acts on.
 *
 * `backOff` is not "did it fail" — it is "is Jira asking to be left alone".
 * A 404 on a renamed ticket is a failure and must *not* slow the sweep down;
 * a 429 or a 503 must. Collapsing the two would either ignore a rate limit or
 * let one dead ticket pace the whole fleet.
 */
export type JiraSnapshotOutcome =
  | { ok: true; snapshot: JiraIssueSnapshot }
  | { ok: false; backOff: boolean; status?: number; error: string };

/**
 * Read a page of board results out of whatever the search returned.
 *
 * WHERE THIS DELIBERATELY DIFFERS FROM {@link snapshotFrom}
 *
 * `snapshotFrom` softens every missing field, and is right to: a response with
 * no `comment` array is an issue with no comments, and a background poller that
 * threw on it would go blind over a nicety. Here the softening would be a
 * *decision* rather than a default. An issue row with no `issuetype` is not "an
 * issue of the usual type"; it is an issue whose type nobody knows, and the one
 * thing this codebase has already learned about guessing that is KAN-196. So
 * the field comes through as null and the reconciler declines to act on the
 * row — the guess never happens here because it never happens anywhere.
 *
 * A row with no `key` is dropped outright rather than nulled: unlike a
 * snapshot, there is no requested key to stand in for it, and an issue that
 * cannot name itself cannot be matched against a running agent.
 *
 * COMPLETENESS, AND WHY THE DEFAULT IS "NO"
 *
 * Jira Cloud's `search/jql` reports exhaustion with `isLast`, and the endpoint
 * it replaced used `startAt`/`total`. Rather than pick one, this asks whether
 * anything *positively says* the page was the whole answer: an explicit
 * `isLast: true`, or an old-shaped response with no continuation token and
 * fewer rows than were asked for. Every other shape — including one this code
 * has never seen — reads as incomplete, which costs a cycle of convergence and
 * cannot cost an agent.
 */
export function boardPageFrom(body: any, maxResults: number): JiraBoardPage {
  const rows: any[] = Array.isArray(body?.issues) ? body.issues : [];

  const issues: JiraBoardIssue[] = [];
  for (const row of rows) {
    const key = typeof row?.key === 'string' ? row.key.trim() : '';
    if (!key) continue;
    const statusName = row?.fields?.status?.name;
    const issueTypeName = row?.fields?.issuetype?.name;
    // `fields.assignee` is null on an unassigned issue — the case this was added
    // for — so the optional chain and the type check are doing different jobs and
    // neither is redundant.
    const assigneeAccountId = row?.fields?.assignee?.accountId;
    const assigneeDisplayName = row?.fields?.assignee?.displayName;
    issues.push({
      key,
      statusName: typeof statusName === 'string' && statusName ? statusName : null,
      issueTypeName: typeof issueTypeName === 'string' && issueTypeName ? issueTypeName : null,
      assigneeAccountId:
        typeof assigneeAccountId === 'string' && assigneeAccountId ? assigneeAccountId : null,
      assigneeDisplayName:
        typeof assigneeDisplayName === 'string' && assigneeDisplayName ? assigneeDisplayName : null
    });
  }

  const complete =
    body?.isLast === true ||
    (body?.isLast === undefined &&
      body?.nextPageToken === undefined &&
      Array.isArray(body?.issues) &&
      rows.length < maxResults);

  return { issues, complete };
}

/**
 * The outcome of a board search — and the distinction the whole reconciler
 * turns on.
 *
 * Same discriminated shape as {@link JiraSnapshotOutcome}, on purpose. The
 * failure this exists to prevent is that "the query failed" and "the board is
 * empty" both produce an empty array, and the reconciler's steps 3 and 4 turn
 * an empty array into *stand the entire fleet down*. Atlassian was unreachable
 * for about two hours on 2026-08-04 (KAN-157); under a loop that could not tell
 * those apart, that outage destroys every running agent's context.
 *
 * A boolean return with an out-of-band error, or a throw the caller might
 * forget to catch, would both leave the distinction to somebody remembering it.
 * A union leaves it to the type checker: there is no `issues` to read on the
 * failure branch, so a caller that skips the check does not compile.
 *
 * This is the same bug class `waitForHerdr` (reconcile.ts) exists for —
 * `listHerdrAgents` returns empty both when herdr has no agents and when herdr
 * could not be reached, and its comment says the distinction "matters
 * enormously here, because 'herdr is not up yet' would otherwise read as 'every
 * agent is missing'". This is that guard, pointed at Jira.
 */
export type JiraBoardOutcome =
  | { ok: true; issues: JiraBoardIssue[] }
  | { ok: false; backOff: boolean; status?: number; error: string };

/**
 * The outcome of a proxied read, and the distinction that is the whole point
 * of KAN-272 (atlassian-proxy.ts).
 *
 * A third shape rather than a reuse of {@link JiraSnapshotOutcome}, because the
 * question a *caller* has to answer is different from the one a poller has.
 * A poller asks "should I slow down?" — hence `backOff`. An agent asks
 * **"is this my problem or the fleet's?"**, and nothing above could tell it.
 *
 * That is exactly the question the 2026-08-10 outage could not answer. Every
 * agent's Atlassian tools were dead for twelve hours, the processes serving
 * them were alive, and what each agent saw was a call that did not work — with
 * no way to tell a bad query from a credential the whole fleet shares and which
 * had expired eleven days earlier. So {@link JiraProxyOutcome.credentialFault}
 * is a separate field from the message: `true` means the daemon's credential
 * was refused or unreachable and **every other agent is about to hit this too**,
 * which is a thing to report to a human rather than to retry; `false` means
 * Atlassian answered and disliked *this* request, which is the agent's own to
 * fix. Reading a failure and not knowing which of those it is, is the defect.
 *
 * There is no success shape carrying an empty body. A proxied read either
 * produces what Atlassian returned or produces a refusal that names a leg —
 * the silent third option is the one that cost twelve hours.
 */
export type JiraProxyOutcome =
  | { ok: true; status: number; body: any }
  | {
      ok: false;
      /** HTTP status, when Atlassian answered at all. Absent on a dead leg. */
      status?: number;
      /** The sentence the agent reads. Never empty, never a bare status. */
      error: string;
      /** Machine-readable, when the legs supported a diagnosis. */
      diagnosis?: JiraDiagnosis;
      /** Every endpoint tried and what it said. Non-secret by construction. */
      legs?: JiraLegResult[];
      /** See the docblock: whose problem this is. */
      credentialFault: boolean;
    };

/**
 * Turn a refused proxied read into the sentence an agent acts on.
 *
 * `explainLegs` is reused for exactly the statuses it is right about — 401 and
 * 403 are auth refusals and its six-case reading of them is the best writing in
 * this file — and deliberately **not** for the others. Pointed at a 404 from an
 * issue read it answers *"there is no Jira REST API there; check the site
 * address"*, which is true of validation and false here: a 404 on
 * `/rest/api/3/issue/KAN-9999` means Jira has no such issue, and sending an
 * agent to check the site address over a mistyped key would be the same class
 * of confident misdiagnosis this file was written to end.
 */
function explainProxyFailure(
  status: number,
  legs: JiraLegResult[],
  write = false,
  // KAN-292: which product actually refused. It was `Jira` in every sentence
  // below until Confluence reads existed, and a Confluence 400 reported as
  // "Jira rejected this request" sends the reader to the wrong API's
  // documentation — found by `probe-atlassian-proxy-read-surface.mjs`, which
  // met exactly that message on a Confluence endpoint. The 401/403 sentences
  // deliberately do NOT take it: those are about the credential, which is one
  // credential for both products, so naming a product there would suggest the
  // other one still worked.
  product: TransportProduct = 'jira'
): { error: string; diagnosis?: JiraDiagnosis; credentialFault: boolean } {
  const said_by = product === 'confluence' ? 'Confluence' : 'Jira';
  // KAN-291: on a write, a 403 has one overwhelmingly likely cause that a read
  // can never have — a credential minted with `read:jira-work` and nothing
  // else, which is exactly what the settings page instructed every existing
  // user to create. Saying "replace the credential" without saying *with what*
  // would send a human to mint the same token again and meet the same 403.
  if (status === 403 && write) {
    const explained = explainLegs(legs.filter((leg) => leg.leg !== 'cloud-id'));
    return {
      error:
        "The Butchr daemon's own Atlassian credential was refused for a WRITE (HTTP 403). It " +
        'authenticated, so the token is live — it is not permitted to change this issue. The ' +
        'likeliest cause by far is that the token holds read:jira-work and not write:jira-work: ' +
        'Butchr asked for read scope only until 2026-08-11, so a credential configured before ' +
        'then cannot write however valid it is. A human replaces it in Butchr settings with a ' +
        'token carrying write:jira-work. The second possibility is that this Jira account may ' +
        'not perform this transition on this issue, which no token change fixes. Nothing was ' +
        `written. ${explained.error}`,
      diagnosis: explained.diagnosis,
      credentialFault: true
    };
  }

  if (status === 401 || status === 403) {
    // Only the legs that carried a credential. The cloud-ID leg is
    // unauthenticated by construction — it is the one leg that needs no token —
    // so it cannot answer "which credential-bearing endpoint refused this and
    // what did it say", and `explainLegs` reads it *first*: a site whose
    // `_edge/tenant_info` answered without a cloudId outranks an explicit 401
    // there, and the agent would be sent to check the site address over a
    // credential that had plainly been revoked. That ordering is right for
    // validation, where the site address is genuinely in doubt, and wrong here,
    // where the transport is already established and the only question is auth.
    const explained = explainLegs(legs.filter((leg) => leg.leg !== 'cloud-id'));
    return {
      error:
        `The Butchr daemon's own Atlassian credential was refused (HTTP ${status}). This is ` +
        'not your query and retrying will not help — every agent using this proxy is about to ' +
        'see the same thing, and a human has to replace the credential in Butchr settings. ' +
        `${explained.error}`,
      diagnosis: explained.diagnosis,
      credentialFault: true
    };
  }

  // Jira's own words about the refusal, where it offered any. Worth more than
  // anything invented here — see `extractDetail`.
  const said = legs.map((leg) => leg.detail).filter((detail): detail is string => !!detail);
  const because = said.length ? ` ${said_by} said: ${said[said.length - 1]}` : '';

  if (status === 404) {
    return {
      error:
        `${said_by} answered 404 for this request. The daemon's credential worked; the issue, ` +
        `page or endpoint asked for does not exist, or this account cannot see it.${because}`,
      credentialFault: false
    };
  }
  if (status === 400) {
    return {
      error: `${said_by} rejected this request as malformed (400).${because}`,
      credentialFault: false
    };
  }
  if (status === 429) {
    return {
      error:
        'Atlassian is rate-limiting this credential (429). It is shared by the whole fleet, ' +
        `so backing off rather than retrying immediately is the cooperative move.${because}`,
      credentialFault: false
    };
  }
  if (status >= 500) {
    return {
      error: `Atlassian returned HTTP ${status} — a fault on their side, not with the credential or the query.${because}`,
      credentialFault: false
    };
  }
  return {
    error: `Atlassian returned HTTP ${status}, which this proxy has no specific reading of.${because}`,
    credentialFault: false
  };
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
 *
 * It is also where the poll read lives ({@link pollIssue}), because it owns the
 * credential and the transport and a second owner would be a second thing to
 * migrate when the auth seam is used. The two reads share nothing else — not
 * the cache, not the timeout, not the failure cooldown — and the reasons are on
 * `pollIssue`.
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
    private validateTimeoutMs: number = VALIDATE_TIMEOUT_MS,
    /** Separate again, and for the opposite reason: see POLL_TIMEOUT_MS. */
    private pollTimeoutMs: number = POLL_TIMEOUT_MS,
    /** Separate for a third reason again: see BOARD_TIMEOUT_MS. */
    private boardTimeoutMs: number = BOARD_TIMEOUT_MS
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
   * One issue's current status, comment ids, and links — or why not.
   *
   * WHY THIS LIVES ON THE ISSUE-TYPE SERVICE
   *
   * Because this class is the daemon's only holder of a Jira transport, and a
   * second holder would mean a second credential load, a second cloud-ID
   * lookup, and two places that have to be taught about OAuth on the day the
   * seam is finally used. The poller borrows the transport; it does not learn
   * what a token is. (KAN-79.)
   *
   * WHY IT DOES NOT TOUCH THE FAILURE COOLDOWN
   *
   * `failingUntil` exists so that an unreachable Jira does not cost the full
   * timeout on every tab change, and the price of it is that lookups answer
   * `null` — "assume the default workspace type" — for 30 seconds. Letting a
   * poll set that flag would mean a Jira rate limit hit by a background timer
   * silently downgraded a user's Story workspace to a `task` one. Letting a
   * poll *read* it would mean an unrelated tab-change failure blinded the
   * poller. The two degrade separately, on their own evidence; the poller's
   * own back-off is in jira-poll.ts.
   *
   * Never throws, like everything else this service exposes.
   */
  public async pollIssue(key: string): Promise<JiraSnapshotOutcome> {
    const transport = await this.getTransport();
    if (!transport) {
      // The ordinary state for a machine with no credential. Not an error, and
      // deliberately not a reason to back off: there is nothing to back off
      // from, and the poller checks this before it counts a failure.
      return { ok: false, backOff: false, error: 'no Jira credential configured' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.pollTimeoutMs);
    try {
      const snapshot = await new JiraClient(transport).getIssueSnapshot(key, controller.signal);
      return { ok: true, snapshot };
    } catch (err: any) {
      const status: number | undefined = typeof err?.status === 'number' ? err.status : undefined;
      // 429 and 5xx are Jira asking for room. A transport failure joins them:
      // hammering a host that is not answering is the same mistake with a
      // different cause. Everything else — 401, 403, 404 — is about this one
      // request and pacing the fleet on it would be wrong.
      const backOff = status === 429 || (status !== undefined && status >= 500) || status === undefined;
      return {
        ok: false,
        backOff,
        ...(status !== undefined ? { status } : {}),
        // Message only, never the error object: on a fetch failure its
        // properties can include the request that produced it.
        error: err?.message ?? 'unknown error'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Every issue the board says should be running — or why that is not known.
   *
   * Lives here for the reason `pollIssue` does: this class is the daemon's only
   * holder of a Jira transport, and a second holder would be a second
   * credential load, a second cloud-ID lookup, and a second place to teach
   * about OAuth on the day the auth seam is used.
   *
   * It touches the failure cooldown for neither reading nor writing, on the
   * same argument `pollIssue` makes at length: a background timer's bad minute
   * must not silently downgrade a user's Story workspace to a `task` one, and
   * an unrelated tab-change failure must not blind the reconciler. The three
   * reads degrade separately, on their own evidence.
   *
   * A PARTIAL PAGE IS A FAILURE, NOT A RESULT
   *
   * `complete: false` comes back as `ok: false`, with `backOff: false` — Jira
   * answered, and answered promptly; it is not asking to be left alone, it just
   * did not answer the question that was asked. Reporting it as a success with
   * a truncated list would hand the reconciler the exact input that makes step
   * 4 destructive. See {@link boardPageFrom}.
   *
   * Never throws, like everything else this service exposes.
   */
  public async searchBoard(
    jql: string,
    maxResults: number = BOARD_MAX_RESULTS
  ): Promise<JiraBoardOutcome> {
    const transport = await this.getTransport();
    if (!transport) {
      // The ordinary state for a machine with no credential, and — like
      // pollIssue's — not a reason to back off from a request nobody made.
      // It is still `ok: false`: a fleet must not be stood down because
      // nobody has opened the settings page.
      return { ok: false, backOff: false, error: 'no Jira credential configured' };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.boardTimeoutMs);
    try {
      const page = await new JiraClient(transport).searchBoard(jql, maxResults, controller.signal);
      if (!page.complete) {
        return {
          ok: false,
          backOff: false,
          error:
            `the board search returned a partial page (${page.issues.length} issue(s), ` +
            `asked for up to ${maxResults}, and Jira did not say that was all of them)`
        };
      }
      return { ok: true, issues: page.issues };
    } catch (err: any) {
      const status: number | undefined = typeof err?.status === 'number' ? err.status : undefined;
      // Same reading of the status as pollIssue: 429 and 5xx are Jira asking
      // for room, and a transport failure joins them because hammering a host
      // that is not answering is the same mistake with a different cause.
      const backOff = status === 429 || (status !== undefined && status >= 500) || status === undefined;
      return {
        ok: false,
        backOff,
        ...(status !== undefined ? { status } : {}),
        // Message only, never the error object: on a fetch failure its
        // properties can include the request that produced it.
        error: err?.message ?? 'unknown error'
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * One read made on an agent's behalf — or a refusal that says whose problem
   * it is (KAN-272).
   *
   * Lives here for the reason `pollIssue` and `searchBoard` do, and it is the
   * reason those two give: this class is the daemon's only holder of a Jira
   * transport, and a second holder would be a second credential load, a second
   * cloud-ID lookup, and a second place to teach about OAuth on the day the
   * auth seam is used. The proxy borrows the transport; `atlassian-proxy.ts`
   * never learns what a token is, and neither does `router.ts`.
   *
   * IT TOUCHES THE FAILURE COOLDOWN IN NEITHER DIRECTION, and here the argument
   * `pollIssue` makes at length has a fourth leg. Letting a proxied read *set*
   * `failingUntil` would let one agent's mistyped JQL silently downgrade a
   * user's Story workspace to a `task` one for thirty seconds. Letting it
   * *read* the flag would be worse than blinding: the agent would be told
   * nothing at all, on a foreground call, because an unrelated tab change
   * failed — a silent empty answer, which is the precise failure mode this
   * whole ticket exists to remove. The four reads degrade separately, on their
   * own evidence.
   *
   * Never throws, like everything else this service exposes.
   */
  public async proxyRead(
    path: string,
    product: TransportProduct = 'jira'
  ): Promise<JiraProxyOutcome> {
    return this.proxyCall('GET', path, undefined, product);
  }

  /**
   * One write made on an agent's behalf — or a refusal that says whose problem
   * it is (KAN-291).
   *
   * Shares {@link proxyCall} with the read for the reason this class exists at
   * all: the "no credential" refusal, the timeout, the credential-fault
   * distinction and the loudness guarantee are properties of *proxying*, not of
   * a verb, and a second copy of them is a second one to get wrong. What the
   * verb changes is the 403, which for a write is very often a credential
   * holding read scope only — see {@link explainProxyFailure}.
   *
   * WHAT THIS DOES NOT DO, BECAUSE SOMEBODY WILL LOOK FOR IT HERE: it does not
   * decide **who** may write to **what**. That is `atlassian-proxy.ts`'s
   * `refuseWriteOutsideCaller`, applied by `router.ts` before this is reached.
   * Putting it here would have hidden a policy question inside a transport, and
   * this file would then have had an opinion about workspace identity, which is
   * a thing it has never needed to know.
   *
   * Never throws, like everything else this service exposes.
   */
  public async proxyWrite(path: string, body: unknown): Promise<JiraProxyOutcome> {
    return this.proxyCall('POST', path, body);
  }

  private async proxyCall(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    product: TransportProduct = 'jira'
  ): Promise<JiraProxyOutcome> {
    const write = method !== 'GET';
    const transport = await this.getTransport();
    if (!transport) {
      // Distinct from every other refusal, and the wording matters: an agent
      // must not read "no credential" as "Jira is down". Nothing is broken —
      // nobody has configured one — and the agent's own Atlassian session is
      // unaffected and is the thing to use.
      return {
        ok: false,
        credentialFault: true,
        error:
          `The Butchr daemon has no Atlassian credential configured, so it cannot make this ` +
          `${write ? 'write' : 'read'} for you. Nothing is broken and Jira is not down: a ` +
          "human configures one in Butchr's settings. Use this agent's own Atlassian MCP " +
          'tools meanwhile.'
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
    try {
      const client = new JiraClient(transport);
      const { status, body: responseBody, legs } = write
        ? await client.proxyWrite(path, body, controller.signal)
        : await client.proxyRead(path, controller.signal, product);
      // 204 included, which is how Jira reports a transition it performed. See
      // `JiraClient.proxyWrite` on why an empty body is a success shape here and
      // is still distinguishable from a silent failure.
      if (status >= 200 && status < 300) return { ok: true, status, body: responseBody };

      const explained = explainProxyFailure(status, legs, write, product);

      // KAN-291. About to tell an agent that its *query* was at fault — while a
      // credential-bearing leg was refused. That combination is exactly the
      // revoked-token-reads-as-404 case in `credentialStillWorks`, and it is
      // also what a classic token plus a genuinely missing issue looks like.
      // Ask, rather than guess: the whole cost of getting this wrong is a
      // fleet-wide outage diagnosed as one agent's typo.
      const refusedLeg = legs.some(
        (leg) => leg.leg !== 'cloud-id' && (leg.status === 401 || leg.status === 403)
      );
      if (!explained.credentialFault && refusedLeg) {
        const verdict = await client.credentialStillWorks(controller.signal);
        if (verdict === 'refused') {
          return {
            ok: false,
            status,
            legs,
            credentialFault: true,
            error:
              `Atlassian answered ${status} for this ${write ? 'write' : 'read'}, but that is ` +
              "NOT a fault in your request: the Butchr daemon's own credential is no longer " +
              'being accepted, confirmed by a second probe just now. Jira answers 404 rather ' +
              'than 401 for an issue the caller may not see, so a dead credential looks exactly ' +
              'like a missing issue — it is not. Retrying will not help and neither will ' +
              'checking your issue key; every agent using this proxy is about to see the same ' +
              'thing, and a human has to replace the credential in Butchr settings. ' +
              `${write ? 'Nothing was written. ' : ''}`
          };
        }
        if (verdict === 'unknown') {
          return {
            ok: false,
            status,
            legs,
            credentialFault: false,
            error:
              `${explained.error} (Butchr could not confirm whether its own credential is still ` +
              'good — the check for that did not complete — so treat this reading as less ' +
              'certain than it sounds, and check Butchr settings if it repeats.)',
            ...(explained.diagnosis ? { diagnosis: explained.diagnosis } : {})
          };
        }
      }

      return { ok: false, status, legs, ...explained };
    } catch (err: any) {
      // No leg completed — the transport rejects rather than resolves for that
      // case, carrying the legs on the error precisely so this is answerable.
      // A dead leg is a credential fault in the sense that matters to the
      // caller: it is the fleet's problem and not the query's, and the whole
      // fleet is about to meet it.
      const legs: JiraLegResult[] = Array.isArray(err?.legs) ? err.legs : [];
      const explained = legs.length ? explainLegs(legs) : null;
      return {
        ok: false,
        credentialFault: true,
        ...(legs.length ? { legs } : {}),
        ...(explained?.diagnosis ? { diagnosis: explained.diagnosis } : {}),
        error:
          `The Butchr daemon could not reach Atlassian at all for this ${write ? 'write' : 'read'}.` +
          (write
            ? ' NOTHING WAS WRITTEN — no leg completed, so the request never reached Jira. ' +
              'This is safe to retry once the fleet is reachable again. '
            : ' ') +
          'Every agent using this proxy is about to see the same thing. ' +
          // Message only, never the error object: on a fetch failure its
          // properties can include the request that produced it.
          (explained?.error ?? String(err?.message ?? 'unknown error'))
      };
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
