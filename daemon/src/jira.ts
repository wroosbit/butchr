import { CredentialStore, CredentialStatus, JiraCredential } from './credentials.js';

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
   * must never let a credential reach the rejection value.
   */
  get(path: string, signal: AbortSignal): Promise<{ status: number; body: any }>;
  /** Non-secret description, safe for logs. */
  describe(): string;
}

/**
 * Strip a secret from anything about to be logged.
 *
 * Belt and braces. Nothing here intentionally puts a token in a message, but
 * error paths are exactly where secrets leak in practice — a `fetch` failure,
 * a JSON parse error quoting its input, a stack frame with an inlined literal.
 * Every string this module logs goes through here first.
 */
export function redact(text: string, secret?: string): string {
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join('***REDACTED***');
}

/** The error surface callers get. Never carries request headers or a token. */
class JiraRequestError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'JiraRequestError';
  }
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
  private authHeader: string;

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
    this.authHeader =
      'Basic ' + Buffer.from(`${cred.email}:${cred.token}`).toString('base64');
  }

  public describe(): string {
    // Site and account are not secrets; the token is, and is not here.
    return `api-token(${this.cred.email} @ ${this.cred.siteUrl})`;
  }

  private async resolveCloudId(signal: AbortSignal): Promise<string | null> {
    if (this.cloudId) return this.cloudId;
    try {
      const res = await fetch(`${this.cred.siteUrl}/_edge/tenant_info`, { signal });
      if (!res.ok) return null;
      const body: any = await res.json();
      this.cloudId = typeof body?.cloudId === 'string' ? body.cloudId : null;
      return this.cloudId;
    } catch {
      // No cloud ID means no gateway path; the site-host attempt still stands.
      return null;
    }
  }

  private async attempt(
    base: string,
    path: string,
    signal: AbortSignal
  ): Promise<{ status: number; body: any }> {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method: 'GET',
        headers: {
          Authorization: this.authHeader,
          Accept: 'application/json'
        },
        signal
      });
    } catch (err: any) {
      // Rebuild the message rather than forwarding it: this is the path where
      // a helpful runtime is most likely to quote something it should not.
      throw new JiraRequestError(
        redact(`request failed: ${err?.name ?? 'Error'}`, this.cred.token)
      );
    }

    let body: any = null;
    try {
      body = await res.json();
    } catch {
      // Error responses are not always JSON. The status is what matters.
    }
    return { status: res.status, body };
  }

  public async get(path: string, signal: AbortSignal): Promise<{ status: number; body: any }> {
    const cloudId = await this.resolveCloudId(signal);

    if (cloudId) {
      const viaGateway = await this.attempt(
        `${this.gatewayOrigin}/ex/jira/${cloudId}`,
        path,
        signal
      );
      if (viaGateway.status !== 401 && viaGateway.status !== 403) return viaGateway;
      // Fall through: probably a classic token, which the gateway rejects.
    }

    return this.attempt(this.cred.siteUrl, path, signal);
  }
}

/** Outcome of checking a credential at the moment the user submits it. */
export interface ValidationResult {
  valid: boolean;
  /** Non-secret, user-facing explanation when invalid. */
  error?: string;
  /** Display name of the authenticated account, when valid. */
  accountName?: string;
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
   * One cheap authenticated read, used to tell the user at submit time whether
   * the credential they just typed actually works.
   *
   * `/myself` rather than an issue fetch on purpose: it depends on no
   * particular issue existing, and it distinguishes "bad credential" from
   * "issue not found" cleanly. An unauthenticated issue read returns 404, not
   * 401, so it cannot tell those apart.
   */
  public async validate(signal: AbortSignal): Promise<ValidationResult> {
    const { status, body } = await this.transport.get('/rest/api/3/myself', signal);

    if (status === 200) {
      const name = body?.displayName;
      return {
        valid: true,
        ...(typeof name === 'string' && name ? { accountName: name } : {})
      };
    }
    if (status === 401) {
      return { valid: false, error: 'Atlassian rejected the email and API token (401).' };
    }
    if (status === 403) {
      return {
        valid: false,
        error:
          'The token authenticated but is not permitted to read Jira (403). Check that it has the read:jira-work scope.'
      };
    }
    if (status === 404) {
      return {
        valid: false,
        error: 'No Jira found at that site URL (404). Check the site address.'
      };
    }
    return { valid: false, error: `Atlassian returned HTTP ${status}.` };
  }
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
      new TokenJiraTransport(cred)
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
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await new JiraClient(this.makeTransport(cred)).validate(
        controller.signal
      );
      if (!result.valid) return result;

      const storage = await this.store.save(cred);
      this.reset();
      return { ...result, storage };
    } catch (err: any) {
      // Abort and transport failures both land here. The message is rebuilt
      // from scratch; nothing from the request is echoed.
      const reason =
        err?.name === 'AbortError'
          ? `Atlassian did not respond within ${this.timeoutMs}ms.`
          : 'Could not reach Atlassian. Check the site URL and your connection.';
      return { valid: false, error: reason };
    } finally {
      clearTimeout(timer);
    }
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
