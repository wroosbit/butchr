import { JIRA_KEY } from './keys.js';

/**
 * The daemon-side Atlassian proxy: which operations agents may reach through
 * the daemon's own credential, and the switch that decides whether any of them
 * are reachable at all (KAN-272).
 *
 * ## What this is for, in one paragraph
 *
 * Every agent reaches Atlassian today through its own `mcp-remote` process
 * holding its own OAuth session. On 2026-08-10 that arrangement took the whole
 * fleet's Jira down for about twelve hours: six per-agent OAuth proxies were
 * dead while the daemon's single API-token credential polled the board every 60
 * seconds throughout. **And the failure lied about itself** — the proxy
 * processes stayed alive holding dead connections, so the tools were still
 * *present* and only a real call could tell you they were dead. This module is
 * the other topology: one credential, held by the daemon, reached over the
 * socket agents already talk to.
 *
 * ## THE RULE THAT DID NOT CHANGE HERE
 *
 * `jira.ts` says it under its own heading and it is still true of this file:
 * **there are no write methods**. Every operation below is a GET, every one of
 * them fits inside `read:jira-work` — the scope the settings page has always
 * asked for — and this module widens the credential's scope by exactly nothing.
 * KAN-272 authorises a reversal of KAN-39's invariant 2; this half of it does
 * not spend that authorisation, deliberately, so that it can be reviewed on
 * engineering grounds alone and reverted without touching the reversal.
 *
 * ## Off by default, and read per call rather than once
 *
 * {@link selectedProxyMode} returns `'off'` for an unset variable, for an empty
 * one, and for anything it does not recognise. The only input that enables
 * anything is the exact string `jira-read`. No truthiness test, no prefix
 * match, no `1` — the discipline `runtime-switch.ts` established for KAN-278,
 * and for its stated reason: falling back to off costs nothing, while falling
 * back to on because somebody typed `jira_read` widens what an entire fleet can
 * do on the strength of a misspelling.
 *
 * It differs from `runtime-switch.ts` in **when** it is read, and the
 * difference is deliberate. A runtime is read once at boot because it owns live
 * sessions that cannot be swapped under them. A proxy owns nothing: it is a
 * function from a request to a GET. So the mode is read **on every call**,
 * which is what makes the off switch work *now* — an operator who decides at
 * 03:00 that agents should stop reaching Atlassian through the daemon
 * unsets the variable and the next call is refused, with no daemon restart and
 * no fleet interruption. For a feature that widens what agents can do, an off
 * switch that needs a restart to take effect is not much of an off switch.
 *
 * ## Where the gate is, and why there is only one of it
 *
 * **In the daemon, and nowhere else.** `mcp.ts` asks this module (through the
 * daemon) what to advertise, but the advertisement is not the gate — the
 * refusal in `handleAtlassianProxyCall` is. An agent that was started while the
 * proxy was on keeps the tool in its list after it is switched off, and its
 * next call is refused with a sentence naming the switch. That is the same
 * arrangement `channel.ts` uses for channel emission, for the same reason: a
 * second gate would be a second copy of one condition, and the copy that drifts
 * is the one that lets something through.
 *
 * It is also why **tool presence is not evidence** here either — which is the
 * property the 2026-08-10 outage turned into a twelve-hour diagnosis. This
 * module makes that explicit rather than incidental: a listed tool says nothing
 * about whether the credential behind it works, and the only thing that does is
 * a call.
 *
 * ## An agent never names a path
 *
 * Every operation builds its own REST path from validated arguments
 * ({@link ProxyOperation.build}). There is deliberately no operation taking a
 * path, a URL or a REST fragment: one would make the granted scope unbounded in
 * a way no reviewer could read off this file, and "the scope actually granted,
 * enumerated field by field" is a KAN-272 acceptance criterion.
 * {@link grantedScopes} and {@link operationsFor} exist so that enumeration is
 * derived from the table below rather than restated in prose beside it.
 */

/**
 * What the proxy is serving.
 *
 * A mode is exactly the set of operations tagged with it, so widening the proxy
 * means adding a mode and tagging operations into it — never loosening a check.
 * KAN-272 names four separate widenings (transitions, issue creation,
 * description edits, Confluence) and says not to grant them as a block; a mode
 * per widening is what makes granting them one at a time the path of least
 * resistance rather than an act of discipline.
 */
export type ProxyMode = 'off' | 'jira-read';

/** The environment variable that selects a mode. */
export const PROXY_ENV_VAR = 'BUTCHR_ATLASSIAN_PROXY';

/** Every mode this daemon knows, for the message an unrecognised value gets. */
export const PROXY_MODES: readonly ProxyMode[] = ['off', 'jira-read'];

/**
 * A GET path built from validated arguments, or the reason it was refused.
 *
 * A refusal is a string rather than a throw because it is an ordinary answer —
 * an agent that passes `KAN 272` has made a typo, not caused an exception — and
 * because the string is what the agent reads.
 */
export type BuildResult = { path: string } | { error: string };

export interface ProxyOperation {
  /** The tool name as agents see it. */
  tool: string;
  /** The mode that enables it. Never `off`. */
  mode: Exclude<ProxyMode, 'off'>;
  /**
   * The Atlassian scope this operation needs.
   *
   * Recorded per operation rather than per mode because that is the granularity
   * a reviewer has to check: "this mode needs read:jira-work" is a claim about
   * a set, and the way a set quietly acquires a wider scope is one member.
   */
  scope: string;
  /** The HTTP method. GET for every operation in this file — see the header. */
  method: 'GET';
  /**
   * The path shape, with its parameters named, for the enumeration in a PR and
   * for a reader who wants to know what the credential is actually used for
   * without reading {@link build}.
   */
  pathShape: string;
  /** What the agent-facing tool description says. */
  description: string;
  /** JSON Schema for the tool's arguments, as MCP wants it. */
  inputSchema: Record<string, unknown>;
  /** Build the concrete path, or refuse. Never throws. */
  build(args: Record<string, any>): BuildResult;
}

/** How many issues one proxied search may ask for. */
export const PROXY_SEARCH_MAX_RESULTS = 50;

/**
 * The characters a `fields` list may contain.
 *
 * Jira field names are alphanumerics, underscores, dots and hyphens, plus `*`
 * for its `*all` / `*navigable` selectors. The point of the check is not that
 * Jira would reject anything else — it is that a `fields` value is
 * concatenated into a path, so anything that could carry a `/`, a `?` or a `#`
 * out of the parameter and into the endpoint must not reach it. The value is
 * percent-encoded as well; this is the belt to that pair of braces.
 */
const FIELD_LIST = /^[A-Za-z0-9_*.,-]{1,300}$/;

/** An issue key as Jira spells it, or the reason this one is not. */
function issueKey(args: Record<string, any>): { key: string } | { error: string } {
  const raw = typeof args?.issueKey === 'string' ? args.issueKey.trim() : '';
  if (!raw) return { error: 'issueKey is required, e.g. "KAN-272"' };
  const upper = raw.toUpperCase();
  if (!JIRA_KEY.test(upper)) {
    return {
      error:
        `"${raw}" is not a Jira issue key. Expected PROJECT-123 — letters, then a hyphen, ` +
        'then digits. This proxy builds its own REST paths from validated arguments and ' +
        'never takes a path, so an issue key is the only thing that can name an issue here.'
    };
  }
  return { key: upper };
}

/** A validated `fields` list, or the default, or the reason it was refused. */
function fieldList(args: Record<string, any>, fallback: string): { fields: string } | { error: string } {
  const raw = args?.fields;
  if (raw === undefined || raw === null || raw === '') return { fields: fallback };
  const value = Array.isArray(raw) ? raw.join(',') : String(raw);
  const trimmed = value.trim();
  if (!FIELD_LIST.test(trimmed)) {
    return {
      error:
        `"${trimmed.slice(0, 60)}" is not a usable field list. Give a comma-separated list of ` +
        'Jira field names (letters, digits, _ . - and *), e.g. "status,summary,comment".'
    };
  }
  return { fields: trimmed };
}

/**
 * The operations this daemon proxies. **This table is the granted scope.**
 *
 * Three, chosen from what agents measurably do rather than from what looked
 * tidy: across 314 workspace transcripts and 4,698 `mcp__atlassian__*` calls,
 * `getJiraIssue` (956), `searchJiraIssuesUsingJql` (349) and
 * `getTransitionsForJiraIssue` (205) are the three most-called read operations
 * and together they are 80% of all agent reads. The measurement is on KAN-272.
 *
 * Every one of them is a GET under `read:jira-work`, which the daemon's
 * credential already holds — so the scope this mode grants over what the daemon
 * could already do is **empty**. That is not an accident of choosing easy
 * operations; it is the criterion this first mode was chosen to satisfy.
 */
export const PROXY_OPERATIONS: readonly ProxyOperation[] = [
  {
    tool: 'atlassian_get_issue',
    mode: 'jira-read',
    scope: 'read:jira-work',
    method: 'GET',
    pathShape: '/rest/api/3/issue/{issueKey}?fields={fields}',
    description:
      "Read one Jira issue through the Butchr daemon's own credential, rather than through " +
      'this agent\'s Atlassian OAuth session. Returns Jira\'s raw response body for the fields ' +
      'asked for. A FAILURE HERE IS ALWAYS LOUD: if the daemon\'s credential is expired, ' +
      'revoked or unreachable you get an error naming the endpoint that refused it and what ' +
      'it said — never an empty result that reads like an issue with no fields.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'The issue key, e.g. "KAN-272".' },
        fields: {
          type: 'string',
          description:
            'Optional. Comma-separated Jira field names, e.g. "status,summary,comment". ' +
            'Defaults to status, summary, issuetype, assignee, parent, updated, issuelinks.'
        }
      },
      required: ['issueKey']
    },
    build(args) {
      const key = issueKey(args);
      if ('error' in key) return key;
      const fields = fieldList(args, 'status,summary,issuetype,assignee,parent,updated,issuelinks');
      if ('error' in fields) return fields;
      return {
        path:
          `/rest/api/3/issue/${encodeURIComponent(key.key)}` +
          `?fields=${encodeURIComponent(fields.fields)}`
      };
    }
  },
  {
    tool: 'atlassian_search_issues',
    mode: 'jira-read',
    scope: 'read:jira-work',
    method: 'GET',
    pathShape: '/rest/api/3/search/jql?jql={jql}&fields={fields}&maxResults={maxResults}',
    description:
      "Run a JQL search through the Butchr daemon's own credential. Returns Jira's raw " +
      `response body. Bounded at ${PROXY_SEARCH_MAX_RESULTS} results — this is a proxy for ` +
      'agent-sized questions, not a bulk export. A failure is loud, as above.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string', description: 'The JQL query, e.g. "project = KAN AND status = \'In Review\'".' },
        fields: {
          type: 'string',
          description:
            'Optional. Comma-separated Jira field names. Defaults to status, summary, issuetype, assignee.'
        },
        maxResults: {
          type: 'number',
          description: `Optional. 1..${PROXY_SEARCH_MAX_RESULTS}; defaults to ${PROXY_SEARCH_MAX_RESULTS}.`
        }
      },
      required: ['jql']
    },
    build(args) {
      const jql = typeof args?.jql === 'string' ? args.jql.trim() : '';
      if (!jql) return { error: 'jql is required, e.g. "project = KAN AND status = \'In Review\'"' };
      if (jql.length > 2000) {
        return { error: `jql is ${jql.length} characters; the proxy accepts up to 2000.` };
      }
      const fields = fieldList(args, 'status,summary,issuetype,assignee');
      if ('error' in fields) return fields;

      // A non-numeric or out-of-range maxResults is clamped rather than
      // refused: it is a nicety, not an instruction, and refusing a whole
      // search over one is the sort of pedantry that gets a proxy worked
      // around. The bound itself is not negotiable — it is what keeps one
      // agent's typo from being a bulk read of the account.
      const asked = Number(args?.maxResults);
      const maxResults =
        Number.isFinite(asked) && asked >= 1
          ? Math.min(Math.floor(asked), PROXY_SEARCH_MAX_RESULTS)
          : PROXY_SEARCH_MAX_RESULTS;

      return {
        path:
          `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
          `&fields=${encodeURIComponent(fields.fields)}&maxResults=${maxResults}`
      };
    }
  },
  {
    tool: 'atlassian_get_transitions',
    mode: 'jira-read',
    scope: 'read:jira-work',
    method: 'GET',
    pathShape: '/rest/api/3/issue/{issueKey}/transitions',
    description:
      'List the workflow transitions available on a Jira issue right now, through the Butchr ' +
      "daemon's own credential. THIS READS THE TRANSITIONS; IT DOES NOT PERFORM ONE — the " +
      'daemon holds no write scope and this proxy has no write operation. A failure is loud, ' +
      'as above.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'The issue key, e.g. "KAN-272".' }
      },
      required: ['issueKey']
    },
    build(args) {
      const key = issueKey(args);
      if ('error' in key) return key;
      return { path: `/rest/api/3/issue/${encodeURIComponent(key.key)}/transitions` };
    }
  }
];

/** The operations a mode enables. Empty for `off`, which is the whole of `off`. */
export function operationsFor(mode: ProxyMode): ProxyOperation[] {
  if (mode === 'off') return [];
  return PROXY_OPERATIONS.filter((op) => op.mode === mode);
}

/**
 * Every distinct Atlassian scope a mode requires, sorted.
 *
 * Derived from the table rather than declared beside it, so the enumeration a
 * PR pastes cannot drift from the operations it describes. An operation added
 * with a wider scope changes this answer without anybody remembering to.
 */
export function grantedScopes(mode: ProxyMode): string[] {
  return [...new Set(operationsFor(mode).map((op) => op.scope))].sort();
}

/** Find a proxied operation by tool name, whatever the mode. */
export function operationByTool(tool: string): ProxyOperation | undefined {
  return PROXY_OPERATIONS.find((op) => op.tool === tool);
}

export interface ProxyDecision {
  mode: ProxyMode;
  source: 'default' | 'environment';
  /** The raw value read, so an operator can see a typo for what it is. */
  rawValue: string | null;
  /** Set when a value was present and unusable; null otherwise. */
  fallbackReason: string | null;
}

/**
 * The mode this daemon is serving, from the environment.
 *
 * See the module header for why an unrecognised value falls to `off` and why
 * this is read on every call rather than captured at boot.
 */
export function selectedProxyMode(env: NodeJS.ProcessEnv = process.env): ProxyDecision {
  const raw = env[PROXY_ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    return { mode: 'off', source: 'default', rawValue: raw ?? null, fallbackReason: null };
  }
  const value = raw.trim().toLowerCase();
  if (value === 'jira-read') {
    return { mode: 'jira-read', source: 'environment', rawValue: raw, fallbackReason: null };
  }
  if (value === 'off') {
    return { mode: 'off', source: 'environment', rawValue: raw, fallbackReason: null };
  }
  return {
    mode: 'off',
    source: 'default',
    rawValue: raw,
    fallbackReason:
      `${PROXY_ENV_VAR} is set to "${raw}", which is not one of ${PROXY_MODES.join(' | ')}. ` +
      'Falling back to off — an unreadable setting is never a licence to widen what the ' +
      "fleet can reach through the daemon's credential."
  };
}

/** What a proxied operation looks like to a reader enumerating the grant. */
export interface ProxyOperationReport {
  tool: string;
  method: 'GET';
  pathShape: string;
  scope: string;
}

/**
 * What the daemon says about its proxy, to `mcp.ts` and to a human alike.
 *
 * Built by {@link proxyReport} from the decision it was handed, never from a
 * second read of the environment — `runtime-switch.ts`'s rule, and the reason
 * it gives is the reason here: a report describing a mode the daemon is not in
 * is worse than no report.
 */
export interface AtlassianProxyReport {
  mode: ProxyMode;
  source: 'default' | 'environment';
  rawValue: string | null;
  fallbackReason: string | null;
  /** When this answer was computed. The mode is read per call — see the header. */
  readAt: string;
  /** Exactly what this mode exposes. Empty when off. */
  operations: ProxyOperationReport[];
  /** The distinct scopes those operations need. Empty when off. */
  scopes: string[];
  /**
   * Whether a credential is configured at all, and where it is stored — never
   * the credential.
   *
   * **A configured credential is not a working one**, and this field must not be
   * read as though it were: it says a token is on this machine, not that
   * Atlassian still accepts it. The 2026-08-10 outage is the whole reason that
   * distinction is written down here — the thing that looked fine was
   * *presence*. Only a call establishes the other.
   */
  credential: { configured: boolean; siteUrl?: string; email?: string; storage?: string };
  /** One line an operator can read without knowing any of the above. */
  summary: string;
}

export function proxyReport(
  decision: ProxyDecision,
  credential: { configured: boolean; siteUrl?: string; email?: string; storage?: string },
  now: () => Date = () => new Date()
): AtlassianProxyReport {
  const operations = operationsFor(decision.mode).map((op) => ({
    tool: op.tool,
    method: op.method,
    pathShape: op.pathShape,
    scope: op.scope
  }));
  const scopes = grantedScopes(decision.mode);

  const summary =
    decision.mode === 'off'
      ? `The Atlassian proxy is OFF. ` +
        (decision.source === 'default' && decision.rawValue === null
          ? `${PROXY_ENV_VAR} is not set, which is the default.`
          : decision.fallbackReason
            ? decision.fallbackReason
            : `Turned off explicitly by ${PROXY_ENV_VAR}=${decision.rawValue}.`) +
        ' No agent can reach Atlassian through the daemon; every agent still has its own ' +
        'Atlassian MCP session and nothing about this is a degradation.'
      : `The Atlassian proxy is serving ${operations.length} read operation(s) ` +
        `(${operations.map((op) => op.tool).join(', ')}) against ` +
        `${credential.configured ? `${credential.email ?? 'the configured account'} @ ${credential.siteUrl ?? 'the configured site'}` : 'NO CONFIGURED CREDENTIAL — every call will refuse'}, ` +
        `needing ${scopes.join(', ')} and nothing else. Selected by ${PROXY_ENV_VAR}=${decision.rawValue}. ` +
        'A listed tool is not a working one: only a call establishes that the credential is ' +
        'still accepted.';

  return {
    mode: decision.mode,
    source: decision.source,
    rawValue: decision.rawValue,
    fallbackReason: decision.fallbackReason,
    readAt: now().toISOString(),
    operations,
    scopes,
    credential,
    summary
  };
}

/**
 * Why a call was refused before it reached Atlassian, or `null` to proceed.
 *
 * Separate from the call itself so that the *reason* is testable without a
 * network, a credential or a daemon — the refusals are the security-relevant
 * half of this module and they should not need an instrument to check.
 */
export function refuseProxyCall(
  mode: ProxyMode,
  tool: string
): { error: string; reason: 'proxy-off' | 'unknown-tool' | 'not-in-mode' } | null {
  const op = operationByTool(tool);

  if (mode === 'off') {
    return {
      reason: 'proxy-off',
      error:
        `The Butchr daemon's Atlassian proxy is off, so ${tool} is refused. It is off by ` +
        `default; an operator turns it on by setting ${PROXY_ENV_VAR}=jira-read. Use this ` +
        "agent's own Atlassian MCP tools instead — nothing about this refusal stops you " +
        'reaching Jira.'
    };
  }

  if (!op) {
    return {
      reason: 'unknown-tool',
      error:
        `${tool} is not an operation this proxy has. It serves exactly: ` +
        `${operationsFor(mode).map((o) => o.tool).join(', ') || '(none)'}. ` +
        'There is deliberately no operation that takes a REST path — the granted scope has ' +
        'to be readable off one table.'
    };
  }

  if (op.mode !== mode) {
    return {
      reason: 'not-in-mode',
      error:
        `${tool} belongs to proxy mode "${op.mode}", and this daemon is serving "${mode}". ` +
        `Set ${PROXY_ENV_VAR}=${op.mode} to enable it — each mode is granted on its own ` +
        'merits and they are deliberately not one block.'
    };
  }

  return null;
}
