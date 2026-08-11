/**
 * The daemon-side LaunchDarkly proxy: which operations agents may reach through
 * the daemon's own credential, and the switch that decides whether any of them
 * are reachable at all (KAN-298).
 *
 * ## What this is for, in one paragraph
 *
 * `~/.claude.json` configures every agent with
 * `npx -y @launchdarkly/mcp-server --access-token <token>`. That invocation has
 * never worked — the CLI wants a `start` subcommand and the flag is `--api-key`
 * — so no LaunchDarkly tool has ever appeared in any agent's tool list, and the
 * token has nonetheless been sitting in plaintext argv where `/proc/<pid>/cmdline`
 * and `claude mcp list` can both read it. This module is the other topology, the
 * one `atlassian-proxy.ts` established: one credential, held by the daemon,
 * reached over the socket agents already talk to, with the granted scope
 * readable off a single table.
 *
 * ## THE WRITE DECISION, AND WHY THERE IS NO WRITE MODE IN THIS FILE
 *
 * **This proxy has no write operations and no write mode. That is a decision,
 * not an omission, and it was taken with the alternatives written down.**
 *
 * `atlassian-proxy.ts` grants exactly one write, and what makes that safe is not
 * the write's size — it is {@link refuseWriteOutsideCaller}, whose policy is
 * *an agent may write only to its own ticket*. That policy works because of a
 * **structural binding**: a `task/KAN-291` workspace key **is** a Jira issue
 * key, so "may this caller write to this target" is computable from the caller
 * with no lookup and no trust.
 *
 * **LaunchDarkly has no such binding.** There is no flag, environment, project
 * or AI Config that belongs to `task/KAN-298` in any sense this daemon could
 * compute. The policy does not port, and no rewording of it does — so a write
 * surface here would be authority with no principle attached to it.
 *
 * Two source-side mitigations were checked against the official server rather
 * than read from its documentation, and neither fills the gap:
 *
 *  - **`--scope read|write` is a partition, not a ladder.** Measured on
 *    `@launchdarkly/mcp-server` 0.6.2: `--scope read` mounts 10 tools,
 *    `--scope write` mounts the other 10, and they do not overlap. It is an
 *    excellent authority for *which tools are reads* — {@link LD_READ_SCOPE_TOOLS}
 *    is that enumeration, and the verify script holds this table to it — and it
 *    says nothing whatever about *who* may write or *what* they may write to.
 *  - **`--tool <name>` selects a set**, and a set is not a policy either.
 *
 * And the fact that decided it: the stored credential's member is `role: admin`
 * with no custom roles, so **there is no such thing as a small write here**.
 * Every write tool exposed would be exposed at full account-admin authority over
 * production flag state, bounded by nothing at the source.
 *
 * Rejected, with reasons, because a mitigation dropped in silence is worse than
 * one dropped out loud:
 *
 *  - **All twenty tools.** The widest thing that works, and the one outcome the
 *    reviewing epic said in advance it would refuse. `delete-feature-flag`
 *    against `production` would have been permitted by LaunchDarkly and refused
 *    by nothing here.
 *  - **Reads plus a named write subset** — `create-feature-flag` alone, as the
 *    least destructive write. Rejected because no agent workflow on this board
 *    needs to create a flag: adding a write with no demand spends blast radius
 *    for nothing, and "it is the safe one" is the argument that gets the second
 *    one added later.
 *  - **A project/environment allowlist** — writes permitted only against named
 *    projects and environments. This is the *strongest* rejected option and is
 *    recorded here as the right next rung rather than as a bad idea: it is the
 *    genuine analogue of KAN-291's policy, bounding by **resource** where Jira
 *    bounds by **caller**. It is not here because which projects and
 *    environments are safe to hand an agent is a human's decision that nobody
 *    has taken, and inventing that list unilaterally is the same defect as
 *    inventing an approver. **Deliberately not stubbed for**: there is no hook,
 *    no empty allowlist constant and no disabled mode waiting for it, because a
 *    half-built write path is the thing most likely to be finished by somebody
 *    who has not read this paragraph.
 *  - **Interactive per-write consent.** There is no human at 03:00, which is
 *    when the fleet runs.
 *
 * **What a caller does instead**, stated because an omission with no stated
 * fallback is half an answer: a flag change is made by a human in the
 * LaunchDarkly UI. There is no Butchr path to one and this file is not the
 * place to add it — see {@link ProxyMode}, where adding a rung is the act of
 * widening.
 *
 * ## AN AGENT NAMES NEITHER A PATH NOR A QUERY PARAMETER
 *
 * `atlassian-proxy.ts`'s containment is that no operation takes a path, a URL or
 * a REST fragment from an agent, so the granted scope is readable off one table.
 * This file needs that property **and one more**, because LaunchDarkly's read
 * endpoints carry far more query surface than Jira's three do: `filter`, `sort`,
 * `expand`, `spec` and `q` are all free-text on the wire.
 *
 * So {@link LdOperation.build} constructs the **whole** query string from an
 * explicit per-operation allowlist ({@link LdOperation.query}) and every value
 * goes through a named validator. A parameter this table does not declare is not
 * refused — it is **dropped**, silently and by construction, because it never
 * reaches the code that assembles a query at all.
 *
 * That is a deliberate difference from the shape a forwarding proxy would have
 * had. The official server's twenty tools each take **one opaque `request`
 * object**, so a daemon that spawned it as a child and forwarded that object
 * could validate nothing: no path segment, no query parameter, no body. It would
 * have surrendered the exact property that makes a proxy reviewable, which is
 * why the child-process shape was considered and not taken.
 *
 * ## Off by default, and read per call rather than once
 *
 * {@link selectedLdProxyMode} returns `'off'` for an unset variable, for an
 * empty one, and for anything it does not recognise. The only input that enables
 * anything is the exact string `launchdarkly-read`. No truthiness test, no
 * prefix match, no `1` — `atlassian-proxy.ts`'s discipline and its reason:
 * falling back to off costs nothing, while falling back to on because somebody
 * typed `launchdarkly_read` widens what an entire fleet can reach on the
 * strength of a misspelling.
 *
 * It is read **on every call**, so an operator who decides at 03:00 that agents
 * should stop reaching LaunchDarkly through the daemon unsets the variable and
 * the next call is refused, with no daemon restart and no fleet interruption.
 *
 * ## Where the gate is, and why there is only one of it
 *
 * **In the daemon, and nowhere else.** `mcp.ts` asks this module (through the
 * daemon) what to advertise, but the advertisement is not the gate — the refusal
 * in `handleLaunchDarklyProxyCall` is. An agent that was started while the proxy
 * was on keeps the tools in its list after it is switched off, and its next call
 * is refused with a sentence naming the switch.
 *
 * It is also why **tool presence is not evidence** here. Four of the ten
 * operations below cannot succeed on the account this was built against at all —
 * every AI Configs endpoint answers `403 {"code":"forbidden","message":"Plan
 * does not allow this operation"}`. They are mirrored anyway, because the plan
 * can change and because that 403 is *loud*: {@link explainLdProxyFailure} turns
 * it into a sentence naming the plan limitation and the fact that no token
 * change fixes it. A tool that 403s opaquely would be a quieter version of the
 * silence this whole effort exists to remove.
 */

/**
 * What the proxy is serving.
 *
 * A mode is exactly the set of operations tagged with it, so widening the proxy
 * means adding a mode and tagging operations into it — never loosening a check.
 *
 * **There is deliberately no write rung.** See the module header for the
 * decision and the four options it rejected. A future write mode is a new
 * member of this union, a new rung in {@link enabledLdModes}, and a policy
 * function standing where `refuseWriteOutsideCaller` stands for Atlassian — in
 * that order, and conspicuously, because this union is the first thing a
 * reviewer reads.
 */
export type LdProxyMode = 'off' | 'launchdarkly-read';

/** The environment variable that selects a mode. */
export const LD_PROXY_ENV_VAR = 'BUTCHR_LAUNCHDARKLY_PROXY';

/** Every mode this daemon knows, for the message an unrecognised value gets. */
export const LD_PROXY_MODES: readonly LdProxyMode[] = ['off', 'launchdarkly-read'];

/**
 * The tools `@launchdarkly/mcp-server --scope read` mounts, as its own
 * classification of which of its twenty tools are reads.
 *
 * **This is evidence, not mechanism.** Nothing at runtime consults it; the
 * granted scope is {@link LD_PROXY_OPERATIONS} and only that. What it is for is
 * `verify-launchdarkly-proxy-scope.mjs`, which asserts that every tool this
 * table offers is one LaunchDarkly itself calls a read — so a write cannot be
 * added to this file without going red against the vendor's own opinion rather
 * than against a reviewer's memory.
 *
 * Obtained by running the server and calling `tools/list`, not read from
 * documentation. Reproduce with, from any directory:
 *
 * ```
 * npx -y @launchdarkly/mcp-server start --transport stdio \
 *     --api-key <any-non-empty-string> --scope read
 * ```
 *
 * then speaking MCP `initialize` + `tools/list` over its stdio. `tools/list`
 * needs no valid credential, which is why the reproduction above does not want a
 * real token and must not be given one.
 *
 * Measured against `@launchdarkly/mcp-server` **0.6.2** on 2026-08-11:
 * `--scope read` mounts these ten, `--scope write` mounts the other ten, and the
 * two sets do not overlap.
 */
export const LD_READ_SCOPE_TOOLS: readonly string[] = [
  'get-audit-log-entries',
  'get-code-references',
  'get-flag-status-across-environments',
  'list-feature-flags',
  'get-feature-flag',
  'get-environments',
  'get-ai-config-targeting',
  'list-ai-configs',
  'get-ai-config',
  'get-ai-config-variation'
];

/**
 * The tools `--scope write` mounts. Present for one purpose: the verify script
 * asserts this table intersects it in **nothing**, which is a stronger statement
 * than "every tool we offer is a read" and fails in a different direction.
 */
export const LD_WRITE_SCOPE_TOOLS: readonly string[] = [
  'create-feature-flag',
  'update-feature-flag',
  'delete-feature-flag',
  'update-ai-config-targeting',
  'create-ai-config',
  'delete-ai-config',
  'update-ai-config',
  'create-ai-config-variation',
  'delete-ai-config-variation',
  'update-ai-config-variation'
];

/**
 * The modes a selected mode turns on.
 *
 * One rung today, and the function exists anyway rather than being inlined as an
 * equality: `atlassian-proxy.ts` learned that the strict-equality version has to
 * be rewritten by whoever adds the second mode, and a rule rewritten under
 * pressure is a rule that loses a case. Adding a rung here is meant to be the
 * conspicuous act — see {@link LdProxyMode}.
 */
export function enabledLdModes(mode: LdProxyMode): Exclude<LdProxyMode, 'off'>[] {
  switch (mode) {
    case 'off':
      return [];
    case 'launchdarkly-read':
      return ['launchdarkly-read'];
  }
}

/**
 * A path built from validated arguments, or the reason it was refused.
 *
 * A refusal is a string rather than a throw because it is an ordinary answer —
 * an agent that passes a project key with a slash in it has made a typo, not
 * caused an exception — and because the string is what the agent reads.
 *
 * There is no `body` member, unlike `atlassian-proxy.ts`'s `BuildResult`, and
 * its absence is load-bearing: this proxy has no operation that sends one, so
 * the type cannot express one. A write added here has to widen this type, which
 * is one more place the module header will be met.
 */
export type LdBuildResult = { path: string } | { error: string };

/** A query parameter this table will carry, and the rule its value must satisfy. */
export interface LdQueryParam {
  /** The name on the wire — LaunchDarkly's spelling, not ours. */
  name: string;
  /**
   * Validate and normalise one caller-supplied value, or refuse it.
   *
   * Returning `null` means "absent" — the parameter is omitted from the query
   * entirely, which is how every optional parameter's default is expressed:
   * LaunchDarkly's own default, never one invented here.
   */
  validate(raw: unknown): { value: string | null } | { error: string };
}

export interface LdOperation {
  /** The tool name as agents see it. */
  tool: string;
  /**
   * The tool this mirrors on `@launchdarkly/mcp-server`.
   *
   * Recorded per operation rather than derived by stripping a prefix, because
   * the mapping is a claim being made — that `launchdarkly_get_environments` is
   * the same operation LaunchDarkly calls `get-environments` — and the verify
   * script checks that claim against {@link LD_READ_SCOPE_TOOLS}. A derived name
   * would make the check a tautology about string manipulation.
   */
  mirrors: string;
  /** The mode that enables it. Never `off`. */
  mode: Exclude<LdProxyMode, 'off'>;
  /**
   * The LaunchDarkly API capability this operation needs, in LaunchDarkly's own
   * terms. Recorded per operation for `atlassian-proxy.ts`'s reason: "this mode
   * needs reader access" is a claim about a set, and the way a set quietly
   * acquires a wider scope is one member.
   */
  scope: string;
  /**
   * The HTTP method.
   *
   * `GET` is the only member of this union, which is the write decision
   * expressed as a type. Adding a verb is a change to this line, in a file whose
   * header says at length why it should not be made lightly.
   */
  method: 'GET';
  /** The path shape, with its parameters named, for the enumeration in a PR. */
  pathShape: string;
  /** What the agent-facing tool description says. */
  description: string;
  /** JSON Schema for the tool's arguments, as MCP wants it. */
  inputSchema: Record<string, unknown>;
  /**
   * Every query parameter this operation will carry. **The allowlist.**
   *
   * A parameter absent from this array cannot reach LaunchDarkly: {@link build}
   * iterates this list rather than the caller's object, so an unknown key is
   * dropped without ever being looked at.
   */
  query: readonly LdQueryParam[];
  /**
   * Whether this operation needs LaunchDarkly's beta API version header.
   *
   * The AI Configs endpoints are documented as beta. It makes no difference on
   * an account whose plan excludes them — both spellings answer 403 — but it is
   * what the API asks for and the difference will matter on an account that has
   * them.
   */
  beta?: boolean;
  /** Build the concrete path, or refuse. Never throws. */
  build(args: Record<string, any>): LdBuildResult;
}

/** How many items one proxied list may ask for. */
export const LD_PROXY_MAX_LIMIT = 50;

/**
 * A LaunchDarkly resource key, as LaunchDarkly spells one.
 *
 * Letters, digits, dot, underscore and hyphen — LaunchDarkly's own key charset.
 * The point of the check is not that LaunchDarkly would reject anything else: it
 * is that a key is interpolated into a **path segment**, so anything that could
 * carry a `/`, a `?`, a `#` or a `.` pair out of the segment and into the
 * endpoint must not reach it. Values are percent-encoded as well; this is the
 * belt to that pair of braces.
 *
 * A leading alphanumeric is required, which is what makes `..` and `.` unable to
 * be keys at all rather than merely unlikely ones.
 */
const LD_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

/**
 * A variation key. Same rule as {@link LD_KEY} — LaunchDarkly mints these as
 * UUIDs, which the charset covers, and a caller may equally be quoting one it
 * read out of a response. Kept as its own constant rather than reusing the name,
 * so that a future divergence has somewhere to go.
 */
const LD_VARIATION_KEY = LD_KEY;

/** A named path segment, validated, or the reason this one is not usable. */
function pathKey(
  args: Record<string, any>,
  field: string,
  example: string
): { key: string } | { error: string } {
  const raw = typeof args?.[field] === 'string' ? args[field].trim() : '';
  if (!raw) return { error: `${field} is required, e.g. "${example}"` };
  if (!LD_KEY.test(raw)) {
    return {
      error:
        `"${raw.slice(0, 60)}" is not a usable LaunchDarkly ${field}. Expected a key like ` +
        `"${example}" — letters, digits, dots, underscores and hyphens, starting with a letter ` +
        'or a digit. This proxy builds its own REST paths from validated arguments and never ' +
        `takes a path, so a ${field} is the only thing that can name that part of the endpoint.`
    };
  }
  return { key: raw };
}

/** A variation key, validated. Separate message: it is the one users paste. */
function variationKey(args: Record<string, any>): { key: string } | { error: string } {
  const raw = typeof args?.variationKey === 'string' ? args.variationKey.trim() : '';
  if (!raw) {
    return {
      error:
        'variationKey is required. Read the variation keys of an AI Config with ' +
        'launchdarkly_get_ai_config, which lists them.'
    };
  }
  if (!LD_VARIATION_KEY.test(raw)) {
    return {
      error:
        `"${raw.slice(0, 60)}" is not a usable variation key. LaunchDarkly mints these as ` +
        'identifiers of letters, digits, dots, underscores and hyphens; read them off ' +
        'launchdarkly_get_ai_config rather than composing one.'
    };
  }
  return { key: raw };
}

// ── the query-parameter validators ─────────────────────────────────────────
//
// Each is a named rule rather than an inline regex so that the table below reads
// as a list of decisions. They share one property, which is the containment this
// module rests on: every value they return is percent-encoded by `buildQuery`
// before it reaches a string, so none of them has to be trusted to keep a `&`
// or a `#` out of the endpoint. What they add on top of that is a *bound* — on
// length, on charset, on magnitude — so that a caller cannot turn one parameter
// into a megabyte or a full-account export.

/** Absent, or a bounded free-text value. */
function text(name: string, maxLength: number, hint: string): LdQueryParam {
  return {
    name,
    validate(raw) {
      if (raw === undefined || raw === null || raw === '') return { value: null };
      const value = String(raw).trim();
      if (!value) return { value: null };
      if (value.length > maxLength) {
        return { error: `${name} is ${value.length} characters; this proxy accepts up to ${maxLength}. ${hint}` };
      }
      // Control characters are the one class that cannot appear in any
      // LaunchDarkly parameter and can appear in a log line, so they are refused
      // here rather than encoded into the query and written to the audit line.
      // Written as escapes rather than as literal bytes: a literal control
      // character in a source file is invisible to a reviewer and survives a
      // careless copy-paste as something else entirely.
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(value)) {
        return { error: `${name} contains a control character, which no LaunchDarkly parameter takes.` };
      }
      return { value };
    }
  };
}

/** Absent, or one LaunchDarkly resource key — used for `env`, `tag`, project keys in a query. */
function keyParam(name: string, example: string): LdQueryParam {
  return {
    name,
    validate(raw) {
      if (raw === undefined || raw === null || raw === '') return { value: null };
      const value = String(raw).trim();
      if (!value) return { value: null };
      if (!LD_KEY.test(value)) {
        return {
          error:
            `"${value.slice(0, 60)}" is not a usable ${name}. Expected a LaunchDarkly key like ` +
            `"${example}". One key, not a list — this proxy sends a single ${name}.`
        };
      }
      return { value };
    }
  };
}

/**
 * Absent, or an integer clamped into range.
 *
 * Clamped rather than refused, for `atlassian-proxy.ts`'s reason: a bound is a
 * nicety to the caller and refusing a whole read over one is the sort of
 * pedantry that gets a proxy worked around. The bound itself is not negotiable —
 * it is what keeps one agent's typo from being a bulk read of the account.
 */
function boundedInt(name: string, min: number, max: number): LdQueryParam {
  return {
    name,
    validate(raw) {
      if (raw === undefined || raw === null || raw === '') return { value: null };
      const asked = Number(raw);
      if (!Number.isFinite(asked)) return { value: null };
      return { value: String(Math.min(Math.max(Math.floor(asked), min), max)) };
    }
  };
}

/** Absent, or exactly `true` / `false`. Nothing else becomes a boolean by accident. */
function boolParam(name: string): LdQueryParam {
  return {
    name,
    validate(raw) {
      if (raw === undefined || raw === null || raw === '') return { value: null };
      if (raw === true || raw === 'true') return { value: 'true' };
      if (raw === false || raw === 'false') return { value: 'false' };
      return { error: `${name} must be true or false, not ${JSON.stringify(String(raw).slice(0, 30))}.` };
    }
  };
}

/** Absent, or a millisecond timestamp. Bounded so it cannot become free text. */
function timestamp(name: string): LdQueryParam {
  return {
    name,
    validate(raw) {
      if (raw === undefined || raw === null || raw === '') return { value: null };
      const asked = Number(raw);
      if (!Number.isFinite(asked) || asked < 0 || asked > 4_102_444_800_000) {
        return {
          error:
            `${name} must be a Unix timestamp in milliseconds, e.g. 1786480000000. ` +
            `Got ${JSON.stringify(String(raw).slice(0, 30))}.`
        };
      }
      return { value: String(Math.floor(asked)) };
    }
  };
}

/**
 * Assemble the query string from the operation's allowlist.
 *
 * Iterates {@link LdOperation.query} rather than the caller's object, which is
 * the whole containment: a key the table does not declare is never read, so
 * there is no path by which it becomes a parameter. Every value is
 * `encodeURIComponent`'d on the way in.
 */
function buildQuery(
  params: readonly LdQueryParam[],
  args: Record<string, any>
): { query: string } | { error: string } {
  const parts: string[] = [];
  for (const param of params) {
    const result = param.validate(args?.[param.name]);
    if ('error' in result) return result;
    if (result.value === null) continue;
    parts.push(`${encodeURIComponent(param.name)}=${encodeURIComponent(result.value)}`);
  }
  return { query: parts.length ? `?${parts.join('&')}` : '' };
}

/** The shared tail of every tool description: what a failure looks like here. */
const LOUD =
  'A FAILURE HERE IS ALWAYS LOUD: if the daemon\'s credential is expired, revoked, unreachable, ' +
  'or not permitted this operation, you get an error naming the endpoint that refused it and ' +
  "what LaunchDarkly said — never an empty result that reads like a project with nothing in it.";

/** The extra sentence the AI Configs tools carry, because on many plans they 403. */
const PLAN_GATED =
  'NOTE: AI Configs are a plan-gated LaunchDarkly feature. On an account whose plan excludes ' +
  'them this returns a refusal naming the plan limitation — that is an account entitlement, not ' +
  'a broken credential and not a missing config, and no token change fixes it.';

/**
 * The operations this daemon proxies. **This table is the granted scope.**
 *
 * Ten, and they are not a selection made here: they are exactly the ten
 * `@launchdarkly/mcp-server --scope read` mounts ({@link LD_READ_SCOPE_TOOLS}),
 * so "which of LaunchDarkly's tools are reads" is answered by LaunchDarkly. The
 * verify script holds this table to that list in both directions.
 *
 * Every one is a GET. The scope this grants over what the daemon's credential
 * could already do is *not* empty — before this table the credential was used
 * for one thing, a validation probe at `/api/v2/projects?limit=1` — so what is
 * true instead is the honest version: **it grants reads and only reads**, and
 * the ten endpoints below are the whole of the surface.
 *
 * **Four of the ten cannot succeed on an account whose plan excludes AI
 * Configs**, where they answer 403. They are mirrored rather than omitted
 * because the plan is an account property that can change while this table
 * cannot, and because the refusal is legible: see {@link explainLdProxyFailure}.
 */
export const LD_PROXY_OPERATIONS: readonly LdOperation[] = [
  {
    tool: 'launchdarkly_list_feature_flags',
    mirrors: 'list-feature-flags',
    mode: 'launchdarkly-read',
    scope: 'reader:flags',
    method: 'GET',
    pathShape: '/api/v2/flags/{projectKey}{?env,tag,limit,offset,archived,summary,filter,sort,compare,expand}',
    description:
      "List the feature flags in a LaunchDarkly project, through the Butchr daemon's own " +
      'credential rather than through any per-agent LaunchDarkly session. Returns LaunchDarkly\'s ' +
      `raw response body. Bounded at ${LD_PROXY_MAX_LIMIT} flags per call — this is a proxy for ` +
      'agent-sized questions, not a bulk export; page with offset. Pass summary=true for a ' +
      `smaller payload. ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'The LaunchDarkly project key, e.g. "butchr".' },
        env: { type: 'string', description: 'Optional. One environment key, e.g. "production", to include that environment\'s configuration.' },
        tag: { type: 'string', description: 'Optional. Return only flags carrying this tag.' },
        limit: { type: 'number', description: `Optional. 1..${LD_PROXY_MAX_LIMIT}; LaunchDarkly's own default applies when omitted.` },
        offset: { type: 'number', description: 'Optional. Skip this many flags, for paging.' },
        archived: { type: 'boolean', description: 'Optional. true returns archived flags instead of active ones.' },
        summary: { type: 'boolean', description: 'Optional. true omits targeting rules, which is much smaller.' },
        filter: { type: 'string', description: 'Optional. LaunchDarkly filter expression, e.g. "query:my-flag".' },
        sort: { type: 'string', description: 'Optional. LaunchDarkly sort expression, e.g. "-creationDate".' },
        compare: { type: 'boolean', description: 'Optional. LaunchDarkly comparison mode.' },
        expand: { type: 'string', description: 'Optional. Comma-separated fields to expand.' }
      },
      required: ['projectKey']
    },
    query: [
      keyParam('env', 'production'),
      keyParam('tag', 'backend'),
      boundedInt('limit', 1, LD_PROXY_MAX_LIMIT),
      boundedInt('offset', 0, 100_000),
      boolParam('archived'),
      boolParam('summary'),
      text('filter', 300, 'Filter expressions are short, e.g. "query:my-flag".'),
      text('sort', 100, 'A sort expression names one field, e.g. "-creationDate".'),
      boolParam('compare'),
      text('expand', 200, 'A comma-separated list of field names.')
    ],
    build(args) {
      const project = pathKey(args, 'projectKey', 'butchr');
      if ('error' in project) return project;
      const query = buildQuery(this.query, args);
      if ('error' in query) return query;
      return { path: `/api/v2/flags/${encodeURIComponent(project.key)}${query.query}` };
    }
  },
  {
    tool: 'launchdarkly_get_feature_flag',
    mirrors: 'get-feature-flag',
    mode: 'launchdarkly-read',
    scope: 'reader:flags',
    method: 'GET',
    pathShape: '/api/v2/flags/{projectKey}/{featureFlagKey}{?env,expand}',
    description:
      "Read one feature flag's full configuration — variations, targeting rules and per-environment " +
      "state — through the Butchr daemon's own credential. Returns LaunchDarkly's raw response " +
      'body. Narrow it with env, which is much smaller than the default all-environments answer. ' +
      `${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'The LaunchDarkly project key, e.g. "butchr".' },
        featureFlagKey: { type: 'string', description: 'The flag key, e.g. "agent-runner".' },
        env: { type: 'string', description: 'Optional. Restrict the response to one environment, e.g. "production".' },
        expand: { type: 'string', description: 'Optional. Comma-separated fields to expand.' }
      },
      required: ['projectKey', 'featureFlagKey']
    },
    query: [keyParam('env', 'production'), text('expand', 200, 'A comma-separated list of field names.')],
    build(args) {
      const project = pathKey(args, 'projectKey', 'butchr');
      if ('error' in project) return project;
      const flag = pathKey(args, 'featureFlagKey', 'agent-runner');
      if ('error' in flag) return flag;
      const query = buildQuery(this.query, args);
      if ('error' in query) return query;
      return {
        path: `/api/v2/flags/${encodeURIComponent(project.key)}/${encodeURIComponent(flag.key)}${query.query}`
      };
    }
  },
  {
    tool: 'launchdarkly_get_flag_status_across_environments',
    mirrors: 'get-flag-status-across-environments',
    mode: 'launchdarkly-read',
    scope: 'reader:flags',
    method: 'GET',
    pathShape: '/api/v2/flag-status/{projectKey}/{featureFlagKey}{?env}',
    description:
      "Read one flag's lifecycle status in every environment — new, active, inactive or launched, " +
      'derived by LaunchDarkly from actual evaluation traffic rather than from configuration. ' +
      'This is the read that answers "is this flag safe to remove"; the configuration itself is ' +
      `launchdarkly_get_feature_flag. ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'The LaunchDarkly project key, e.g. "butchr".' },
        featureFlagKey: { type: 'string', description: 'The flag key, e.g. "agent-runner".' },
        env: { type: 'string', description: 'Optional. Restrict the answer to one environment.' }
      },
      required: ['projectKey', 'featureFlagKey']
    },
    query: [keyParam('env', 'production')],
    build(args) {
      const project = pathKey(args, 'projectKey', 'butchr');
      if ('error' in project) return project;
      const flag = pathKey(args, 'featureFlagKey', 'agent-runner');
      if ('error' in flag) return flag;
      const query = buildQuery(this.query, args);
      if ('error' in query) return query;
      return {
        path: `/api/v2/flag-status/${encodeURIComponent(project.key)}/${encodeURIComponent(flag.key)}${query.query}`
      };
    }
  },
  {
    tool: 'launchdarkly_get_environments',
    mirrors: 'get-environments',
    mode: 'launchdarkly-read',
    scope: 'reader:environments',
    method: 'GET',
    pathShape: '/api/v2/projects/{projectKey}/environments{?limit,offset,filter,sort}',
    description:
      "List a project's environments through the Butchr daemon's own credential, including which " +
      'are marked critical. This is how to find out programmatically which environment keys exist ' +
      'and which of them is production, rather than assuming the name. Bounded at ' +
      `${LD_PROXY_MAX_LIMIT} per call. ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'The LaunchDarkly project key, e.g. "butchr".' },
        limit: { type: 'number', description: `Optional. 1..${LD_PROXY_MAX_LIMIT}.` },
        offset: { type: 'number', description: 'Optional. Skip this many environments, for paging.' },
        filter: { type: 'string', description: 'Optional. LaunchDarkly filter expression.' },
        sort: { type: 'string', description: 'Optional. LaunchDarkly sort expression.' }
      },
      required: ['projectKey']
    },
    query: [
      boundedInt('limit', 1, LD_PROXY_MAX_LIMIT),
      boundedInt('offset', 0, 100_000),
      text('filter', 300, 'Filter expressions are short, e.g. "query:prod".'),
      text('sort', 100, 'A sort expression names one field.')
    ],
    build(args) {
      const project = pathKey(args, 'projectKey', 'butchr');
      if ('error' in project) return project;
      const query = buildQuery(this.query, args);
      if ('error' in query) return query;
      return { path: `/api/v2/projects/${encodeURIComponent(project.key)}/environments${query.query}` };
    }
  },
  {
    tool: 'launchdarkly_get_audit_log_entries',
    mirrors: 'get-audit-log-entries',
    mode: 'launchdarkly-read',
    scope: 'reader:auditlog',
    method: 'GET',
    pathShape: '/api/v2/auditlog{?before,after,q,limit,spec}',
    description:
      "Read LaunchDarkly's audit log through the Butchr daemon's own credential — who changed " +
      'what, and when. Narrow it to one flag with spec, whose format is ' +
      '"proj/<projectKey>:env/<envKey>:flag/<flagKey>" and which accepts "env/*" for all ' +
      `environments. Bounded at ${LD_PROXY_MAX_LIMIT} entries per call. ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        before: { type: 'number', description: 'Optional. Unix milliseconds; return entries before this moment.' },
        after: { type: 'number', description: 'Optional. Unix milliseconds; return entries after this moment.' },
        q: { type: 'string', description: 'Optional. Full-text search across entries.' },
        limit: { type: 'number', description: `Optional. 1..${LD_PROXY_MAX_LIMIT}.` },
        spec: {
          type: 'string',
          description:
            'Optional. A LaunchDarkly resource specifier, e.g. "proj/butchr:env/*:flag/agent-runner", ' +
            "which restricts the answer to one flag's change history."
        }
      },
      required: []
    },
    query: [
      timestamp('before'),
      timestamp('after'),
      text('q', 300, 'A search string, not a query language.'),
      boundedInt('limit', 1, LD_PROXY_MAX_LIMIT),
      text('spec', 500, 'A resource specifier, e.g. "proj/butchr:env/*:flag/agent-runner".')
    ],
    build(args) {
      const query = buildQuery(this.query, args);
      if ('error' in query) return query;
      return { path: `/api/v2/auditlog${query.query}` };
    }
  },
  {
    tool: 'launchdarkly_get_code_references',
    mirrors: 'get-code-references',
    mode: 'launchdarkly-read',
    scope: 'reader:code-references',
    method: 'GET',
    pathShape: '/api/v2/code-refs/repositories{?withBranches,withReferencesForDefaultBranch,projKey,flagKey}',
    description:
      'List the repositories LaunchDarkly has code references for, optionally narrowed to one ' +
      "project and flag, through the Butchr daemon's own credential. This is what tells an agent " +
      'whether a flag is referenced from one repository or several before it starts a cleanup. ' +
      'An empty items list means LaunchDarkly has no code-reference data for that scope — which ' +
      `is a real answer and not an error. ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projKey: { type: 'string', description: 'Optional. Restrict to one project key, e.g. "butchr".' },
        flagKey: { type: 'string', description: 'Optional. Restrict to one flag key, e.g. "agent-runner".' },
        withBranches: { type: 'string', description: 'Optional. LaunchDarkly branch-metadata selector.' },
        withReferencesForDefaultBranch: { type: 'string', description: 'Optional. Embed references for the default branch.' }
      },
      required: []
    },
    query: [
      keyParam('projKey', 'butchr'),
      keyParam('flagKey', 'agent-runner'),
      text('withBranches', 100, 'A short selector value.'),
      text('withReferencesForDefaultBranch', 100, 'A short selector value.')
    ],
    build(args) {
      const query = buildQuery(this.query, args);
      if ('error' in query) return query;
      return { path: `/api/v2/code-refs/repositories${query.query}` };
    }
  },
  {
    tool: 'launchdarkly_list_ai_configs',
    mirrors: 'list-ai-configs',
    mode: 'launchdarkly-read',
    scope: 'reader:ai-configs',
    method: 'GET',
    pathShape: '/api/v2/projects/{projectKey}/ai-configs{?limit,offset,filter,sort}',
    beta: true,
    description:
      "List a project's AI Configs through the Butchr daemon's own credential. Bounded at " +
      `${LD_PROXY_MAX_LIMIT} per call. ${PLAN_GATED} ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'The LaunchDarkly project key, e.g. "butchr".' },
        limit: { type: 'number', description: `Optional. 1..${LD_PROXY_MAX_LIMIT}.` },
        offset: { type: 'number', description: 'Optional. Skip this many configs, for paging.' },
        filter: { type: 'string', description: 'Optional. LaunchDarkly filter expression.' },
        sort: { type: 'string', description: 'Optional. LaunchDarkly sort expression.' }
      },
      required: ['projectKey']
    },
    query: [
      boundedInt('limit', 1, LD_PROXY_MAX_LIMIT),
      boundedInt('offset', 0, 100_000),
      text('filter', 300, 'Filter expressions are short.'),
      text('sort', 100, 'A sort expression names one field.')
    ],
    build(args) {
      const project = pathKey(args, 'projectKey', 'butchr');
      if ('error' in project) return project;
      const query = buildQuery(this.query, args);
      if ('error' in query) return query;
      return { path: `/api/v2/projects/${encodeURIComponent(project.key)}/ai-configs${query.query}` };
    }
  },
  {
    tool: 'launchdarkly_get_ai_config',
    mirrors: 'get-ai-config',
    mode: 'launchdarkly-read',
    scope: 'reader:ai-configs',
    method: 'GET',
    pathShape: '/api/v2/projects/{projectKey}/ai-configs/{configKey}',
    beta: true,
    description:
      "Read one AI Config — its variations and model settings — through the Butchr daemon's own " +
      `credential. This is also where the variation keys come from. ${PLAN_GATED} ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'The LaunchDarkly project key, e.g. "butchr".' },
        configKey: { type: 'string', description: 'The AI Config key.' }
      },
      required: ['projectKey', 'configKey']
    },
    query: [],
    build(args) {
      const project = pathKey(args, 'projectKey', 'butchr');
      if ('error' in project) return project;
      const config = pathKey(args, 'configKey', 'my-ai-config');
      if ('error' in config) return config;
      return {
        path: `/api/v2/projects/${encodeURIComponent(project.key)}/ai-configs/${encodeURIComponent(config.key)}`
      };
    }
  },
  {
    tool: 'launchdarkly_get_ai_config_targeting',
    mirrors: 'get-ai-config-targeting',
    mode: 'launchdarkly-read',
    scope: 'reader:ai-configs',
    method: 'GET',
    pathShape: '/api/v2/projects/{projectKey}/ai-configs/{configKey}/targeting',
    beta: true,
    description:
      "Read one AI Config's targeting — individual targets, rules and rollouts — through the " +
      'Butchr daemon\'s own credential. THIS READS THE TARGETING AND CANNOT CHANGE IT: this proxy ' +
      `has no write operation of any kind. ${PLAN_GATED} ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'The LaunchDarkly project key, e.g. "butchr".' },
        configKey: { type: 'string', description: 'The AI Config key.' }
      },
      required: ['projectKey', 'configKey']
    },
    query: [],
    build(args) {
      const project = pathKey(args, 'projectKey', 'butchr');
      if ('error' in project) return project;
      const config = pathKey(args, 'configKey', 'my-ai-config');
      if ('error' in config) return config;
      return {
        path:
          `/api/v2/projects/${encodeURIComponent(project.key)}/ai-configs/` +
          `${encodeURIComponent(config.key)}/targeting`
      };
    }
  },
  {
    tool: 'launchdarkly_get_ai_config_variation',
    mirrors: 'get-ai-config-variation',
    mode: 'launchdarkly-read',
    scope: 'reader:ai-configs',
    method: 'GET',
    pathShape: '/api/v2/projects/{projectKey}/ai-configs/{configKey}/variations/{variationKey}',
    beta: true,
    description:
      "Read one variation of an AI Config through the Butchr daemon's own credential. Read the " +
      `variation keys off launchdarkly_get_ai_config. ${PLAN_GATED} ${LOUD}`,
    inputSchema: {
      type: 'object',
      properties: {
        projectKey: { type: 'string', description: 'The LaunchDarkly project key, e.g. "butchr".' },
        configKey: { type: 'string', description: 'The AI Config key.' },
        variationKey: { type: 'string', description: 'The variation key, read from launchdarkly_get_ai_config.' }
      },
      required: ['projectKey', 'configKey', 'variationKey']
    },
    query: [],
    build(args) {
      const project = pathKey(args, 'projectKey', 'butchr');
      if ('error' in project) return project;
      const config = pathKey(args, 'configKey', 'my-ai-config');
      if ('error' in config) return config;
      const variation = variationKey(args);
      if ('error' in variation) return variation;
      return {
        path:
          `/api/v2/projects/${encodeURIComponent(project.key)}/ai-configs/` +
          `${encodeURIComponent(config.key)}/variations/${encodeURIComponent(variation.key)}`
      };
    }
  }
];

/**
 * The operations a mode enables. Empty for `off`, which is the whole of `off`.
 *
 * `off` returns before {@link enabledLdModes} is consulted at all, so there is
 * no arrangement of the ladder that can make `off` serve something.
 */
export function ldOperationsFor(mode: LdProxyMode): LdOperation[] {
  if (mode === 'off') return [];
  const on = new Set<string>(enabledLdModes(mode));
  return LD_PROXY_OPERATIONS.filter((op) => on.has(op.mode));
}

/**
 * Every distinct LaunchDarkly capability a mode requires, sorted.
 *
 * Derived from the table rather than declared beside it, so the enumeration a PR
 * pastes cannot drift from the operations it describes.
 */
export function ldGrantedScopes(mode: LdProxyMode): string[] {
  return [...new Set(ldOperationsFor(mode).map((op) => op.scope))].sort();
}

/** Find a proxied operation by tool name, whatever the mode. */
export function ldOperationByTool(tool: string): LdOperation | undefined {
  return LD_PROXY_OPERATIONS.find((op) => op.tool === tool);
}

export interface LdProxyDecision {
  mode: LdProxyMode;
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
export function selectedLdProxyMode(env: NodeJS.ProcessEnv = process.env): LdProxyDecision {
  const raw = env[LD_PROXY_ENV_VAR];
  if (raw === undefined || raw.trim() === '') {
    return { mode: 'off', source: 'default', rawValue: raw ?? null, fallbackReason: null };
  }
  const value = raw.trim().toLowerCase();
  // Exact membership of the declared list, so a new rung is enabled by being
  // added to `LD_PROXY_MODES` and cannot be enabled by anything else. No
  // truthiness, no prefix, no `1`.
  const matched = LD_PROXY_MODES.find((mode) => mode === value);
  if (matched) {
    return { mode: matched, source: 'environment', rawValue: raw, fallbackReason: null };
  }
  return {
    mode: 'off',
    source: 'default',
    rawValue: raw,
    fallbackReason:
      `${LD_PROXY_ENV_VAR} is set to "${raw}", which is not one of ${LD_PROXY_MODES.join(' | ')}. ` +
      'Falling back to off — an unreadable setting is never a licence to widen what the fleet ' +
      "can reach through the daemon's credential."
  };
}

/** What a proxied operation looks like to a reader enumerating the grant. */
export interface LdProxyOperationReport {
  tool: string;
  mirrors: string;
  method: 'GET';
  pathShape: string;
  scope: string;
  /** The query parameters this operation will carry, and nothing else can. */
  queryParams: string[];
}

/**
 * What the daemon says about its proxy, to `mcp.ts` and to a human alike.
 *
 * Built by {@link ldProxyReport} from the decision it was handed, never from a
 * second read of the environment: a report describing a mode the daemon is not
 * in is worse than no report.
 */
export interface LaunchDarklyProxyReport {
  mode: LdProxyMode;
  source: 'default' | 'environment';
  rawValue: string | null;
  fallbackReason: string | null;
  /** When this answer was computed. The mode is read per call — see the header. */
  readAt: string;
  /** Exactly what this mode exposes. Empty when off. */
  operations: LdProxyOperationReport[];
  /** The distinct capabilities those operations need. Empty when off. */
  scopes: string[];
  /**
   * Whether a credential is configured at all, and where it is stored — never
   * the credential.
   *
   * **A configured credential is not a working one**, and this field must not be
   * read as though it were: it says a token is on this machine, not that
   * LaunchDarkly still accepts it. Only a call establishes the other.
   */
  credential: { configured: boolean; storage?: string };
  /** One line an operator can read without knowing any of the above. */
  summary: string;
}

export function ldProxyReport(
  decision: LdProxyDecision,
  credential: { configured: boolean; storage?: string },
  now: () => Date = () => new Date()
): LaunchDarklyProxyReport {
  const operations = ldOperationsFor(decision.mode).map((op) => ({
    tool: op.tool,
    mirrors: op.mirrors,
    method: op.method,
    pathShape: op.pathShape,
    scope: op.scope,
    queryParams: op.query.map((param) => param.name)
  }));
  const scopes = ldGrantedScopes(decision.mode);

  const summary =
    decision.mode === 'off'
      ? 'The LaunchDarkly proxy is OFF. ' +
        (decision.source === 'default' && decision.rawValue === null
          ? `${LD_PROXY_ENV_VAR} is not set, which is the default.`
          : decision.fallbackReason
            ? decision.fallbackReason
            : `Turned off explicitly by ${LD_PROXY_ENV_VAR}=${decision.rawValue}.`) +
        ' No agent can reach LaunchDarkly through the daemon.'
      : `The LaunchDarkly proxy is serving ${operations.length} read operation(s) ` +
        `(${operations.map((op) => op.tool).join(', ')}) against ` +
        `${credential.configured ? `the credential stored in ${credential.storage ?? 'the configured backend'}` : 'NO CONFIGURED CREDENTIAL — every call will refuse'}, ` +
        `needing ${scopes.join(', ')} and nothing else. Selected by ${LD_PROXY_ENV_VAR}=${decision.rawValue}. ` +
        'THERE ARE NO WRITE OPERATIONS AND NO WRITE MODE: nothing reachable here can create, ' +
        'change or delete a flag, an environment or an AI Config, whatever the credential itself ' +
        'is permitted to do. A flag change is made by a human in the LaunchDarkly UI. ' +
        'A listed tool is not a working one: only a call establishes that the credential is ' +
        'still accepted, and the AI Config operations additionally require a plan that includes ' +
        'them.';

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
 * Why a call was refused before it reached LaunchDarkly, or `null` to proceed.
 *
 * Separate from the call itself so that the *reason* is testable without a
 * network, a credential or a daemon — the refusals are the security-relevant
 * half of this module and they should not need an instrument to check.
 *
 * THE ORDER IS THE DESIGN. The switch is consulted before the tool is looked up,
 * so a daemon with the proxy off gives the same refusal for every tool name and
 * reveals nothing about which operations exist.
 */
export function refuseLdProxyCall(
  mode: LdProxyMode,
  tool: string
): { error: string; reason: 'proxy-off' | 'unknown-tool' | 'not-in-mode' } | null {
  if (mode === 'off') {
    return {
      reason: 'proxy-off',
      error:
        `The Butchr daemon's LaunchDarkly proxy is off, so ${tool} is refused. It is off by ` +
        `default; an operator turns it on by setting ${LD_PROXY_ENV_VAR}=launchdarkly-read. ` +
        'Nothing is broken and LaunchDarkly is not down.'
    };
  }

  const op = ldOperationByTool(tool);
  if (!op) {
    // Named separately from "not in mode" because the commonest way to arrive
    // here is asking for a write — the ten tools this proxy does not have are
    // exactly LaunchDarkly's ten write tools — and an agent that gets a bare
    // "no such tool" will reasonably conclude it guessed the spelling wrong.
    const isKnownWrite = LD_WRITE_SCOPE_TOOLS.some(
      (name) => tool === `launchdarkly_${name.replace(/-/g, '_')}`
    );
    return {
      reason: 'unknown-tool',
      error:
        `${tool} is not an operation this proxy has. It serves exactly: ` +
        `${ldOperationsFor(mode).map((o) => o.tool).join(', ') || '(none)'}. ` +
        (isKnownWrite
          ? 'That is a LaunchDarkly WRITE tool, and this proxy deliberately has none: the ' +
            "daemon's credential holds account-admin authority, and there is no LaunchDarkly " +
            'resource that belongs to a calling agent the way a Jira ticket does, so there is no ' +
            'policy that could bound such a write. This is a decision recorded in ' +
            'launchdarkly-proxy.ts, not a gap. A flag change is made by a human in the ' +
            'LaunchDarkly UI. '
          : '') +
        'There is deliberately no operation that takes a REST path — the granted scope has to be ' +
        'readable off one table.'
    };
  }

  if (!enabledLdModes(mode).includes(op.mode)) {
    return {
      reason: 'not-in-mode',
      error:
        `${tool} belongs to proxy mode "${op.mode}", and this daemon is serving "${mode}". ` +
        `Set ${LD_PROXY_ENV_VAR}=${op.mode} to enable it — each mode is granted on its own merits.`
    };
  }

  return null;
}
