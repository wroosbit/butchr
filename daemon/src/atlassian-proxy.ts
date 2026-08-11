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
 * ## THE RULE THAT CHANGED HERE, AND WHAT REPLACED IT
 *
 * This header used to say, under *THE RULE THAT DID NOT CHANGE HERE*, that
 * every operation below was a GET and that the module widened the credential's
 * scope by exactly nothing. **KAN-291 spends the reversal KAN-272 left
 * unspent**, so that is no longer true and saying it would be worse than saying
 * nothing. What is true now:
 *
 * **There is exactly one write operation, it is the smallest one there is, and
 * it lives in a mode of its own.** `atlassian_transition_issue` POSTs
 * `{"transition":{"id":"31"}}` to one issue's `/transitions` — a status change,
 * with no rich content of any kind. It was chosen because it exercises the
 * credential, the scoping and the write path **without dragging ADF conversion
 * in**; content writes and the conversion they share are KAN-293's, and nothing
 * here should make them easier to add without a second look.
 *
 * **The scope grows for the first time.** Reads need `read:jira-work`, which
 * the daemon's credential has always held; the write needs `write:jira-work`,
 * which it has not, and which a user who followed the settings page's own
 * instructions has not granted. That is a real cost to the user, it is the
 * first one this proxy has ever carried, and {@link grantedScopes} is what
 * makes it impossible to add a second one quietly.
 *
 * ## THE RULE THAT DID NOT CHANGE: AN AGENT NAMES NEITHER A PATH NOR A BODY
 *
 * KAN-272's containment is that no operation takes a path, a URL or a REST
 * fragment from an agent, so the granted scope is readable off one table. A
 * write needs that property **twice over**, because a request body is exactly
 * as unbounded a surface as a path is: a handler that forwarded an agent's JSON
 * to `/rest/api/3/issue/KAN-1` would have granted every field Jira's edit API
 * accepts, and no reviewer could read that off this file either.
 *
 * So {@link ProxyOperation.build} constructs the **whole** body from validated
 * arguments, exactly as it constructs the whole path, and
 * {@link ProxyOperation.bodyShape} states what it can construct. The only thing
 * an agent supplies to the write below is an issue key and a transition id, and
 * both are matched against a regex before either reaches a string.
 *
 * ## WHO MAY BE WRITTEN TO — the blast radius, decided rather than defaulted
 *
 * KAN-288 states the problem this creates: after the full surface lands, "any
 * agent can write anything the daemon's credential can reach, with no per-agent
 * scoping and no interactive consent." **The policy this slice picks, and which
 * the later slices inherit, is that an agent may write only to its own
 * ticket** — see {@link refuseWriteOutsideCaller}, which is where the argument
 * for it, and the honest statement of what it is *not*, are written down.
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
export type ProxyMode = 'off' | 'jira-read' | 'jira-write';

/** The environment variable that selects a mode. */
export const PROXY_ENV_VAR = 'BUTCHR_ATLASSIAN_PROXY';

/** Every mode this daemon knows, for the message an unrecognised value gets. */
export const PROXY_MODES: readonly ProxyMode[] = ['off', 'jira-read', 'jira-write'];

/**
 * The modes a selected mode turns on — a ladder, not a set of alternatives.
 *
 * `jira-write` enables the reads as well, and that is a deliberate change to
 * how {@link operationsFor} used to read. Under the old strict-equality rule an
 * operator who wanted an agent to move its own ticket would have had to give up
 * every read to get it, which is not a choice anybody would make: they would
 * set `jira-read` and route the write around the proxy, and the mode that grants
 * the least would have been the one nobody could use.
 *
 * It is a ladder rather than a bag of independently-tagged flags because the
 * ordering is real — there is no coherent deployment that can transition an
 * issue but not read one — and because a comma-separated list of modes is a
 * parser, and a parser is a place for `jira-read,jira-write ` to become
 * something nobody intended. One string, one rung, and the rung above contains
 * the rung below.
 *
 * **Adding a rung is the act of widening**, and it is meant to be conspicuous:
 * a new mode goes at the top, names its own scope, and shows up in
 * {@link grantedScopes} without anybody remembering to write it down.
 */
export function enabledModes(mode: ProxyMode): Exclude<ProxyMode, 'off'>[] {
  switch (mode) {
    case 'off':
      return [];
    case 'jira-read':
      return ['jira-read'];
    case 'jira-write':
      return ['jira-read', 'jira-write'];
  }
}

/**
 * A path — and, for a write, a body — built from validated arguments, or the
 * reason it was refused.
 *
 * A refusal is a string rather than a throw because it is an ordinary answer —
 * an agent that passes `KAN 272` has made a typo, not caused an exception — and
 * because the string is what the agent reads.
 *
 * `body` is built here rather than taken from the caller for the reason in the
 * module header: a body forwarded from an agent is an unbounded grant wearing a
 * JSON object's clothes. A GET operation returns no `body` and the transport
 * sends none.
 */
export type BuildResult = { path: string; body?: unknown } | { error: string };

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
  /**
   * The HTTP method.
   *
   * `POST` is the only write verb here and there is deliberately no `PUT`,
   * `PATCH` or `DELETE`: the operations that need them are content edits and
   * deletions, which are KAN-293's and which should have to widen this union
   * rather than slip in under a method it already allows.
   */
  method: 'GET' | 'POST';
  /**
   * The path shape, with its parameters named, for the enumeration in a PR and
   * for a reader who wants to know what the credential is actually used for
   * without reading {@link build}.
   */
  pathShape: string;
  /**
   * The body shape, for a write, in the same spirit and for a stronger reason:
   * with a write, the path alone no longer says what the credential can do.
   * Absent on a GET, which sends none.
   */
  bodyShape?: string;
  /** What the agent-facing tool description says. */
  description: string;
  /** JSON Schema for the tool's arguments, as MCP wants it. */
  inputSchema: Record<string, unknown>;
  /** Build the concrete path and body, or refuse. Never throws. */
  build(args: Record<string, any>): BuildResult;
  /**
   * The Jira issue this operation **writes to**, read off the same arguments
   * {@link build} validates — or `null` when they do not name a usable one.
   *
   * Present on every write and absent on every read, which is what lets
   * "every write is checked against its caller" be verified against this table
   * rather than trusted to the handler that happens to call it today. A write
   * added without one is caught by the verify script, not by a reviewer's
   * memory.
   */
  writesTo?(args: Record<string, any>): string | null;
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
 * A Jira transition id, or the reason this one is not.
 *
 * Digits only, and short. Jira's transition ids are small integers and the
 * value is the *entire* variable part of the only body this proxy can build —
 * so the check is not politeness about types, it is what keeps
 * `{"transition":{"id":…}}` from being a hole through which an agent supplies
 * structure. A string of digits cannot carry an object, a second field, or a
 * quote, whatever `JSON.stringify` is asked to do with it.
 *
 * Kept as a **string** rather than coerced to a number because that is what
 * Jira's API wants and what `getTransitionsForJiraIssue` hands back; converting
 * to a number and back is two chances to turn `007` into `7`.
 */
const TRANSITION_ID = /^[0-9]{1,8}$/;

function transitionId(args: Record<string, any>): { id: string } | { error: string } {
  const raw =
    typeof args?.transitionId === 'string' || typeof args?.transitionId === 'number'
      ? String(args.transitionId).trim()
      : '';
  if (!raw) {
    return {
      error:
        'transitionId is required. It is the numeric id of the transition to perform — ' +
        'list them with atlassian_get_transitions first, which is what tells you that ' +
        '"In Progress" is 21 on this workflow and something else on another.'
    };
  }
  if (!TRANSITION_ID.test(raw)) {
    return {
      error:
        `"${raw.slice(0, 40)}" is not a Jira transition id. Expected digits, e.g. "31" — ` +
        'a transition is named by its id and not by its name, because a workflow can have ' +
        'two transitions leading to the same status. Read them with atlassian_get_transitions.'
    };
  }
  return { id: raw };
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
 *
 * **And then one write (KAN-291), which does not satisfy it and cannot.** A
 * write needs `write:jira-work`, so `jira-write` is the first mode that costs
 * the user something to grant. It is one operation rather than four for the
 * same reason the three reads were three: a mode is granted on its own merits,
 * and a mode holding the whole of Jira's write API could only be granted or
 * refused as a block.
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
  },
  {
    tool: 'atlassian_transition_issue',
    mode: 'jira-write',
    scope: 'write:jira-work',
    method: 'POST',
    pathShape: '/rest/api/3/issue/{issueKey}/transitions',
    bodyShape: '{"transition":{"id":"{transitionId}"}}',
    description:
      "Move a Jira issue through one workflow transition, using the Butchr daemon's own " +
      'credential. THE ONLY WRITE THIS PROXY HAS, and it is deliberately the smallest one: it ' +
      'changes a status and carries no rich content, no fields and no comment. ' +
      'YOU MAY ONLY TRANSITION YOUR OWN TICKET — the issue key must be this workspace\'s own ' +
      'key, and a call naming any other issue is refused before it reaches Atlassian. ' +
      'Find the transition id with atlassian_get_transitions; ids are per-workflow and a ' +
      'status name is not an id. On success Jira returns 204 with no body, which is its ' +
      'success shape for this endpoint and is reported as one. A FAILURE HERE IS ALWAYS LOUD: ' +
      "if the daemon's credential is expired, revoked, or holds only read scope, you get an " +
      'error naming the endpoint that refused it and what it said — never a silent no-op that ' +
      'reads like a transition that happened.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: {
          type: 'string',
          description:
            "The issue key, e.g. \"KAN-291\". Must be this agent's own workspace key — the " +
            'proxy refuses a transition of anybody else\'s ticket.'
        },
        transitionId: {
          type: 'string',
          description:
            'The numeric id of the transition to perform, e.g. "31". Read the ids available ' +
            'on this issue right now with atlassian_get_transitions.'
        }
      },
      required: ['issueKey', 'transitionId']
    },
    build(args) {
      const key = issueKey(args);
      if ('error' in key) return key;
      const id = transitionId(args);
      if ('error' in id) return id;
      return {
        path: `/rest/api/3/issue/${encodeURIComponent(key.key)}/transitions`,
        // The whole body, built here. Two validated strings go in and nothing
        // else can: there is no path by which a key an agent supplies becomes a
        // key in this object. See the module header.
        body: { transition: { id: id.id } }
      };
    },
    writesTo(args) {
      const key = issueKey(args);
      return 'error' in key ? null : key.key;
    }
  }
];

/**
 * The operations a mode enables. Empty for `off`, which is the whole of `off`.
 *
 * Membership is {@link enabledModes} rather than equality — see there for why
 * the rungs are cumulative. `off` returns before that function is consulted at
 * all, so there is no arrangement of the ladder that can make `off` serve
 * something.
 */
export function operationsFor(mode: ProxyMode): ProxyOperation[] {
  if (mode === 'off') return [];
  const on = new Set<string>(enabledModes(mode));
  return PROXY_OPERATIONS.filter((op) => on.has(op.mode));
}

/** Every write in a mode. The set the caller restriction below has to cover. */
export function writeOperationsFor(mode: ProxyMode): ProxyOperation[] {
  return operationsFor(mode).filter((op) => op.method !== 'GET');
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
  // Exact membership of the declared list, so a new rung is enabled by being
  // added to `PROXY_MODES` and cannot be enabled by anything else. Still an
  // exact match against a whole string: no truthiness, no prefix, no `1` — see
  // the module header for what that discipline is worth.
  const matched = PROXY_MODES.find((mode) => mode === value);
  if (matched) {
    return { mode: matched, source: 'environment', rawValue: raw, fallbackReason: null };
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
  method: 'GET' | 'POST';
  pathShape: string;
  /** Present exactly when the operation sends one. */
  bodyShape?: string;
  scope: string;
  /**
   * Whether this operation is restricted to the caller's own ticket. True for
   * every write; false for every read. Reported rather than left to be inferred
   * from the method, because "which of these can change something, and who may
   * ask" is the question a reader of this report actually has.
   */
  ownTicketOnly: boolean;
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
    ...(op.bodyShape ? { bodyShape: op.bodyShape } : {}),
    scope: op.scope,
    ownTicketOnly: !!op.writesTo
  }));
  const scopes = grantedScopes(decision.mode);
  const writes = operations.filter((op) => op.method !== 'GET');

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
      : `The Atlassian proxy is serving ${operations.length - writes.length} read operation(s) ` +
        `and ${writes.length} write operation(s) ` +
        `(${operations.map((op) => op.tool).join(', ')}) against ` +
        `${credential.configured ? `${credential.email ?? 'the configured account'} @ ${credential.siteUrl ?? 'the configured site'}` : 'NO CONFIGURED CREDENTIAL — every call will refuse'}, ` +
        `needing ${scopes.join(', ')} and nothing else. Selected by ${PROXY_ENV_VAR}=${decision.rawValue}. ` +
        (writes.length
          ? `EVERY WRITE IS RESTRICTED TO THE CALLING AGENT'S OWN TICKET (${writes
              .map((op) => op.tool)
              .join(', ')}), which bounds accident and is not authentication — anything that ` +
            'can reach the daemon socket can claim any identity. A credential minted with only ' +
            'read scope will refuse these, loudly, on the first call. '
          : '') +
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

  if (!enabledModes(mode).includes(op.mode)) {
    return {
      reason: 'not-in-mode',
      error:
        `${tool} belongs to proxy mode "${op.mode}", and this daemon is serving "${mode}". ` +
        `Set ${PROXY_ENV_VAR}=${op.mode} to enable it — each mode is granted on its own ` +
        'merits and they are deliberately not one block. Note that this one needs a ' +
        `credential holding ${op.scope}, which a read-only token does not have.`
    };
  }

  return null;
}

/** Who the daemon believes is calling. See {@link refuseWriteOutsideCaller}. */
export interface ProxyCaller {
  /** Workspace type: `task`, `story`, `epic`, `confluence`, … */
  type: string;
  /** Workspace key: a Jira issue key for the types that have one. */
  key: string;
}

/**
 * Why a **write** was refused on account of who asked for it, or `null`.
 *
 * ## THE POLICY, AND WHY THIS ONE
 *
 * **An agent may write only to its own ticket.** The issue named in the call
 * must be the caller's own workspace key; a task agent for KAN-291 can move
 * KAN-291 and nothing else. That is the narrowest rule that leaves the tool
 * able to do the job it was added for — the brief every agent runs under tells
 * it to claim its ticket, move it to In Progress, and move it to In Review, all
 * three of them writes to its own key and none of them writes to anybody
 * else's.
 *
 * Rejected, with reasons, because a mitigation dropped in silence is worse than
 * one dropped out loud:
 *
 *  - **Nothing at all — audit logging only.** The widest thing that works, and
 *    KAN-291 says plainly it is the one outcome that will be refused. An audit
 *    line is a record of a write that already happened; it bounds nobody.
 *    Kept, as a second layer, and not as the policy.
 *  - **The caller's whole subtree** — its own ticket plus its children, or its
 *    epic's descendants. Strictly more useful and it needs a Jira read per
 *    write to find out what the subtree *is*, which brings a question this
 *    slice should not be answering: what happens to a write when the
 *    parentage read fails. Fail open and the restriction evaporates in exactly
 *    the outage it should hold through; fail closed and a slow Jira stops
 *    agents from moving their own tickets. The slice that genuinely needs it
 *    can add it deliberately and pay for that decision then.
 *  - **Interactive per-write consent.** There is no human at 03:00, which is
 *    when the fleet runs. It would make the proxy unusable, agents would keep
 *    `mcp-remote` for writes, and **both** costs would stay — which is
 *    precisely the failure KAN-288 says a partial replacement produces.
 *
 * ## WHAT THIS IS NOT, STATED FIRST BECAUSE IT WILL BE READ AS MORE
 *
 * **It is not authentication, and it is not a security boundary against a
 * hostile agent.** `type` and `key` are stamped into the request by `mcp.ts`
 * from its own argv; anything that can reach the daemon's Unix socket can claim
 * any identity, exactly as `agent-connections.ts` decision 4 records for
 * `hello` and as `router.ts` says of the audit line. The trust boundary is
 * still the socket's filesystem permission and this function does not move it
 * one inch.
 *
 * What it does bound is **accident**, which is what has actually been costing
 * this board: a key confused for another, a loop over a search result that
 * writes to every row of it, an agent talked into moving a ticket that is not
 * its own by something it read in a comment. Those are ordinary and this
 * refuses all of them. Do not write down, or infer, that it does more.
 *
 * ## AN UNIDENTIFIED OR NON-JIRA CALLER IS REFUSED
 *
 * Both fail closed, and the second is not a corner case: a `confluence`
 * workspace is keyed by a page id, so it has no issue key to be its own ticket
 * and there is no key it could pass that this rule would accept. That is the
 * correct answer rather than a gap — such an agent has never had a ticket to
 * move — and the refusal says so rather than looking like a bug.
 */
export function refuseWriteOutsideCaller(
  op: ProxyOperation,
  args: Record<string, any>,
  caller: ProxyCaller | null
): { error: string; reason: 'unidentified-caller' | 'caller-has-no-ticket' | 'not-your-ticket' } | null {
  // Reads are not restricted by this rule, and the table says which is which:
  // `writesTo` is present on every write and absent on every read.
  if (!op.writesTo) return null;

  const target = op.writesTo(args);
  // `build` refuses a malformed key with a better sentence than anything here
  // could, and the handler calls it first. Reaching this with no target means
  // the arguments were unusable; let `build` be the one to say so.
  if (!target) return null;

  if (!caller || !caller.type || !caller.key) {
    return {
      reason: 'unidentified-caller',
      error:
        `${op.tool} is refused because this call did not say which workspace it came from, ` +
        'and a write is only permitted to the caller\'s own ticket. Nothing was sent to ' +
        'Atlassian. This is a bug in whatever made the call rather than something to work ' +
        'around: an unattributable write is exactly the one this proxy will not make.'
    };
  }

  if (!JIRA_KEY.test(caller.key.toUpperCase())) {
    return {
      reason: 'caller-has-no-ticket',
      error:
        `${op.tool} is refused: this is the "${caller.type}" workspace ${caller.key}, whose key ` +
        'is not a Jira issue, so it has no ticket of its own to transition — and a write is ' +
        `only permitted to the caller's own ticket. Nothing was sent to Atlassian. Use this ` +
        "agent's own Atlassian MCP tools if you genuinely need to move somebody else's issue."
    };
  }

  if (target !== caller.key.toUpperCase()) {
    return {
      reason: 'not-your-ticket',
      error:
        `${op.tool} is refused: ${caller.type}/${caller.key} asked to transition ${target}, and ` +
        "the Butchr proxy permits a write only to the caller's own ticket. Nothing was sent to " +
        `Atlassian and ${target} has not moved. If ${target} genuinely has to move — approving ` +
        'agents set Done on the tickets they approve, which is exactly this case — use this ' +
        "agent's own Atlassian MCP tools, which are unaffected by this refusal."
    };
  }

  return null;
}
