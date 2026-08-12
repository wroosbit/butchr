import { AdfConversionError, confluenceBody, markdownToAdf } from './adf.js';
import { JIRA_KEY } from './keys.js';
/** The environment variable that selects a mode. */
export const PROXY_ENV_VAR = 'BUTCHR_ATLASSIAN_PROXY';
/** Every mode this daemon knows, for the message an unrecognised value gets. */
export const PROXY_MODES = [
    'off',
    'jira-read',
    'confluence-read',
    'jira-write',
    'confluence-write'
];
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
 *
 * ## KAN-292 INSERTED A RUNG IN THE MIDDLE, AND THAT HAS ONE CONSEQUENCE WORTH
 * ## SAYING OUT LOUD
 *
 * `confluence-read` sits between the two rungs that existed, so **`jira-write`
 * now enables the Confluence reads as well**. That is a widening of an existing
 * mode and it is not a side effect nobody noticed — it is the ladder property
 * being kept rather than quietly abandoned. A rung that the rung above it did
 * *not* contain would make "one string, one rung, and the rung above contains
 * the rung below" false, and the value of that sentence is that an operator can
 * read the whole grant off one word. The alternative — a `jira-write` that
 * skips Confluence — would mean the grant was no longer a chain and had to be
 * read off a table instead, which is the property this design exists to avoid.
 *
 * It costs the operator nothing they had not already accepted: `jira-write`
 * already grants every read in `jira-read`, and Confluence reads are reads.
 *
 * ## KAN-293 ADDS A RUNG AT THE TOP, AND THE PLACE IT CUTS IS THE POLICY LINE
 *
 * `confluence-write` is the new top rung, and the division between it and
 * `jira-write` is not by product for its own sake — **it is the line slice A's
 * write-scoping policy can reach**:
 *
 *  - Every write in **`jira-write`** is bounded by the caller's own identity.
 *    Five of the six name the caller's own ticket; the sixth creates an issue in
 *    the caller's own project. An operator on this rung is granting agents the
 *    ability to write **to their own work and nowhere else**, which is what
 *    KAN-291 decided and what this slice inherits rather than re-opens.
 *  - Every write in **`confluence-write`** is *unscoped*, because there is
 *    nothing to scope it to: a Confluence page has no relationship to a Jira
 *    issue key that this daemon can read, so "your own ticket" names no page.
 *    Enabling this rung is therefore a genuinely wider grant — any agent may
 *    write any page the credential can reach — and it is a separate word an
 *    operator has to type for exactly that reason.
 *
 * **That line is enforced by the type system and not by care.** See
 * {@link ProxyOperation}: a write tagged `jira-write` whose scope is `unscoped`
 * does not compile. So the sentence "everything below the top rung is bounded
 * by the caller" cannot quietly stop being true.
 */
export function enabledModes(mode) {
    switch (mode) {
        case 'off':
            return [];
        case 'jira-read':
            return ['jira-read'];
        case 'confluence-read':
            return ['jira-read', 'confluence-read'];
        case 'jira-write':
            return ['jira-read', 'confluence-read', 'jira-write'];
        case 'confluence-write':
            return ['jira-read', 'confluence-read', 'jira-write', 'confluence-write'];
    }
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
function issueKey(args) {
    const raw = typeof args?.issueKey === 'string' ? args.issueKey.trim() : '';
    if (!raw)
        return { error: 'issueKey is required, e.g. "KAN-272"' };
    const upper = raw.toUpperCase();
    if (!JIRA_KEY.test(upper)) {
        return {
            error: `"${raw}" is not a Jira issue key. Expected PROJECT-123 — letters, then a hyphen, ` +
                'then digits. This proxy builds its own REST paths from validated arguments and ' +
                'never takes a path, so an issue key is the only thing that can name an issue here.'
        };
    }
    return { key: upper };
}
/** A validated `fields` list, or the default, or the reason it was refused. */
function fieldList(args, fallback) {
    const raw = args?.fields;
    if (raw === undefined || raw === null || raw === '')
        return { fields: fallback };
    const value = Array.isArray(raw) ? raw.join(',') : String(raw);
    const trimmed = value.trim();
    if (!FIELD_LIST.test(trimmed)) {
        return {
            error: `"${trimmed.slice(0, 60)}" is not a usable field list. Give a comma-separated list of ` +
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
function transitionId(args) {
    const raw = typeof args?.transitionId === 'string' || typeof args?.transitionId === 'number'
        ? String(args.transitionId).trim()
        : '';
    if (!raw) {
        return {
            error: 'transitionId is required. It is the numeric id of the transition to perform — ' +
                'list them with atlassian_get_transitions first, which is what tells you that ' +
                '"In Progress" is 21 on this workflow and something else on another.'
        };
    }
    if (!TRANSITION_ID.test(raw)) {
        return {
            error: `"${raw.slice(0, 40)}" is not a Jira transition id. Expected digits, e.g. "31" — ` +
                'a transition is named by its id and not by its name, because a workflow can have ' +
                'two transitions leading to the same status. Read them with atlassian_get_transitions.'
        };
    }
    return { id: raw };
}
/** How many rows one proxied Confluence or directory listing may ask for. */
export const PROXY_LIST_MAX_RESULTS = 50;
/**
 * A numeric Atlassian id — a Confluence page, space or comment — or the reason
 * this one is not.
 *
 * Digits only, for the reason {@link TRANSITION_ID} gives: the value is
 * concatenated into a path, so the thing that must be impossible is a value
 * carrying a `/`, a `?` or a `#` out of its segment. Percent-encoding already
 * makes that impossible; this is the belt to that pair of braces, and it is
 * also what turns a mistyped id into a sentence rather than a 404.
 *
 * Kept as a **string**, never coerced through `Number`: Confluence ids are
 * routinely larger than `Number.MAX_SAFE_INTEGER` and a round trip through a
 * double silently changes the last digits of one.
 */
const ATLASSIAN_ID = /^[0-9]{1,20}$/;
function numericId(args, field, what) {
    const raw = typeof args?.[field] === 'string' || typeof args?.[field] === 'number'
        ? String(args[field]).trim()
        : '';
    if (!raw)
        return { error: `${field} is required — the numeric id of ${what}.` };
    if (!ATLASSIAN_ID.test(raw)) {
        return {
            error: `"${raw.slice(0, 40)}" is not ${what} id. Expected digits, e.g. "163933". This proxy ` +
                'builds its own REST paths from validated arguments and never takes a path, so a ' +
                'numeric id is the only thing that can name one here.'
        };
    }
    return { id: raw };
}
/**
 * A Jira project key, or the reason this one is not.
 *
 * Jira's own rule: a letter, then letters, digits or underscores. Same
 * containment argument as every other validator here — it is a path segment.
 */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]{0,49}$/;
function projectKey(args) {
    const raw = typeof args?.projectKey === 'string' ? args.projectKey.trim() : '';
    if (!raw)
        return { error: 'projectKey is required, e.g. "KAN".' };
    if (!PROJECT_KEY.test(raw)) {
        return {
            error: `"${raw.slice(0, 40)}" is not a Jira project key. Expected a letter followed by ` +
                'letters, digits or underscores, e.g. "KAN".'
        };
    }
    return { key: raw.toUpperCase() };
}
/**
 * A free-text query — for CQL, for JQL, or for the federated search.
 *
 * **This is the one input that is not pattern-matched, and that is correct
 * rather than an oversight.** A query is prose: any character can legitimately
 * appear in one, so a character class would refuse valid searches without
 * bounding anything. What bounds it is where it goes — `encodeURIComponent`
 * into a single query parameter, which no character can escape — and a length
 * cap, which is what stops one agent turning a query into a denial of service.
 * `jql` above has been taking exactly this treatment since KAN-272.
 */
function freeText(args, field, example, limit = 2000) {
    const raw = typeof args?.[field] === 'string' ? args[field].trim() : '';
    if (!raw)
        return { error: `${field} is required, e.g. ${example}` };
    if (raw.length > limit) {
        return { error: `${field} is ${raw.length} characters; the proxy accepts up to ${limit}.` };
    }
    return { value: raw };
}
/**
 * A body an agent wrote, converted to ADF — or the reason it was refused
 * (KAN-293).
 *
 * ## THIS IS THE ONE ARGUMENT THAT IS GENUINELY CONTENT, AND IT IS STILL NOT A BODY
 *
 * Everything else this file validates is an identifier that goes into a path.
 * This is prose that goes into a request body, which is the surface the module
 * header calls "exactly as unbounded as a path" — so it is worth being precise
 * about why it does not reopen that hole.
 *
 * **An agent supplies text; the proxy builds the document.** What arrives is a
 * markdown string. What is sent is an ADF tree that `adf.ts` constructed node
 * by node from that string. There is no path by which a key an agent typed
 * becomes a key in the JSON — the agent cannot name a field, cannot reach a
 * sibling of `body`, and cannot inject a node type the converter does not
 * emit — for the same reason `{"transition":{"id":…}}` was safe with a digits
 * regex in front of it. The conversion **is** the validation, and it is a
 * whitelist by construction rather than a filter.
 *
 * The length cap is the other half. A body is the one input here that can be
 * megabytes, and Jira's own limit on a description is 32 000 characters.
 */
const MAX_BODY_CHARS = 32000;
function markdownBody(args, field, what, target, required = true) {
    const raw = typeof args?.[field] === 'string' ? args[field] : '';
    if (!raw.trim()) {
        if (!required)
            return { absent: true };
        return {
            error: `${field} is required — ${what}, as Markdown. Butchr converts it to ADF itself rather ` +
                'than asking Atlassian to, because the official markdown converter silently drops ' +
                'content on nested structures (KAN-183, KAN-266, reproduced 2026-08-12).'
        };
    }
    if (raw.length > MAX_BODY_CHARS) {
        return {
            error: `${field} is ${raw.length} characters; the proxy accepts up to ${MAX_BODY_CHARS}.`
        };
    }
    try {
        const { doc, coercions } = markdownToAdf(raw, target);
        return { doc, coercions };
    }
    catch (err) {
        // `markdownToAdf` throws exactly when it would otherwise have written
        // something incomplete. That is an ordinary refusal from an agent's point
        // of view, and its message is written for one, so it is passed through
        // rather than replaced with a sentence this file invented.
        return { error: err instanceof AdfConversionError ? err.message : `Could not convert ${field}: ${err?.message ?? String(err)}` };
    }
}
/**
 * A single line of plain text — a summary, a page title, a link type name.
 *
 * Newlines are stripped rather than refused: an agent that pasted a wrapped
 * sentence into a title meant the sentence, and Jira would reject the newline
 * with a less useful message than this would.
 */
function plainLine(args, field, what, limit = 255) {
    const raw = typeof args?.[field] === 'string' ? args[field].replace(/\s+/g, ' ').trim() : '';
    if (!raw)
        return { error: `${field} is required — ${what}.` };
    if (raw.length > limit) {
        return { error: `${field} is ${raw.length} characters; the proxy accepts up to ${limit}.` };
    }
    return { value: raw };
}
/**
 * A Jira time expression, as `addWorklog` wants it: `3h`, `1d 4h`, `45m`.
 *
 * Matched rather than passed through because it lands in a request body. Jira
 * would reject a malformed one, but "5 hours" failing with Jira's own error is
 * a worse experience than being told the spelling here.
 */
const TIME_SPENT = /^(\d+(\.\d+)?[wdhm]\s*)+$/;
function timeSpent(args) {
    const raw = typeof args?.timeSpent === 'string' ? args.timeSpent.trim() : '';
    if (!raw)
        return { error: 'timeSpent is required, e.g. "3h" or "1d 4h".' };
    if (!TIME_SPENT.test(raw)) {
        return {
            error: `"${raw.slice(0, 40)}" is not a Jira time expression. Use w/d/h/m units, e.g. "3h", ` +
                '"45m" or "1d 4h" — not "3 hours".'
        };
    }
    return { value: raw };
}
/**
 * The name of a Jira issue type or issue link type.
 *
 * Letters, spaces and hyphens: "Task", "Story", "Blocks", "Relates". A closed
 * character class rather than a closed *list*, because the list is per-site and
 * `atlassian_get_issue_link_types` / `atlassian_get_project_issue_types` are
 * the operations that read it — hard-coding it here would be a second copy of
 * something the site already answers.
 */
const TYPE_NAME = /^[A-Za-z][A-Za-z \-]{0,49}$/;
function typeName(args, field, what, example) {
    const raw = typeof args?.[field] === 'string' ? args[field].trim() : '';
    if (!raw)
        return { error: `${field} is required — ${what}, e.g. "${example}".` };
    if (!TYPE_NAME.test(raw)) {
        return {
            error: `"${raw.slice(0, 40)}" is not ${what}. Expected a name like "${example}" — letters, ` +
                `spaces and hyphens. Read the names this site actually has with ` +
                `${field === 'linkType' ? 'atlassian_get_issue_link_types' : 'atlassian_get_project_issue_types'}.`
        };
    }
    return { value: raw };
}
/** A bounded `limit`, clamped rather than refused. See `maxResults` on search. */
function listLimit(args, field = 'limit') {
    const asked = Number(args?.[field]);
    return Number.isFinite(asked) && asked >= 1
        ? Math.min(Math.floor(asked), PROXY_LIST_MAX_RESULTS)
        : PROXY_LIST_MAX_RESULTS;
}
/**
 * An Atlassian Resource Identifier, parsed into the two things that name a
 * resource — or the reason this one is not an ARI.
 *
 * ## WHY THIS IS NOT THE HOLE IT LOOKS LIKE
 *
 * KAN-292's ticket names `fetch` as the operation most likely to open one,
 * because the official tool takes an opaque `id` and returns "a Jira issue or
 * Confluence page". An opaque identifier that selects an endpoint is *exactly*
 * the shape of a caller-supplied path, and if an ARI were a URL this operation
 * would not exist.
 *
 * **It is not a URL. It is a five-field grammar** —
 * `ari:cloud:{product}:{cloudId}:{type}/{id}` — and every field is matched
 * against a closed set before anything is built:
 *
 *  - `product` must be exactly `jira` or `confluence`. Nothing else routes.
 *  - `type` must be exactly `issue` or `page`, and it must agree with the
 *    product: `jira`+`issue`, `confluence`+`page`. A `jira:page` is refused.
 *  - `id` is digits, or — for Jira only — an issue key, both already validated
 *    by the rules above.
 *  - `cloudId` is **ignored entirely**, which is the part worth reading twice.
 *    The daemon has exactly one credential bound to exactly one site, so the
 *    only site it can reach is its own; honouring a cloudId from an argument
 *    would be inventing a capability the credential does not have, and reading
 *    it as a *routing* instruction would be letting an agent name a host. It is
 *    parsed so the ARI validates, then discarded.
 *
 * What comes out is a product and an id, and the operation builds the same
 * fixed path it would have built had the agent passed them separately. The ARI
 * is an input format, not a destination.
 */
const ARI = /^ari:cloud:([a-z]+):([^:]*):([a-z-]+)\/(.+)$/;
export function parseAri(raw) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value) {
        return {
            error: 'id is required — an Atlassian Resource Identifier, e.g. ' +
                '"ari:cloud:jira:{cloudId}:issue/10301" or "ari:cloud:confluence:{cloudId}:page/163933".'
        };
    }
    const m = ARI.exec(value);
    if (!m) {
        return {
            error: `"${value.slice(0, 60)}" is not an ARI. Expected ari:cloud:{product}:{cloudId}:{type}/{id} ` +
                '— e.g. "ari:cloud:jira:{cloudId}:issue/10301". This proxy never takes a URL or a REST ' +
                'path, so an ARI is the only opaque-looking thing it accepts, and it is parsed rather ' +
                'than forwarded.'
        };
    }
    const [, product, , type, id] = m;
    if (product === 'jira' && type === 'issue') {
        // An ARI names an issue by its numeric id, but agents have a key far more
        // often than an id and both address the same endpoint. Accept either, and
        // validate each by its own existing rule rather than inventing a third.
        const trimmed = id.trim();
        if (ATLASSIAN_ID.test(trimmed))
            return { product: 'jira', type: 'issue', id: trimmed };
        if (JIRA_KEY.test(trimmed.toUpperCase())) {
            return { product: 'jira', type: 'issue', id: trimmed.toUpperCase() };
        }
        return {
            error: `"${trimmed.slice(0, 40)}" is not a Jira issue id or key. Expected digits (e.g. "10301") ` +
                'or a key (e.g. "KAN-292").'
        };
    }
    if (product === 'confluence' && type === 'page') {
        const trimmed = id.trim();
        if (ATLASSIAN_ID.test(trimmed))
            return { product: 'confluence', type: 'page', id: trimmed };
        return { error: `"${trimmed.slice(0, 40)}" is not a Confluence page id. Expected digits.` };
    }
    return {
        error: `This proxy fetches a Jira issue or a Confluence page and nothing else, so ` +
            `"${product}:${type}" is refused. Use ari:cloud:jira:{cloudId}:issue/{idOrKey} or ` +
            'ari:cloud:confluence:{cloudId}:page/{id}. The product and the type have to agree — a ' +
            'jira:page names nothing.'
    };
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
export const PROXY_OPERATIONS = [
    {
        tool: 'atlassian_get_issue',
        mode: 'jira-read',
        products: ['jira'],
        scope: 'read:jira-work',
        method: 'GET',
        pathShape: '/rest/api/3/issue/{issueKey}?fields={fields}',
        description: "Read one Jira issue through the Butchr daemon's own credential, rather than through " +
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
                    description: 'Optional. Comma-separated Jira field names, e.g. "status,summary,comment". ' +
                        'Defaults to status, summary, issuetype, assignee, parent, updated, issuelinks.'
                }
            },
            required: ['issueKey']
        },
        build(args) {
            const key = issueKey(args);
            if ('error' in key)
                return key;
            const fields = fieldList(args, 'status,summary,issuetype,assignee,parent,updated,issuelinks');
            if ('error' in fields)
                return fields;
            return {
                path: `/rest/api/3/issue/${encodeURIComponent(key.key)}` +
                    `?fields=${encodeURIComponent(fields.fields)}`
            };
        }
    },
    {
        tool: 'atlassian_search_issues',
        mode: 'jira-read',
        products: ['jira'],
        scope: 'read:jira-work',
        method: 'GET',
        pathShape: '/rest/api/3/search/jql?jql={jql}&fields={fields}&maxResults={maxResults}',
        description: "Run a JQL search through the Butchr daemon's own credential. Returns Jira's raw " +
            `response body. Bounded at ${PROXY_SEARCH_MAX_RESULTS} results — this is a proxy for ` +
            'agent-sized questions, not a bulk export. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                jql: { type: 'string', description: 'The JQL query, e.g. "project = KAN AND status = \'In Review\'".' },
                fields: {
                    type: 'string',
                    description: 'Optional. Comma-separated Jira field names. Defaults to status, summary, issuetype, assignee.'
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
            if (!jql)
                return { error: 'jql is required, e.g. "project = KAN AND status = \'In Review\'"' };
            if (jql.length > 2000) {
                return { error: `jql is ${jql.length} characters; the proxy accepts up to 2000.` };
            }
            const fields = fieldList(args, 'status,summary,issuetype,assignee');
            if ('error' in fields)
                return fields;
            // A non-numeric or out-of-range maxResults is clamped rather than
            // refused: it is a nicety, not an instruction, and refusing a whole
            // search over one is the sort of pedantry that gets a proxy worked
            // around. The bound itself is not negotiable — it is what keeps one
            // agent's typo from being a bulk read of the account.
            const asked = Number(args?.maxResults);
            const maxResults = Number.isFinite(asked) && asked >= 1
                ? Math.min(Math.floor(asked), PROXY_SEARCH_MAX_RESULTS)
                : PROXY_SEARCH_MAX_RESULTS;
            return {
                path: `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
                    `&fields=${encodeURIComponent(fields.fields)}&maxResults=${maxResults}`
            };
        }
    },
    {
        tool: 'atlassian_get_transitions',
        mode: 'jira-read',
        products: ['jira'],
        scope: 'read:jira-work',
        method: 'GET',
        pathShape: '/rest/api/3/issue/{issueKey}/transitions',
        description: 'List the workflow transitions available on a Jira issue right now, through the Butchr ' +
            "daemon's own credential. THIS READS THE TRANSITIONS; IT DOES NOT PERFORM ONE — " +
            'atlassian_transition_issue is what performs one, and it is offered only when the proxy ' +
            'is in its write mode. This is the tool that tells you the id to give it. A failure is ' +
            'loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: { type: 'string', description: 'The issue key, e.g. "KAN-272".' }
            },
            required: ['issueKey']
        },
        build(args) {
            const key = issueKey(args);
            if ('error' in key)
                return key;
            return { path: `/rest/api/3/issue/${encodeURIComponent(key.key)}/transitions` };
        }
    },
    {
        tool: 'atlassian_transition_issue',
        mode: 'jira-write',
        products: ['jira'],
        scope: 'write:jira-work',
        method: 'POST',
        pathShape: '/rest/api/3/issue/{issueKey}/transitions',
        bodyShape: '{"transition":{"id":"{transitionId}"}}',
        description: "Move a Jira issue through one workflow transition, using the Butchr daemon's own " +
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
                    description: "The issue key, e.g. \"KAN-291\". Must be this agent's own workspace key — the " +
                        'proxy refuses a transition of anybody else\'s ticket.'
                },
                transitionId: {
                    type: 'string',
                    description: 'The numeric id of the transition to perform, e.g. "31". Read the ids available ' +
                        'on this issue right now with atlassian_get_transitions.'
                }
            },
            required: ['issueKey', 'transitionId']
        },
        build(args) {
            const key = issueKey(args);
            if ('error' in key)
                return key;
            const id = transitionId(args);
            if ('error' in id)
                return id;
            return {
                path: `/rest/api/3/issue/${encodeURIComponent(key.key)}/transitions`,
                // The whole body, built here. Two validated strings go in and nothing
                // else can: there is no path by which a key an agent supplies becomes a
                // key in this object. See the module header.
                body: { transition: { id: id.id } }
            };
        },
        writeScope: {
            kind: 'own-ticket',
            issue(args) {
                const key = issueKey(args);
                return 'error' in key ? null : key.key;
            }
        }
    },
    // ── KAN-292: the rest of the read surface ────────────────────────────────
    //
    // Eighteen operations, and the count is deliberate: KAN-288 enumerates the
    // official server's tools and KAN-292's ticket subtracts the three above, but
    // BOTH arrived at their totals by mislabelling a list they had written
    // correctly. The live tool list has 31 tools, not 30 (KAN-288's Confluence
    // group is labelled 11 and lists 12), and this slice is 18 reads, not 17
    // (KAN-292's Jira group is labelled 5 and lists 6). Counted off the live list
    // as the ticket instructs, and cross-checked: 31 − 10 writes = 21 reads,
    // minus the 3 above = 18.
    //
    // All of them are GETs. `jira-read` keeps the shape it had — every operation
    // in it is still a read — and gains six Jira operations; `confluence-read` is
    // the new rung.
    //
    // ONE SCOPE IS GENUINELY NEW BEYOND CONFLUENCE, AND IT IS NOT THE ONE ANYBODY
    // WOULD PREDICT. `atlassian_get_user_info` and `atlassian_lookup_account_id`
    // read the *user directory*, which is `read:jira-user` and not
    // `read:jira-work`. So `jira-read` now names two scopes where it named one.
    // With the classic API token this daemon actually holds that costs nothing —
    // a classic token carries the account's own permissions rather than OAuth
    // scopes, and both were verified by real call — but the enumeration is what a
    // reviewer reads, and an enumeration that quietly rounds a second scope into
    // the first is the exact defect `grantedScopes` exists to prevent.
    {
        tool: 'atlassian_get_issue_link_types',
        mode: 'jira-read',
        products: ['jira'],
        scope: 'read:jira-work',
        method: 'GET',
        pathShape: '/rest/api/3/issueLinkType',
        description: 'List the Jira issue link types on this site (Blocks, Relates, Duplicate, Clones) with ' +
            'their inward and outward names, through the Butchr daemon\'s own credential. This is ' +
            'what tells you that "blocks" is spelled `Blocks` here and which end of it is which ' +
            'before you create a link. Takes no arguments — it describes the site, not an issue. ' +
            'A failure is loud: an expired or revoked credential produces an error naming the ' +
            'endpoint that refused it, never an empty list that reads like a site with no link types.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        build() {
            return { path: '/rest/api/3/issueLinkType' };
        }
    },
    {
        tool: 'atlassian_get_issue_remote_links',
        mode: 'jira-read',
        products: ['jira'],
        scope: 'read:jira-work',
        method: 'GET',
        pathShape: '/rest/api/3/issue/{issueKey}/remotelink',
        description: "Read the remote links on one Jira issue — links out to things that are not Jira issues, " +
            'such as a pull request or a Confluence page — through the Butchr daemon\'s own ' +
            'credential. NOTE THAT AN ISSUE WITH NO REMOTE LINKS ANSWERS WITH AN EMPTY ARRAY, and ' +
            'that is a real answer rather than a failure; a failure carries an error and a status. ' +
            'For links between Jira issues, read `issuelinks` with atlassian_get_issue instead.',
        inputSchema: {
            type: 'object',
            properties: { issueKey: { type: 'string', description: 'The issue key, e.g. "KAN-292".' } },
            required: ['issueKey']
        },
        build(args) {
            const key = issueKey(args);
            if ('error' in key)
                return key;
            return { path: `/rest/api/3/issue/${encodeURIComponent(key.key)}/remotelink` };
        }
    },
    {
        tool: 'atlassian_get_project_issue_types',
        mode: 'jira-read',
        products: ['jira'],
        scope: 'read:jira-work',
        method: 'GET',
        pathShape: '/rest/api/3/issue/createmeta/{projectKey}/issuetypes',
        description: 'List the issue types you can create in one Jira project, with their ids and hierarchy ' +
            "levels, through the Butchr daemon's own credential. THE HIERARCHY LEVEL IS THE USEFUL " +
            'PART: it is what tells you that Story and Task both sit at level 0 on this board and ' +
            'that a Task therefore cannot be parented to a Story, which is the trap that has ' +
            'orphaned tickets here before. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: { projectKey: { type: 'string', description: 'The project key, e.g. "KAN".' } },
            required: ['projectKey']
        },
        build(args) {
            const key = projectKey(args);
            if ('error' in key)
                return key;
            return { path: `/rest/api/3/issue/createmeta/${encodeURIComponent(key.key)}/issuetypes` };
        }
    },
    {
        tool: 'atlassian_get_issue_type_fields',
        mode: 'jira-read',
        products: ['jira'],
        scope: 'read:jira-work',
        method: 'GET',
        pathShape: '/rest/api/3/issue/createmeta/{projectKey}/issuetypes/{issueTypeId}',
        description: 'List the fields available when creating one issue type in one Jira project — which are ' +
            'required, which are optional, and what each will accept — through the Butchr daemon\'s ' +
            'own credential. This is what to read before filing a ticket that must carry a parent, ' +
            'rather than discovering at write time that the field was rejected. Get the issue type ' +
            'id from atlassian_get_project_issue_types. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                projectKey: { type: 'string', description: 'The project key, e.g. "KAN".' },
                issueTypeId: {
                    type: 'string',
                    description: 'The numeric issue type id, e.g. "10007". Read it with atlassian_get_project_issue_types.'
                }
            },
            required: ['projectKey', 'issueTypeId']
        },
        build(args) {
            const key = projectKey(args);
            if ('error' in key)
                return key;
            const id = numericId(args, 'issueTypeId', 'a Jira issue type');
            if ('error' in id)
                return id;
            return {
                path: `/rest/api/3/issue/createmeta/${encodeURIComponent(key.key)}` +
                    `/issuetypes/${encodeURIComponent(id.id)}`
            };
        }
    },
    {
        tool: 'atlassian_get_visible_projects',
        mode: 'jira-read',
        products: ['jira'],
        scope: 'read:jira-work',
        method: 'GET',
        pathShape: '/rest/api/3/project/search?maxResults={limit}',
        description: "List the Jira projects the daemon's credential can see, through that credential. NOTE " +
            'THAT "VISIBLE" MEANS VISIBLE TO THE DAEMON, NOT TO YOU: every agent shares one ' +
            'credential here, so this answers what that account can reach and not what your own ' +
            `Atlassian session could. Bounded at ${PROXY_LIST_MAX_RESULTS} results. A failure is ` +
            'loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: []
        },
        build(args) {
            return { path: `/rest/api/3/project/search?maxResults=${listLimit(args)}` };
        }
    },
    {
        tool: 'atlassian_lookup_account_id',
        mode: 'jira-read',
        // read:jira-user, not read:jira-work — this reads the user directory rather
        // than issue data, and it is the second scope `jira-read` has ever needed.
        // See the block comment above the KAN-292 operations.
        products: ['jira'],
        scope: 'read:jira-user',
        method: 'GET',
        pathShape: '/rest/api/3/user/search?query={query}&maxResults={limit}',
        description: 'Find Atlassian account ids by name or email, through the Butchr daemon\'s own ' +
            'credential. An account id is what assignee and reporter fields want; a display name is ' +
            'not one. THIS READS THE USER DIRECTORY, which is a different scope from reading issues ' +
            `— see the proxy's scope enumeration. Bounded at ${PROXY_LIST_MAX_RESULTS} results. A ` +
            'failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'A name or email fragment to search for, e.g. "wroosbit".'
                },
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: ['query']
        },
        build(args) {
            const q = freeText(args, 'query', '"wroosbit"', 200);
            if ('error' in q)
                return q;
            return {
                path: `/rest/api/3/user/search?query=${encodeURIComponent(q.value)}` +
                    `&maxResults=${listLimit(args)}`
            };
        }
    },
    // ── Confluence, which is new surface for this daemon ─────────────────────
    //
    // Nothing in the daemon read or wrote Confluence before this slice. That made
    // one question worth answering by call rather than by assumption, and KAN-292
    // required it: DOES THE CREDENTIAL ACTUALLY REACH CONFLUENCE? It does — all
    // eight of these returned 200 against real content on 2026-08-11, and the
    // output is in the PR. The reason is worth knowing rather than filing away:
    // the daemon holds a **classic** API token, which carries the account's own
    // permissions across every product on the site rather than a set of OAuth
    // scopes. So the `read:confluence-*` scopes named below are what these
    // operations would need *if* the credential were ever swapped for a scoped
    // token — they are the honest enumeration KAN-292 criterion 3 asks for, and
    // they are not a claim that anybody granted them one by one.
    //
    // Every path here is v2 (`/wiki/api/v2/...`) except the CQL search, which has
    // no v2 equivalent. Confluence's own `/wiki` prefix is what distinguishes
    // these from Jira on the site host; at the gateway it is the product base.
    {
        tool: 'atlassian_get_confluence_spaces',
        mode: 'confluence-read',
        products: ['confluence'],
        scope: 'read:confluence-space.summary',
        method: 'GET',
        pathShape: '/wiki/api/v2/spaces?limit={limit}',
        description: "List the Confluence spaces the daemon's credential can see, through that credential. " +
            'Returns each space\'s id, key and name — THE NUMERIC ID IS WHAT THE OTHER CONFLUENCE ' +
            'TOOLS WANT, not the key, and the two are not interchangeable. As with Jira projects, ' +
            '"visible" means visible to the daemon\'s shared account. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: []
        },
        build(args) {
            return { path: `/wiki/api/v2/spaces?limit=${listLimit(args)}` };
        }
    },
    {
        tool: 'atlassian_get_confluence_space_pages',
        mode: 'confluence-read',
        products: ['confluence'],
        scope: 'read:confluence-content.summary',
        method: 'GET',
        pathShape: '/wiki/api/v2/spaces/{spaceId}/pages?limit={limit}',
        description: 'List the pages in one Confluence space, through the Butchr daemon\'s own credential. ' +
            'Takes the space\'s NUMERIC ID — read it with atlassian_get_confluence_spaces; a space ' +
            `key is not an id and will be refused. Bounded at ${PROXY_LIST_MAX_RESULTS} pages. ` +
            'A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                spaceId: { type: 'string', description: 'The numeric space id, e.g. "163842".' },
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: ['spaceId']
        },
        build(args) {
            const id = numericId(args, 'spaceId', 'a Confluence space');
            if ('error' in id)
                return id;
            return {
                path: `/wiki/api/v2/spaces/${encodeURIComponent(id.id)}/pages?limit=${listLimit(args)}`
            };
        }
    },
    {
        tool: 'atlassian_get_confluence_page',
        mode: 'confluence-read',
        products: ['confluence'],
        scope: 'read:confluence-content.all',
        method: 'GET',
        pathShape: '/wiki/api/v2/pages/{pageId}?body-format={bodyFormat}',
        description: "Read one Confluence page through the Butchr daemon's own credential, body included. " +
            'RETURNS THE BODY IN CONFLUENCE\'S OWN FORMAT AND CONVERTS NOTHING — `storage` is the ' +
            'XHTML storage format and `atlas_doc_format` is ADF as JSON. This proxy deliberately ' +
            'does no markdown conversion in either direction: a converter that silently drops a ' +
            'nested list item is how KAN-183 lost a section, so what you get here is what Confluence ' +
            'stored. Verifying a page you wrote means reading it back with this and comparing. ' +
            'A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                pageId: { type: 'string', description: 'The numeric page id, e.g. "163933".' },
                bodyFormat: {
                    type: 'string',
                    enum: ['storage', 'atlas_doc_format', 'view'],
                    description: 'Optional. storage (XHTML, the default), atlas_doc_format (ADF), or view.'
                }
            },
            required: ['pageId']
        },
        build(args) {
            const id = numericId(args, 'pageId', 'a Confluence page');
            if ('error' in id)
                return id;
            // An enum, matched against a closed list rather than pattern-checked.
            // Anything unrecognised falls to `storage` rather than being refused: it
            // is a rendering nicety and refusing a whole page read over one is the
            // pedantry that gets a proxy worked around (the argument `maxResults`
            // makes above). Falling to a *fixed member of the list* is what keeps it
            // from reaching the path.
            const asked = typeof args?.bodyFormat === 'string' ? args.bodyFormat.trim() : '';
            const format = ['storage', 'atlas_doc_format', 'view'].includes(asked) ? asked : 'storage';
            return { path: `/wiki/api/v2/pages/${encodeURIComponent(id.id)}?body-format=${format}` };
        }
    },
    {
        tool: 'atlassian_get_confluence_page_descendants',
        mode: 'confluence-read',
        products: ['confluence'],
        scope: 'read:confluence-content.summary',
        method: 'GET',
        pathShape: '/wiki/api/v2/pages/{pageId}/descendants?limit={limit}',
        description: 'List everything beneath one Confluence page in the page tree, through the Butchr ' +
            "daemon's own credential. DESCENDANTS, NOT CHILDREN: this is the whole subtree rather " +
            'than one level. A page with nothing under it answers with an empty result set, which ' +
            'is a real answer and not a failure. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                pageId: { type: 'string', description: 'The numeric page id, e.g. "163933".' },
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: ['pageId']
        },
        build(args) {
            const id = numericId(args, 'pageId', 'a Confluence page');
            if ('error' in id)
                return id;
            return {
                path: `/wiki/api/v2/pages/${encodeURIComponent(id.id)}/descendants?limit=${listLimit(args)}`
            };
        }
    },
    {
        tool: 'atlassian_get_confluence_page_footer_comments',
        mode: 'confluence-read',
        products: ['confluence'],
        scope: 'read:confluence-content.all',
        method: 'GET',
        pathShape: '/wiki/api/v2/pages/{pageId}/footer-comments?limit={limit}',
        description: "Read the footer comments on one Confluence page — the ones at the bottom, not the ones " +
            'anchored to selected text — through the Butchr daemon\'s own credential. For the ' +
            'anchored kind use atlassian_get_confluence_page_inline_comments. A page with no ' +
            'comments answers with an empty result set, which is a real answer. A failure is loud, ' +
            'as above.',
        inputSchema: {
            type: 'object',
            properties: {
                pageId: { type: 'string', description: 'The numeric page id, e.g. "163933".' },
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: ['pageId']
        },
        build(args) {
            const id = numericId(args, 'pageId', 'a Confluence page');
            if ('error' in id)
                return id;
            return {
                path: `/wiki/api/v2/pages/${encodeURIComponent(id.id)}/footer-comments?limit=${listLimit(args)}`
            };
        }
    },
    {
        tool: 'atlassian_get_confluence_page_inline_comments',
        mode: 'confluence-read',
        products: ['confluence'],
        scope: 'read:confluence-content.all',
        method: 'GET',
        pathShape: '/wiki/api/v2/pages/{pageId}/inline-comments?limit={limit}',
        description: 'Read the inline comments on one Confluence page — the ones anchored to a selection of ' +
            "text — through the Butchr daemon's own credential. For the ones at the bottom of the " +
            'page use atlassian_get_confluence_page_footer_comments. A page with none answers with ' +
            'an empty result set, which is a real answer. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                pageId: { type: 'string', description: 'The numeric page id, e.g. "163933".' },
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: ['pageId']
        },
        build(args) {
            const id = numericId(args, 'pageId', 'a Confluence page');
            if ('error' in id)
                return id;
            return {
                path: `/wiki/api/v2/pages/${encodeURIComponent(id.id)}/inline-comments?limit=${listLimit(args)}`
            };
        }
    },
    {
        tool: 'atlassian_get_confluence_comment_children',
        mode: 'confluence-read',
        products: ['confluence'],
        scope: 'read:confluence-content.all',
        method: 'GET',
        pathShape: '/wiki/api/v2/footer-comments/{commentId}/children?limit={limit}',
        description: 'Read the replies to one Confluence footer comment, through the Butchr daemon\'s own ' +
            'credential. Takes the comment id, which comes from ' +
            'atlassian_get_confluence_page_footer_comments. A comment with no replies answers with ' +
            'an empty result set, which is a real answer. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                commentId: { type: 'string', description: 'The numeric footer comment id.' },
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: ['commentId']
        },
        build(args) {
            const id = numericId(args, 'commentId', 'a Confluence footer comment');
            if ('error' in id)
                return id;
            return {
                path: `/wiki/api/v2/footer-comments/${encodeURIComponent(id.id)}/children` +
                    `?limit=${listLimit(args)}`
            };
        }
    },
    {
        tool: 'atlassian_search_confluence_cql',
        mode: 'confluence-read',
        products: ['confluence'],
        scope: 'read:confluence-content.summary',
        method: 'GET',
        pathShape: '/wiki/rest/api/search?cql={cql}&limit={limit}',
        description: "Run a CQL search against Confluence through the Butchr daemon's own credential — the " +
            'Confluence counterpart of atlassian_search_issues. Use this when you know CQL; use ' +
            'atlassian_search for a plain-text question across both products. THIS IS THE ONE ' +
            'CONFLUENCE PATH HERE THAT IS NOT v2, because CQL search has no v2 equivalent. Bounded ' +
            `at ${PROXY_LIST_MAX_RESULTS} results. A failure is loud, as above.`,
        inputSchema: {
            type: 'object',
            properties: {
                cql: { type: 'string', description: 'The CQL query, e.g. \'type=page AND text ~ "butchr"\'.' },
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: ['cql']
        },
        build(args) {
            const cql = freeText(args, 'cql', '\'type=page AND text ~ "butchr"\'');
            if ('error' in cql)
                return cql;
            return {
                path: `/wiki/rest/api/search?cql=${encodeURIComponent(cql.value)}&limit=${listLimit(args)}`
            };
        }
    },
    // ── Account and cross-product ────────────────────────────────────────────
    {
        tool: 'atlassian_get_user_info',
        mode: 'jira-read',
        // read:jira-user — the user directory again. See the note above.
        products: ['jira'],
        scope: 'read:jira-user',
        method: 'GET',
        pathShape: '/rest/api/3/myself',
        description: 'Read the Atlassian account the Butchr daemon is authenticating as. THIS IS THE ' +
            "DAEMON'S ACCOUNT, NOT YOURS, and the difference matters here more than anywhere else " +
            'in this proxy: every agent on this machine shares one credential, so this answers the ' +
            'same thing for all of them and it is not evidence about who you are. It is the cheapest ' +
            "way to establish that the daemon's credential is still alive — a listed tool proves " +
            'nothing, a 200 here proves the credential works. A failure is loud, as above.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        build() {
            return { path: '/rest/api/3/myself' };
        }
    },
    {
        tool: 'atlassian_get_accessible_resources',
        mode: 'jira-read',
        products: ['site'],
        // Nothing. `/_edge/tenant_info` is unauthenticated site metadata — the one
        // endpoint in this table that needs no scope at all, and saying `none`
        // rather than rounding it into a neighbouring scope is the point of
        // enumerating per operation.
        scope: [],
        method: 'GET',
        pathShape: '/_edge/tenant_info',
        description: 'List the Atlassian sites the Butchr daemon can reach. THERE IS ALWAYS EXACTLY ONE, and ' +
            'that is the honest answer rather than a limitation of this implementation: the daemon ' +
            'holds one API token bound to one site, so one site is the whole of what it can reach. ' +
            'Returns that site\'s cloudId and url in the same shape the official tool uses. NOTE ' +
            'THAT `scopes` IS EMPTY AND THAT IS NOT A BUG — a classic API token carries the ' +
            "account's own permissions rather than a scope list, so there is no scope list to " +
            'report and an invented one would be worse than none.',
        inputSchema: { type: 'object', properties: {}, required: [] },
        build() {
            return { path: '/_edge/tenant_info' };
        },
        transform(bodies, context) {
            const cloudId = bodies[0]?.cloudId;
            // The site is the daemon's configured one, which is not in any response
            // body because Atlassian was never asked for it — that is exactly why
            // this operation needs a transform at all.
            return [
                {
                    id: cloudId ?? null,
                    url: context.siteUrl ?? null,
                    name: context.siteUrl ? new URL(context.siteUrl).hostname : null,
                    scopes: [],
                    avatarUrl: null
                }
            ];
        }
    },
    {
        tool: 'atlassian_fetch_resource',
        // Tagged at the widest product it can reach — see `ProxyOperation.products`
        // for why that is the safe direction and why there is no second gate.
        mode: 'confluence-read',
        products: ['jira', 'confluence'],
        scope: ['read:jira-work', 'read:confluence-content.all'],
        method: 'GET',
        pathShape: '/rest/api/3/issue/{id} | /wiki/api/v2/pages/{id}?body-format=storage',
        description: 'Fetch one Jira issue or one Confluence page by its ARI — the identifier that comes back ' +
            'in search results — through the Butchr daemon\'s own credential. THE ARI IS PARSED, ' +
            'NEVER FORWARDED: only ari:cloud:jira:{cloudId}:issue/{idOrKey} and ' +
            'ari:cloud:confluence:{cloudId}:page/{id} resolve, the cloudId in it is ignored because ' +
            'the daemon can only reach its own site, and anything else is refused with a sentence ' +
            'saying so. If you already have an issue key use atlassian_get_issue and if you have a ' +
            'page id use atlassian_get_confluence_page; this exists for the case where all you have ' +
            'is what a search handed you. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                id: {
                    type: 'string',
                    description: 'The ARI, e.g. "ari:cloud:jira:{cloudId}:issue/10301" or ' +
                        '"ari:cloud:confluence:{cloudId}:page/163933".'
                }
            },
            required: ['id']
        },
        build(args) {
            const ari = parseAri(args?.id);
            if ('error' in ari)
                return ari;
            if (ari.product === 'jira') {
                return {
                    product: 'jira',
                    path: `/rest/api/3/issue/${encodeURIComponent(ari.id)}` +
                        `?fields=${encodeURIComponent('status,summary,issuetype,assignee,parent,updated,issuelinks')}`
                };
            }
            return {
                product: 'confluence',
                path: `/wiki/api/v2/pages/${encodeURIComponent(ari.id)}?body-format=storage`
            };
        }
    },
    {
        tool: 'atlassian_search',
        mode: 'confluence-read',
        products: ['jira', 'confluence'],
        scope: ['read:jira-work', 'read:confluence-content.summary'],
        method: 'GET',
        pathShape: '/rest/api/3/search/jql?jql=text~{query} + /wiki/rest/api/search?cql=text~{query}',
        description: 'Search Jira and Confluence for a plain-text phrase through the Butchr daemon\'s own ' +
            'credential, and get both sets of hits back together. Use atlassian_search_issues when ' +
            'you want to write JQL and atlassian_search_confluence_cql when you want to write CQL; ' +
            'this is for the case where you just have words. ' +
            'IMPORTANT — THIS IS NOT ROVO SEARCH, AND IT DOES NOT RANK LIKE IT. The official ' +
            "`search` tool is Rovo, which this daemon's credential cannot reach at all (a classic " +
            'API token is refused by every Rovo endpoint — it is the wrong kind of credential, not ' +
            'a missing scope). What this does instead is ask each product its own text query and ' +
            'return both answers, so results are ranked within each product and are NOT interleaved ' +
            'or scored against each other. If relative ranking across products matters to you, this ' +
            'will not give it to you and nothing available here would. A failure is loud, as above.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'The words to search for, e.g. "merge governance".' },
                limit: {
                    type: 'number',
                    description: `Optional. 1..${PROXY_LIST_MAX_RESULTS} per product; defaults to ${PROXY_LIST_MAX_RESULTS}.`
                }
            },
            required: ['query']
        },
        build(args) {
            const q = freeText(args, 'query', '"merge governance"', 500);
            if ('error' in q)
                return q;
            const limit = listLimit(args);
            // A quoted phrase in both query languages. The quote characters are ours;
            // an embedded quote in the caller's text is stripped rather than escaped,
            // because there is no reading of a stray quote that is worth risking a
            // query that means something other than it looks like. Both values are
            // then percent-encoded into a single parameter, which is what actually
            // contains them — see `freeText` on why prose is not pattern-matched.
            const phrase = q.value.replace(/["\\]/g, ' ').trim();
            const jql = `text ~ "${phrase}" ORDER BY updated DESC`;
            const cql = `text ~ "${phrase}"`;
            return {
                requests: [
                    {
                        product: 'jira',
                        path: `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
                            `&fields=${encodeURIComponent('status,summary,issuetype,updated')}` +
                            `&maxResults=${limit}`
                    },
                    {
                        product: 'confluence',
                        path: `/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`
                    }
                ]
            };
        },
        transform(bodies) {
            // Two answers in, one object out, each half left in the shape its own API
            // returned it. Deliberately NOT merged into a single ranked list: there
            // is no score to merge on, and inventing an ordering would be exactly the
            // artifact-claiming-more-than-its-mechanism defect this epic keeps
            // finding. The caller is told which product each hit came from by which
            // key it is under.
            const [jira, confluence] = bodies;
            return {
                jira: { issues: jira?.issues ?? [] },
                confluence: { results: confluence?.results ?? [] },
                note: 'Two independent product searches, not Rovo Search. Ranked within each product ' +
                    'and not against each other.'
            };
        }
    },
    // ── KAN-293: the content writes ──────────────────────────────────────────
    //
    // Nine operations, which completes the surface: 22 + 9 = 31, against the 31
    // tools the official Atlassian MCP server offers. Counted off the LIVE tool
    // list as every ticket in this epic instructs, because the tickets' own
    // arithmetic has been wrong twice — 21 reads (18 of them KAN-292's, 3
    // KAN-272's) and 10 writes (1 of them KAN-291's transition, 9 here).
    //
    // WHAT MAKES THESE ONE SLICE IS THE BODY, NOT THE VERB. Every operation below
    // carries content an agent wrote, and all of it goes through ONE converter —
    // `adf.ts` — for a reason measured rather than assumed: Atlassian's own
    // markdown→ADF conversion silently drops nested structures, and the proof of
    // that is in `adf.ts`'s header along with the page ids. Sending ADF we built
    // ourselves is the only way to know what was stored.
    //
    // FIVE OF THE SIX JIRA WRITES NAME THE CALLER'S OWN TICKET, which is KAN-291's
    // policy applied rather than re-decided. The two places it needed extending —
    // a link has two endpoints, and a created issue has no key yet — are extended
    // in `WriteScope`, where the argument for each is written down next to what it
    // permits. THE FOUR CONFLUENCE WRITES ARE UNSCOPED, they say so, and they sit
    // in a rung of their own that an operator has to enable by name.
    {
        tool: 'atlassian_add_comment',
        mode: 'jira-write',
        products: ['jira'],
        scope: 'write:jira-work',
        method: 'POST',
        pathShape: '/rest/api/3/issue/{issueKey}/comment',
        bodyShape: '{"body":{ADF built from your markdown}}',
        description: "Comment on a Jira issue, using the Butchr daemon's own credential. YOU MAY ONLY " +
            "COMMENT ON YOUR OWN TICKET — the issue key must be this workspace's own key, and a " +
            'call naming any other issue is refused before it reaches Atlassian. The body is ' +
            'Markdown and Butchr converts it to ADF itself; it does NOT use the official ' +
            "converter, which silently drops content nested inside list items. If your markdown " +
            'cannot be converted without losing something, the call is refused and nothing is ' +
            'written rather than a comment appearing with a paragraph missing. A failure is loud.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: {
                    type: 'string',
                    description: "The issue key, e.g. \"KAN-293\". Must be this agent's own workspace key."
                },
                bodyMarkdown: { type: 'string', description: 'The comment, as Markdown.' }
            },
            required: ['issueKey', 'bodyMarkdown']
        },
        build(args) {
            const key = issueKey(args);
            if ('error' in key)
                return key;
            const body = markdownBody(args, 'bodyMarkdown', 'the comment text', 'jira');
            if ('error' in body)
                return body;
            if ('absent' in body)
                return { error: 'bodyMarkdown is required.' };
            return {
                path: `/rest/api/3/issue/${encodeURIComponent(key.key)}/comment`,
                body: { body: body.doc }
            };
        },
        writeScope: {
            kind: 'own-ticket',
            issue(args) {
                const key = issueKey(args);
                return 'error' in key ? null : key.key;
            }
        }
    },
    {
        tool: 'atlassian_add_worklog',
        mode: 'jira-write',
        products: ['jira'],
        scope: 'write:jira-work',
        method: 'POST',
        pathShape: '/rest/api/3/issue/{issueKey}/worklog',
        bodyShape: '{"timeSpent":"{timeSpent}","comment":{ADF}?,"started":"{started}"?}',
        description: "Log work against a Jira issue, using the Butchr daemon's own credential. YOU MAY ONLY " +
            'LOG WORK ON YOUR OWN TICKET. timeSpent is a Jira time expression ("3h", "1d 4h", ' +
            '"45m") and the optional comment is Markdown converted to ADF by Butchr. A failure is ' +
            'loud.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: {
                    type: 'string',
                    description: "The issue key. Must be this agent's own workspace key."
                },
                timeSpent: { type: 'string', description: 'How long, e.g. "3h" or "1d 4h".' },
                comment: { type: 'string', description: 'Optional note, as Markdown.' },
                started: {
                    type: 'string',
                    description: 'Optional ISO-8601 start time with milliseconds and a numeric offset, e.g. ' +
                        '"2026-08-12T04:00:00.000+0000". Defaults to now.'
                }
            },
            required: ['issueKey', 'timeSpent']
        },
        build(args) {
            const key = issueKey(args);
            if ('error' in key)
                return key;
            const spent = timeSpent(args);
            if ('error' in spent)
                return spent;
            const comment = markdownBody(args, 'comment', 'a note about the work', 'jira', false);
            if ('error' in comment)
                return comment;
            // Jira's worklog `started` is one of its fussiest formats and it rejects
            // anything else with a 400 that does not say so. Matched here, and
            // omitted entirely when absent so Jira applies its own default.
            const startedRaw = typeof args?.started === 'string' ? args.started.trim() : '';
            if (startedRaw && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/.test(startedRaw)) {
                return {
                    error: `"${startedRaw.slice(0, 40)}" is not a Jira worklog start time. Jira wants exactly ` +
                        '"YYYY-MM-DDTHH:mm:ss.SSS+0000" — milliseconds are required and the offset carries ' +
                        'no colon. Omit it to log the work as starting now.'
                };
            }
            return {
                path: `/rest/api/3/issue/${encodeURIComponent(key.key)}/worklog`,
                body: {
                    timeSpent: spent.value,
                    ...('absent' in comment ? {} : { comment: comment.doc }),
                    ...(startedRaw ? { started: startedRaw } : {})
                }
            };
        },
        writeScope: {
            kind: 'own-ticket',
            issue(args) {
                const key = issueKey(args);
                return 'error' in key ? null : key.key;
            }
        }
    },
    {
        tool: 'atlassian_edit_issue',
        mode: 'jira-write',
        products: ['jira'],
        scope: 'write:jira-work',
        method: 'PUT',
        pathShape: '/rest/api/3/issue/{issueKey}',
        bodyShape: '{"fields":{"summary"?,"description":{ADF}?,"parent"?,"labels"?}}',
        description: "Edit a Jira issue's summary, description, parent epic or labels, using the Butchr " +
            "daemon's own credential. YOU MAY ONLY EDIT YOUR OWN TICKET. The description is " +
            'Markdown converted to ADF by Butchr rather than by the official converter, which ' +
            'silently drops nested content. FOUR FIELDS AND NO OTHERS: this proxy builds the whole ' +
            'request body from validated arguments and there is deliberately no way to name an ' +
            'arbitrary Jira field, because that would grant every field the edit API accepts. If ' +
            'you need one this does not offer, say so on your ticket. A failure is loud.',
        inputSchema: {
            type: 'object',
            properties: {
                issueKey: {
                    type: 'string',
                    description: "The issue key. Must be this agent's own workspace key."
                },
                summary: { type: 'string', description: 'Optional new summary (one line).' },
                description: { type: 'string', description: 'Optional new description, as Markdown.' },
                parent: {
                    type: 'string',
                    description: 'Optional parent EPIC key. A Task cannot be a child of a Story — both sit at the ' +
                        'same hierarchy level and Jira refuses the write.'
                },
                labels: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional replacement label list.'
                }
            },
            required: ['issueKey']
        },
        build(args) {
            const key = issueKey(args);
            if ('error' in key)
                return key;
            const fields = {};
            if (args?.summary !== undefined && args.summary !== '') {
                const summary = plainLine(args, 'summary', 'the new issue summary');
                if ('error' in summary)
                    return summary;
                fields.summary = summary.value;
            }
            const description = markdownBody(args, 'description', 'the new description', 'jira', false);
            if ('error' in description)
                return description;
            if (!('absent' in description))
                fields.description = description.doc;
            if (args?.parent !== undefined && args.parent !== '') {
                const parent = issueKey({ issueKey: args.parent });
                if ('error' in parent) {
                    return { error: `parent: ${parent.error}` };
                }
                fields.parent = { key: parent.key };
            }
            if (args?.labels !== undefined) {
                if (!Array.isArray(args.labels))
                    return { error: 'labels must be an array of strings.' };
                const labels = args.labels.map((label) => String(label).trim());
                const bad = labels.find((label) => !/^[A-Za-z0-9_.-]{1,255}$/.test(label));
                if (bad !== undefined) {
                    return {
                        error: `"${String(bad).slice(0, 40)}" is not a usable Jira label. Labels carry no spaces ` +
                            '— letters, digits, underscore, dot and hyphen.'
                    };
                }
                fields.labels = labels;
            }
            if (!Object.keys(fields).length) {
                return {
                    error: 'Nothing to edit. Give at least one of summary, description, parent or labels — ' +
                        'an edit with no fields would be a request that changes nothing and reports success.'
                };
            }
            return { path: `/rest/api/3/issue/${encodeURIComponent(key.key)}`, body: { fields } };
        },
        writeScope: {
            kind: 'own-ticket',
            issue(args) {
                const key = issueKey(args);
                return 'error' in key ? null : key.key;
            }
        }
    },
    {
        tool: 'atlassian_create_issue_link',
        mode: 'jira-write',
        products: ['jira'],
        scope: 'write:jira-work',
        method: 'POST',
        pathShape: '/rest/api/3/issueLink',
        bodyShape: '{"type":{"name":"{linkType}"},"inwardIssue":{"key":…},"outwardIssue":{"key":…}}',
        description: "Link two Jira issues, using the Butchr daemon's own credential. AT LEAST ONE END MUST " +
            "BE YOUR OWN TICKET — linking two issues that are both somebody else's is refused. " +
            'Read the link type names this site has with atlassian_get_issue_link_types; "Relates" ' +
            'and "Blocks" are the usual ones, and the direction is inward/outward as that tool ' +
            'reports it. A failure is loud.',
        inputSchema: {
            type: 'object',
            properties: {
                linkType: {
                    type: 'string',
                    description: 'The link type name, e.g. "Relates" or "Blocks".'
                },
                inwardIssue: { type: 'string', description: 'The issue on the inward side.' },
                outwardIssue: { type: 'string', description: 'The issue on the outward side.' }
            },
            required: ['linkType', 'inwardIssue', 'outwardIssue']
        },
        build(args) {
            const type = typeName(args, 'linkType', 'a Jira issue link type', 'Relates');
            if ('error' in type)
                return type;
            const inward = issueKey({ issueKey: args?.inwardIssue });
            if ('error' in inward)
                return { error: `inwardIssue: ${inward.error}` };
            const outward = issueKey({ issueKey: args?.outwardIssue });
            if ('error' in outward)
                return { error: `outwardIssue: ${outward.error}` };
            if (inward.key === outward.key) {
                return { error: `Cannot link ${inward.key} to itself.` };
            }
            return {
                path: '/rest/api/3/issueLink',
                body: {
                    type: { name: type.value },
                    inwardIssue: { key: inward.key },
                    outwardIssue: { key: outward.key }
                }
            };
        },
        writeScope: {
            kind: 'own-ticket-endpoint',
            issues(args) {
                const inward = issueKey({ issueKey: args?.inwardIssue });
                const outward = issueKey({ issueKey: args?.outwardIssue });
                return [
                    ...('error' in inward ? [] : [inward.key]),
                    ...('error' in outward ? [] : [outward.key])
                ];
            }
        }
    },
    {
        tool: 'atlassian_create_issue',
        mode: 'jira-write',
        products: ['jira'],
        scope: 'write:jira-work',
        method: 'POST',
        pathShape: '/rest/api/3/issue',
        bodyShape: '{"fields":{"project":{"key":…},"issuetype":{"name":…},"summary":…,"description":{ADF}?,"parent":{"key":…}?}}',
        description: "File a new Jira issue, using the Butchr daemon's own credential. YOU MAY ONLY CREATE " +
            "IN YOUR OWN PROJECT — the project is taken from your own ticket's key and a call " +
            'naming another project is refused. SET THE PARENT EPIC AT CREATION: an unparented ' +
            "ticket is invisible in its epic's org chart and names nobody as its approver. Read " +
            "your own ticket's parent with atlassian_get_issue and copy it; the parent is the EPIC " +
            'and never a Story, because Story and Task sit at the same hierarchy level and Jira ' +
            'refuses that write. The description is Markdown converted to ADF by Butchr. A failure ' +
            'is loud.',
        inputSchema: {
            type: 'object',
            properties: {
                projectKey: {
                    type: 'string',
                    description: "The project key, e.g. \"KAN\". Must be your own ticket's project."
                },
                issueType: { type: 'string', description: 'Issue type name, e.g. "Task" or "Story".' },
                summary: { type: 'string', description: 'One-line summary.' },
                description: { type: 'string', description: 'Optional description, as Markdown.' },
                parent: {
                    type: 'string',
                    description: 'Parent EPIC key. Copy it from your own ticket unless it has none.'
                }
            },
            required: ['projectKey', 'issueType', 'summary']
        },
        build(args) {
            const project = projectKey(args);
            if ('error' in project)
                return project;
            const type = typeName(args, 'issueType', 'a Jira issue type', 'Task');
            if ('error' in type)
                return type;
            const summary = plainLine(args, 'summary', 'the issue summary');
            if ('error' in summary)
                return summary;
            const description = markdownBody(args, 'description', 'the issue description', 'jira', false);
            if ('error' in description)
                return description;
            const fields = {
                project: { key: project.key },
                issuetype: { name: type.value },
                summary: summary.value
            };
            if (!('absent' in description))
                fields.description = description.doc;
            if (args?.parent !== undefined && args.parent !== '') {
                const parent = issueKey({ issueKey: args.parent });
                if ('error' in parent)
                    return { error: `parent: ${parent.error}` };
                fields.parent = { key: parent.key };
            }
            return { path: '/rest/api/3/issue', body: { fields } };
        },
        writeScope: {
            kind: 'own-project',
            project(args) {
                const project = projectKey(args);
                return 'error' in project ? null : project.key;
            }
        }
    },
    // ── The Confluence writes. Unscoped, and the rung says so. ────────────────
    {
        tool: 'atlassian_create_confluence_page',
        mode: 'confluence-write',
        products: ['confluence'],
        scope: 'write:confluence-content',
        method: 'POST',
        pathShape: '/wiki/api/v2/pages',
        bodyShape: '{"spaceId":…,"status":"current","title":…,"parentId":…?,"body":{"representation":"atlas_doc_format","value":"{ADF}"}}',
        description: "Create a Confluence page, using the Butchr daemon's own credential. THIS IS NOT " +
            'RESTRICTED TO YOUR OWN WORK — unlike every Jira write here, a page has no relationship ' +
            'to your ticket that the daemon can check, so this can write anywhere the credential ' +
            'reaches. The body is Markdown converted to ADF by Butchr, NOT by the official ' +
            'converter, which silently drops blockquotes nested in list items and takes the whole ' +
            'list item with them. If the conversion would lose anything the call is refused. ' +
            'A failure is loud.',
        inputSchema: {
            type: 'object',
            properties: {
                spaceId: { type: 'string', description: 'Numeric space id, from atlassian_get_confluence_spaces.' },
                title: { type: 'string', description: 'The page title.' },
                bodyMarkdown: { type: 'string', description: 'The page content, as Markdown.' },
                parentId: { type: 'string', description: 'Optional numeric id of the parent page.' }
            },
            required: ['spaceId', 'title', 'bodyMarkdown']
        },
        build(args) {
            const space = numericId(args, 'spaceId', 'a Confluence space');
            if ('error' in space)
                return space;
            const title = plainLine(args, 'title', 'the page title');
            if ('error' in title)
                return title;
            const body = markdownBody(args, 'bodyMarkdown', 'the page content', 'confluence');
            if ('error' in body)
                return body;
            if ('absent' in body)
                return { error: 'bodyMarkdown is required.' };
            let parentId;
            if (args?.parentId !== undefined && args.parentId !== '') {
                const parent = numericId(args, 'parentId', 'a Confluence page');
                if ('error' in parent)
                    return parent;
                parentId = parent.id;
            }
            return {
                path: '/wiki/api/v2/pages',
                product: 'confluence',
                body: {
                    spaceId: space.id,
                    status: 'current',
                    title: title.value,
                    ...(parentId ? { parentId } : {}),
                    body: confluenceBody(body.doc)
                }
            };
        },
        writeScope: {
            kind: 'unscoped',
            justification: 'A Confluence page has no Jira issue key, so the caller\'s own ticket names no page ' +
                'and there is nothing for KAN-291\'s own-ticket rule to compare against. Bounded ' +
                'instead by the rung: an operator enables confluence-write by name, separately from ' +
                'every Jira write, and every call is attributed in the audit log.'
        }
    },
    {
        tool: 'atlassian_update_confluence_page',
        mode: 'confluence-write',
        products: ['confluence'],
        scope: 'write:confluence-content',
        method: 'PUT',
        pathShape: '/wiki/api/v2/pages/{pageId}',
        bodyShape: '{"id":…,"status":"current","title":…,"version":{"number":…},"body":{"representation":"atlas_doc_format","value":"{ADF}"}}',
        description: "Replace a Confluence page's content, using the Butchr daemon's own credential. NOT " +
            'RESTRICTED TO YOUR OWN WORK — see atlassian_create_confluence_page. YOU MUST PASS THE ' +
            "PAGE'S CURRENT VERSION NUMBER, read with atlassian_get_confluence_page: Confluence " +
            'uses it for optimistic locking, so a stale number is refused rather than silently ' +
            'overwriting somebody else\'s edit. This REPLACES the body; read the page first if you ' +
            'mean to append. The body is Markdown converted to ADF by Butchr. A failure is loud.',
        inputSchema: {
            type: 'object',
            properties: {
                pageId: { type: 'string', description: 'Numeric page id.' },
                title: { type: 'string', description: 'The page title (required by the API even if unchanged).' },
                bodyMarkdown: { type: 'string', description: 'The new page content, as Markdown.' },
                version: {
                    type: 'string',
                    description: "The page's CURRENT version number, from atlassian_get_confluence_page. Butchr " +
                        'sends the next one.'
                },
                versionMessage: { type: 'string', description: 'Optional note for the version history.' }
            },
            required: ['pageId', 'title', 'bodyMarkdown', 'version']
        },
        build(args) {
            const page = numericId(args, 'pageId', 'a Confluence page');
            if ('error' in page)
                return page;
            const title = plainLine(args, 'title', 'the page title');
            if ('error' in title)
                return title;
            const body = markdownBody(args, 'bodyMarkdown', 'the page content', 'confluence');
            if ('error' in body)
                return body;
            if ('absent' in body)
                return { error: 'bodyMarkdown is required.' };
            const current = numericId(args, 'version', "the page's current version");
            if ('error' in current)
                return current;
            let message;
            if (args?.versionMessage !== undefined && args.versionMessage !== '') {
                const note = plainLine(args, 'versionMessage', 'the version note');
                if ('error' in note)
                    return note;
                message = note.value;
            }
            return {
                path: `/wiki/api/v2/pages/${encodeURIComponent(page.id)}`,
                product: 'confluence',
                body: {
                    id: page.id,
                    status: 'current',
                    title: title.value,
                    // The caller supplies the version it read; Confluence wants the one
                    // it is being moved to. Incremented here rather than by the agent so
                    // that "the number you read" is the only thing anybody has to get
                    // right, and computed with BigInt because page versions are not
                    // bounded by anything this file should assume.
                    version: {
                        number: Number(BigInt(current.id) + 1n),
                        ...(message ? { message } : {})
                    },
                    body: confluenceBody(body.doc)
                }
            };
        },
        writeScope: {
            kind: 'unscoped',
            justification: 'As atlassian_create_confluence_page: no Jira key names a page. Additionally bounded ' +
                "by Confluence's own optimistic locking — a write against a stale version number is " +
                'refused by the API, so this cannot silently clobber a concurrent edit.'
        }
    },
    {
        tool: 'atlassian_create_confluence_footer_comment',
        mode: 'confluence-write',
        products: ['confluence'],
        scope: 'write:confluence-content',
        method: 'POST',
        pathShape: '/wiki/api/v2/footer-comments',
        bodyShape: '{"pageId":…,"parentCommentId":…?,"body":{"representation":"atlas_doc_format","value":"{ADF}"}}',
        description: "Comment at the foot of a Confluence page, using the Butchr daemon's own credential. " +
            'NOT RESTRICTED TO YOUR OWN WORK — see atlassian_create_confluence_page. Pass ' +
            'parentCommentId to reply to an existing comment rather than starting a thread. The ' +
            'body is Markdown converted to ADF by Butchr. A failure is loud.',
        inputSchema: {
            type: 'object',
            properties: {
                pageId: { type: 'string', description: 'Numeric page id.' },
                bodyMarkdown: { type: 'string', description: 'The comment, as Markdown.' },
                parentCommentId: {
                    type: 'string',
                    description: 'Optional numeric id of the comment being replied to.'
                }
            },
            required: ['pageId', 'bodyMarkdown']
        },
        build(args) {
            const page = numericId(args, 'pageId', 'a Confluence page');
            if ('error' in page)
                return page;
            const body = markdownBody(args, 'bodyMarkdown', 'the comment text', 'confluence');
            if ('error' in body)
                return body;
            if ('absent' in body)
                return { error: 'bodyMarkdown is required.' };
            let parent;
            if (args?.parentCommentId !== undefined && args.parentCommentId !== '') {
                const reply = numericId(args, 'parentCommentId', 'a Confluence comment');
                if ('error' in reply)
                    return reply;
                parent = reply.id;
            }
            return {
                path: '/wiki/api/v2/footer-comments',
                product: 'confluence',
                body: {
                    pageId: page.id,
                    ...(parent ? { parentCommentId: parent } : {}),
                    body: confluenceBody(body.doc)
                }
            };
        },
        writeScope: {
            kind: 'unscoped',
            justification: 'As atlassian_create_confluence_page: no Jira key names a page.'
        }
    },
    {
        tool: 'atlassian_create_confluence_inline_comment',
        mode: 'confluence-write',
        products: ['confluence'],
        scope: 'write:confluence-content',
        method: 'POST',
        pathShape: '/wiki/api/v2/inline-comments',
        bodyShape: '{"pageId":…,"body":{…},"inlineCommentProperties":{"textSelection":…,"textSelectionMatchCount":…,"textSelectionMatchIndex":…}}',
        description: "Comment on a specific passage of a Confluence page, using the Butchr daemon's own " +
            'credential. NOT RESTRICTED TO YOUR OWN WORK — see atlassian_create_confluence_page. ' +
            'textSelection must match the page text EXACTLY or Confluence refuses the anchor; read ' +
            'the page with atlassian_get_confluence_page and copy the passage. The body is Markdown ' +
            'converted to ADF by Butchr. A failure is loud.',
        inputSchema: {
            type: 'object',
            properties: {
                pageId: { type: 'string', description: 'Numeric page id.' },
                bodyMarkdown: { type: 'string', description: 'The comment, as Markdown.' },
                textSelection: {
                    type: 'string',
                    description: 'The exact passage on the page this comment anchors to.'
                },
                matchIndex: {
                    type: 'number',
                    description: 'Which occurrence of that passage, counting from 0, when it appears more than ' +
                        'once. Defaults to 0.'
                },
                matchCount: {
                    type: 'number',
                    description: 'How many times the passage appears on the page. Defaults to 1.'
                }
            },
            required: ['pageId', 'bodyMarkdown', 'textSelection']
        },
        build(args) {
            const page = numericId(args, 'pageId', 'a Confluence page');
            if ('error' in page)
                return page;
            const body = markdownBody(args, 'bodyMarkdown', 'the comment text', 'confluence');
            if ('error' in body)
                return body;
            if ('absent' in body)
                return { error: 'bodyMarkdown is required.' };
            const selection = freeText(args, 'textSelection', '"the sentence you are commenting on"', 500);
            if ('error' in selection)
                return selection;
            const count = Number.isFinite(Number(args?.matchCount)) ? Math.max(1, Math.floor(Number(args.matchCount))) : 1;
            const index = Number.isFinite(Number(args?.matchIndex)) ? Math.max(0, Math.floor(Number(args.matchIndex))) : 0;
            if (index >= count) {
                return {
                    error: `matchIndex ${index} is not inside matchCount ${count} — the index counts from 0, ` +
                        'so the last occurrence of a passage appearing twice is index 1.'
                };
            }
            return {
                path: '/wiki/api/v2/inline-comments',
                product: 'confluence',
                body: {
                    pageId: page.id,
                    body: confluenceBody(body.doc),
                    inlineCommentProperties: {
                        textSelection: selection.value,
                        textSelectionMatchCount: count,
                        textSelectionMatchIndex: index
                    }
                }
            };
        },
        writeScope: {
            kind: 'unscoped',
            justification: 'As atlassian_create_confluence_page: no Jira key names a page.'
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
export function operationsFor(mode) {
    if (mode === 'off')
        return [];
    const on = new Set(enabledModes(mode));
    return PROXY_OPERATIONS.filter((op) => on.has(op.mode));
}
/** Every write in a mode. The set the caller restriction below has to cover. */
export function writeOperationsFor(mode) {
    return operationsFor(mode).filter((op) => op.method !== 'GET');
}
/**
 * Every distinct Atlassian scope a mode requires, sorted.
 *
 * Derived from the table rather than declared beside it, so the enumeration a
 * PR pastes cannot drift from the operations it describes. An operation added
 * with a wider scope changes this answer without anybody remembering to.
 */
export function grantedScopes(mode) {
    return [...new Set(operationsFor(mode).flatMap((op) => scopesOf(op)))].sort();
}
/**
 * The scopes one operation needs, always as a list.
 *
 * The single normalisation point for {@link ProxyOperation.scope}'s two shapes,
 * so that "which scopes does this need" has exactly one answer everywhere — the
 * report, the enumeration and any check that reads either.
 */
export function scopesOf(op) {
    return typeof op.scope === 'string' ? [op.scope] : [...op.scope];
}
/** Find a proxied operation by tool name, whatever the mode. */
export function operationByTool(tool) {
    return PROXY_OPERATIONS.find((op) => op.tool === tool);
}
/**
 * The mode this daemon is serving, from the environment.
 *
 * See the module header for why an unrecognised value falls to `off` and why
 * this is read on every call rather than captured at boot.
 */
export function selectedProxyMode(env = process.env) {
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
        fallbackReason: `${PROXY_ENV_VAR} is set to "${raw}", which is not one of ${PROXY_MODES.join(' | ')}. ` +
            'Falling back to off — an unreadable setting is never a licence to widen what the ' +
            "fleet can reach through the daemon's credential."
    };
}
export function proxyReport(decision, credential, now = () => new Date()) {
    const operations = operationsFor(decision.mode).map((op) => ({
        tool: op.tool,
        method: op.method,
        products: op.products,
        pathShape: op.pathShape,
        ...(op.bodyShape ? { bodyShape: op.bodyShape } : {}),
        scope: scopesOf(op),
        ownTicketOnly: op.writeScope?.kind === 'own-ticket',
        ...(op.writeScope
            ? {
                writeScope: {
                    kind: op.writeScope.kind,
                    ...(op.writeScope.kind === 'unscoped'
                        ? { justification: op.writeScope.justification }
                        : {})
                }
            }
            : {})
    }));
    const scopes = grantedScopes(decision.mode);
    const writes = operations.filter((op) => op.method !== 'GET');
    const unscoped = writes.filter((op) => op.writeScope?.kind === 'unscoped');
    const summary = decision.mode === 'off'
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
                ? `${writes.length - unscoped.length} of ${writes.length} write(s) are BOUND TO THE ` +
                    `CALLING AGENT'S OWN WORK (${writes
                        .filter((op) => op.writeScope?.kind !== 'unscoped')
                        .map((op) => `${op.tool}: ${op.writeScope?.kind}`)
                        .join(', ')}), which bounds accident and is not authentication — anything that ` +
                    'can reach the daemon socket can claim any identity. ' +
                    (unscoped.length
                        ? `${unscoped.length} write(s) are NOT BOUND BY THE CALLER AT ALL (${unscoped
                            .map((op) => op.tool)
                            .join(', ')}): any agent may write any Confluence content this credential ` +
                            'can reach. That is what enabling the confluence-write rung grants, it is why ' +
                            'it is a rung of its own, and the table\'s reason is: ' +
                            `${unscoped[0].writeScope?.justification ?? ''} `
                        : '') +
                    'A credential minted with only read scope will refuse these, loudly, on the first call. '
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
export function refuseProxyCall(mode, tool) {
    const op = operationByTool(tool);
    if (mode === 'off') {
        return {
            reason: 'proxy-off',
            error: `The Butchr daemon's Atlassian proxy is off, so ${tool} is refused. It is off by ` +
                `default; an operator turns it on by setting ${PROXY_ENV_VAR} to one of ` +
                `${PROXY_MODES.filter((m) => m !== 'off').join(' | ')} — each grants strictly more ` +
                `than the one before it. Use this ` +
                "agent's own Atlassian MCP tools instead — nothing about this refusal stops you " +
                'reaching Jira.'
        };
    }
    if (!op) {
        return {
            reason: 'unknown-tool',
            error: `${tool} is not an operation this proxy has. It serves exactly: ` +
                `${operationsFor(mode).map((o) => o.tool).join(', ') || '(none)'}. ` +
                'There is deliberately no operation that takes a REST path — the granted scope has ' +
                'to be readable off one table.'
        };
    }
    if (!enabledModes(mode).includes(op.mode)) {
        return {
            reason: 'not-in-mode',
            error: `${tool} belongs to proxy mode "${op.mode}", and this daemon is serving "${mode}". ` +
                `Set ${PROXY_ENV_VAR}=${op.mode} to enable it — each mode is granted on its own ` +
                'merits and they are deliberately not one block. Note that this one needs a ' +
                `credential holding ${scopesOf(op).join(' + ') || 'no scope at all'}, which a read-only token may not have.`
        };
    }
    return null;
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
export function refuseWriteOutsideCaller(op, args, caller) {
    // Reads are not restricted by this rule, and the TYPE says which is which:
    // `writeScope` exists on the write half of `ProxyOperation` and nowhere else,
    // so a write that reaches this function without one does not compile.
    if (!op.writeScope)
        return null;
    const scope = op.writeScope;
    // KAN-293: an unattributable write is refused whatever its scope, INCLUDING
    // the unscoped ones. That is not ceremony. `unscoped` means the caller's
    // identity does not *narrow* the write; it does not mean the write may be
    // anonymous. The audit line is the only remaining bound on a Confluence
    // write, and an audit line naming nobody bounds nothing at all.
    if (!caller || !caller.type || !caller.key) {
        return {
            reason: 'unidentified-caller',
            error: `${op.tool} is refused because this call did not say which workspace it came from, ` +
                'and every write through this proxy must be attributable. Nothing was sent to ' +
                'Atlassian. This is a bug in whatever made the call rather than something to work ' +
                'around: an unattributable write is exactly the one this proxy will not make.'
        };
    }
    if (scope.kind === 'unscoped')
        return null;
    // Every remaining scope is derived from the caller's own Jira key, so a
    // caller without one fails closed. See the docblock: a `confluence` workspace
    // keyed by a page id is the ordinary case here, not a corner one.
    if (!JIRA_KEY.test(caller.key.toUpperCase())) {
        return {
            reason: 'caller-has-no-ticket',
            error: `${op.tool} is refused: this is the "${caller.type}" workspace ${caller.key}, whose key ` +
                'is not a Jira issue, so it has no ticket of its own — and this write is permitted ' +
                `only against the caller's own work. Nothing was sent to Atlassian. Use this agent's ` +
                "own Atlassian MCP tools if you genuinely need to write to somebody else's issue."
        };
    }
    const mine = caller.key.toUpperCase();
    if (scope.kind === 'own-ticket') {
        const target = scope.issue(args);
        // `build` refuses a malformed key with a better sentence than anything here
        // could, and the handler calls it first. Reaching this with no target means
        // the arguments were unusable; let `build` be the one to say so.
        if (!target)
            return null;
        if (target !== mine) {
            return {
                reason: 'not-your-ticket',
                error: `${op.tool} is refused: ${caller.type}/${caller.key} asked to write to ${target}, and ` +
                    "the Butchr proxy permits a write only to the caller's own ticket. Nothing was sent " +
                    `to Atlassian and ${target} is unchanged. If ${target} genuinely has to change — ` +
                    'approving agents set Done on the tickets they approve, which is exactly this case ' +
                    "— use this agent's own Atlassian MCP tools, which are unaffected by this refusal."
            };
        }
        return null;
    }
    if (scope.kind === 'own-ticket-endpoint') {
        const targets = scope.issues(args);
        if (targets.length < 2)
            return null;
        if (!targets.includes(mine)) {
            return {
                reason: 'not-your-ticket',
                error: `${op.tool} is refused: ${caller.type}/${caller.key} asked to link ${targets.join(' to ')}, ` +
                    "and neither end is this agent's own ticket. A link is permitted when at least one " +
                    'end is your own — which is what lets you link a follow-up you just filed to your ' +
                    'ticket — but linking two issues that are both somebody else\'s is not yours to do. ' +
                    "Nothing was sent to Atlassian. Use this agent's own Atlassian MCP tools if the link " +
                    'genuinely has to exist.'
            };
        }
        return null;
    }
    // own-project. The caller's project is the part of its key before the hyphen,
    // which `JIRA_KEY` has already established is well formed.
    const target = scope.project(args);
    if (!target)
        return null;
    const myProject = mine.split('-')[0];
    if (target.toUpperCase() !== myProject) {
        return {
            reason: 'not-your-project',
            error: `${op.tool} is refused: ${caller.type}/${caller.key} asked to create an issue in ` +
                `project ${target}, and its own ticket lives in ${myProject}. The Butchr proxy permits ` +
                "creation only in the caller's own project. Nothing was sent to Atlassian and no " +
                `issue was created. Use this agent's own Atlassian MCP tools if you genuinely need to ` +
                `file into ${target}.`
        };
    }
    return null;
}
