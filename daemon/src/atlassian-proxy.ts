import {
  AdfConversionError,
  AdfDoc,
  AdfTarget,
  adfToText,
  confluenceBody,
  markdownToAdf
} from './adf.js';
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
 * ## WHAT KAN-292 ADDED: THE REST OF THE READS, AND TWO THINGS IT COULD NOT DO
 *
 * The table below went from four operations to twenty-two — eighteen reads,
 * covering every remaining Jira, Confluence and account read the official
 * Atlassian MCP server offers.
 *
 * **That parity ended deliberately with KAN-471, and the count below is the
 * count at KAN-293.** `atlassian_get_issue_comments` is the thirty-third
 * operation and the first that has no counterpart on the official server at
 * all: there is no comment-listing tool there, and the issue endpoint both
 * servers share caps the comment field at 100 with no way to page past it. So
 * "one operation per official tool" is no longer the table's shape, and should
 * not be restored as one — the whole value of that entry is that it reads
 * something nothing else can. See its own comment for the measurement.
 *
 * Two of KAN-292's are not what their names suggest,
 * and the header is where that is recorded rather than the ticket, because the
 * ticket is not what the next reader has open:
 *
 * **`atlassian_search` is not Rovo Search and cannot be.** The official
 * `search` tool is Rovo, and every Rovo endpoint refuses this daemon's
 * credential — `/gateway/api/rovo/search/v1/query`,
 * `/gateway/api/rovo/v1/search` and `/gateway/api/search/v1` all answer 404 to
 * a classic API token, measured 2026-08-11. That is not a missing scope, it is
 * the wrong kind of credential: Rovo is OAuth/app-scoped. So this operation
 * asks each product its own text query and returns both answers side by side.
 * It answers the question the tool exists for and **it does not rank across
 * products**, which is stated in its description and again in its own payload.
 *
 * **`getAccessibleAtlassianResources` has the same shape of problem** — its
 * real endpoint, `/oauth/token/accessible-resources`, is OAuth-only and answers
 * 401. It is answerable anyway, and honestly: the daemon holds one credential
 * bound to one site, so one site is the whole truthful answer, and
 * `/_edge/tenant_info` supplies its cloudId.
 *
 * **Confluence is new surface for this daemon**, which made one question worth
 * answering by call rather than assumption: the credential does reach
 * Confluence — all eight reads returned 200 against real content, including
 * three design docs of 51 KB, 19 KB and 64 KB read through this proxy. It
 * reaches it because a **classic** API token carries the account's own
 * permissions across every product on the site rather than a list of OAuth
 * scopes. The `read:confluence-*` scopes named in the table are therefore what
 * these operations would need *if* the credential were ever swapped for a
 * scoped one; they are an honest enumeration, not a record of grants anybody
 * made.
 *
 * **So the reads themselves are the evidence for the scope, and they are better
 * evidence than a scope listing would be** — `epic/KAN-39`'s framing at review
 * of #127, recorded here rather than left in a ticket comment. A listing states
 * what a credential is *said* to hold; a 200 against a real page is the scope
 * actually exercised. That distinction is the same one this module makes about
 * tool presence a few paragraphs down, and it fails the same way: what looks
 * fine is the *declaration*, and only a call establishes the other thing.
 *
 * ## Off by default, and read per call rather than once
 *
 * {@link selectedProxyMode} returns `'off'` for an unset variable, for an empty
 * one, and for anything it does not recognise. The only inputs that enable
 * anything are the exact strings in {@link PROXY_MODES}. No truthiness test, no
 * prefix match, no `1` — the discipline `runtime-switch.ts` established for
 * KAN-278, and for its stated reason: falling back to off costs nothing, while
 * falling back to on because somebody typed `jira_read` widens what an entire
 * fleet can do on the strength of a misspelling.
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
 *
 * **KAN-292 is where that was most likely to be lost, and it held.** Two of the
 * tools it adds look from outside like they want a caller-supplied endpoint.
 * Neither gets one. `atlassian_search` takes prose, which goes into a query
 * parameter exactly as `jql` has since KAN-272. `atlassian_fetch_resource`
 * takes an **ARI**, which is the one input here that could reasonably have been
 * a destination — and is not: an ARI is a five-field grammar, every field is
 * matched against a closed set, and the cloudId inside it is parsed and then
 * **discarded**, because honouring it would let an agent name a site. See
 * {@link parseAri}, which carries the argument in full.
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
export type ProxyMode =
  | 'off'
  | 'jira-read'
  | 'confluence-read'
  | 'jira-write'
  | 'confluence-write';

/**
 * Which Atlassian product an operation's path belongs to (KAN-292).
 *
 * It exists because **the host differs per product and nothing else does**. A
 * Jira path is served from `/ex/jira/{cloudId}` at the gateway; a Confluence
 * path from `/ex/confluence/{cloudId}`; and both from the bare site host, where
 * Confluence's own `/wiki` prefix already distinguishes them. So `product`
 * selects a base and grants nothing: it cannot widen a path, because the path
 * is still built by {@link ProxyOperation.build} from validated arguments.
 *
 * `site` is the odd one and is deliberately not a product at all — it is the
 * site host with no gateway leg, for `/_edge/tenant_info`, the one endpoint
 * here that is unauthenticated site metadata rather than a product API.
 */
export type ProxyProduct = 'jira' | 'confluence' | 'site';

/** The environment variable that selects a mode. */
export const PROXY_ENV_VAR = 'BUTCHR_ATLASSIAN_PROXY';

/** Every mode this daemon knows, for the message an unrecognised value gets. */
export const PROXY_MODES: readonly ProxyMode[] = [
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
export function enabledModes(mode: ProxyMode): Exclude<ProxyMode, 'off'>[] {
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
export type BuildResult =
  | { path: string; product?: ProxyProduct; body?: unknown }
  | { requests: ProxyRequest[] }
  | { error: string };

/**
 * What the DAEMON knows about itself, handed to {@link ProxyOperationBase.build}
 * as a second argument (KAN-577).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT AN ARGUMENT, AND WHY THAT IS THE WHOLE POINT
 * ---------------------------------------------------------------------------
 *
 * `atlassian_create_issue` has to put an assignee on every ticket it files,
 * and the only value that works is **the account this proxy authenticates
 * as** — because the board reconciler's query is
 * `assignee = currentUser() AND status IN ("In Progress", "In Review")` and
 * `currentUser()` resolves to exactly that account. An agent cannot supply it:
 * it does not know it, every agent on the machine would supply the same one,
 * and a caller-supplied assignee is a caller-supplied grant — it would let one
 * agent file work into somebody else's queue, which is the thing
 * {@link WriteScope} exists to prevent.
 *
 * So it arrives here rather than in `args`. `args` is what the caller sent and
 * is validated against a regex; this is what the daemon resolved and the caller
 * cannot reach.
 *
 * **`selfAccountId` is nullable and the null branch is real.** It is resolved
 * only for operations that declare {@link ProxyOperationBase.needsSelfAccountId},
 * and only from `/rest/api/3/myself` — the endpoint `atlassian_get_user_info`
 * already reads under the `read:jira-user` scope this table already declares, so
 * nothing here widens the grant. A credential that cannot answer that question
 * leaves this null, and an operation that needs it must **refuse**: see
 * `atlassian_create_issue`'s `build`, and see KAN-577 for why refusing beats
 * defaulting. A ticket filed with an empty assignee is invisible to the thing
 * that starts work, silently and permanently, and it reads exactly like a ticket
 * nobody has triaged.
 */
export interface ProxyBuildContext {
  /**
   * The Atlassian account id the daemon's own credential belongs to — or null
   * when the operation did not ask for it, or asked and could not be told.
   */
  selfAccountId: string | null;
}

/**
 * One concrete request an operation has decided to make.
 *
 * Nearly every operation makes exactly one and returns the `{ path }` shape
 * above; this exists for the operation that cannot (`atlassian_search`, which
 * has to ask two products the same question because the credential cannot reach
 * the one API that would have answered both — see its own docblock).
 *
 * **A fan-out is still a fixed grant.** The number of requests and the product
 * of each are decided by the table, not by the caller: there is no argument
 * that adds a request, removes one, or redirects one at a different product.
 * What an agent supplies is what it always supplies — validated values that get
 * percent-encoded into a path this file wrote.
 */
export interface ProxyRequest {
  product: ProxyProduct;
  path: string;
  body?: unknown;
}

/**
 * Everything true of a proxied operation whether it reads or writes.
 *
 * The fields that differ between the two — the mode, the verb, the body shape
 * and the write scope — are **not** here. They live on the two halves of
 * {@link ProxyOperation}, which is a discriminated union rather than one
 * interface with optional members, and that is the whole design: see its
 * docblock for what becomes impossible to write down.
 */
interface ProxyOperationBase {
  /** The tool name as agents see it. */
  tool: string;
  /**
   * Every product this operation can reach — the enumeration a reader wants
   * when asking "what can this mode touch", and the default {@link build} gets
   * when it returns a bare `{ path }`.
   *
   * A list rather than a single value because two operations genuinely span
   * products: `atlassian_search` asks both, and `atlassian_fetch_resource`
   * asks whichever one the ARI it was given names. **An operation is tagged
   * into the mode matching the WIDEST product it can reach**, never the
   * narrowest — so `atlassian_fetch_resource` needs `confluence-read` even to
   * fetch a Jira issue. That is the safe direction and it is deliberate: the
   * alternative is a second gate deciding per call whether the resolved product
   * is enabled, and a second copy of one condition is the copy that drifts.
   */
  products: readonly ProxyProduct[];
  /**
   * The Atlassian scope this operation needs.
   *
   * Recorded per operation rather than per mode because that is the granularity
   * a reviewer has to check: "this mode needs read:jira-work" is a claim about
   * a set, and the way a set quietly acquires a wider scope is one member.
   *
   * **A list, since KAN-292, and an empty one is a real answer.** Two
   * operations reach both products and genuinely need a scope from each, and
   * one (`atlassian_get_accessible_resources`) reads unauthenticated site
   * metadata and needs none at all. The first version of that operation wrote
   * its two scopes as one space-joined string, which type-checked, read
   * correctly, and silently defeated {@link grantedScopes} — a compound string
   * cannot deduplicate against the same scopes declared singly elsewhere, so
   * the enumeration grew an entry instead of reusing one. That is the exact
   * failure this field exists to make impossible, wearing the field's own
   * clothes.
   */
  scope: string | readonly string[];
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
  /**
   * Build the concrete path and body, or refuse. Never throws.
   *
   * The second argument is {@link ProxyBuildContext} — what the daemon knows
   * and the caller cannot supply. Nearly every operation ignores it, and the
   * signature is written so that they can: an implementation declared as
   * `build(args)` still satisfies this type, so KAN-577 added a parameter to
   * one operation without touching the other thirty-one.
   */
  build(args: Record<string, any>, context: ProxyBuildContext): BuildResult;
  /**
   * Whether this operation's {@link build} needs the daemon's own account id,
   * and therefore whether `router.ts` resolves one before calling it.
   *
   * Declared here rather than inferred, for the reason every other field in
   * this table is declared: the resolution costs a request the first time, and
   * an operation that silently acquired the need would silently acquire the
   * request. A `true` here is also what makes the refusal reachable — an
   * operation that needs the id and does not say so gets `null` and must handle
   * it, which is the branch a proof drives (KAN-577).
   */
  needsSelfAccountId?: true;
  /**
   * Reshape what Atlassian returned before the agent sees it, or combine the
   * answers of a fan-out into one (KAN-292).
   *
   * **Absent on all but four operations, and it should stay that way.** A proxy
   * that rewrites what the upstream said is a proxy whose output nobody can
   * check against the API's own documentation, and every transform is a place
   * for a field to go missing exactly as silently as KAN-183's dropped list
   * item. The four that have one cannot avoid it:
   *
   *  - `atlassian_search` has two responses and must return one thing.
   *  - `atlassian_get_accessible_resources` reads a bare `{cloudId}` and has to
   *    pair it with the site the daemon is configured against, which is not in
   *    any response body because it is not something Atlassian was asked.
   *  - `atlassian_get_issue_comments` (KAN-501) — WAS THE THIRD, and it was
   *    added against this paragraph rather than around it. The alternative was
   *    not "an untransformed response": it was **no response**, measured. A
   *    comment arrives as ADF, ADF is ~5x the size of the prose in it, and the
   *    response budget therefore replaced the entire body on every real ticket,
   *    down to `maxResults: 1`. The tool that exists for when a history matters
   *    could not return a history. Rendering is what makes a page fit.
   *
   *    **The three things this paragraph is afraid of are answered rather than
   *    waved past.** A reader who wants Atlassian's own object asks for
   *    `commentFormat: 'adf'` and gets it byte for byte. A field that went
   *    missing is named on the comment it went missing from —
   *    `bodyUnrenderedNodes` carries any ADF node type the renderer had no rule
   *    for, and an empty list there is the claim that every node was understood.
   *    And `via.reshapedByDaemon` already says a transform ran at all.
   *
   *  - `atlassian_search_issues` (KAN-522) — THE FOURTH, and it was argued on
   *    the terms this paragraph asked for rather than by pointing at the third.
   *    The alternative was again **no response**, measured: a raw Jira issue row
   *    costs ~2,600 characters on this operation's default fields and ~450 on
   *    `fields=summary`, so the budget replaced the whole `issues` array — 30
   *    issues found, none said — and `fields` is already at its narrowest useful
   *    value when it does. It answers the same three fears the same three ways;
   *    its own docblock is where.
   *
   *    A fifth one should be argued for on the same terms, not by pointing at
   *    either.
   *
   * `context` carries the non-secret facts about the credential — never the
   * credential. See {@link ProxyTransformContext}.
   *
   * `args` is what the caller sent, the same object {@link build} was given.
   * KAN-501 added it for the one operation whose reshaping is a caller's
   * choice: `atlassian_get_issue_comments` renders comment bodies to text by
   * default and to ADF on request, and `build` refuses any other value — so by
   * the time a transform reads it, the field is one of two strings or absent.
   * A transform that ignores it is unaffected, which is all but one of them.
   */
  transform?(bodies: unknown[], context: ProxyTransformContext, args: Record<string, any>): unknown;
}

/**
 * Who a write is permitted to touch, declared by the operation itself.
 *
 * KAN-291 wrote this as one optional method returning one issue key, which was
 * exactly right for the one write it had. KAN-293 adds eight more and three of
 * them cannot answer that question: a link touches **two** issues, a creation
 * touches an issue that **does not exist yet**, and a Confluence write touches
 * **no issue at all**. A single `string | null` would have had to answer `null`
 * for all three, and `null` already means "the arguments were unusable" — so
 * the widest writes in the table would have been indistinguishable from a typo,
 * and {@link refuseWriteOutsideCaller} would have waved them through.
 *
 * So the shape is a tagged union, and each tag carries the *reason* it is
 * permitted along with what it permits. `unscoped` is deliberately the
 * uncomfortable one to write: it demands a `justification` in the table, that
 * justification is rendered into the operator-facing report, and the type
 * system only accepts it on the top rung of the ladder.
 */
export type WriteScope =
  /** The caller's own ticket, and nothing else. KAN-291's policy, unchanged. */
  | { kind: 'own-ticket'; issue(args: Record<string, any>): string | null }
  /**
   * A write naming **two** issues, of which at least one must be the caller's
   * own ticket.
   *
   * This is `createIssueLink` and it is the one place KAN-291's policy needed
   * extending rather than applying, so the extension is written here rather
   * than inferred. A link is a single object with two endpoints: refusing
   * unless *both* are the caller's own ticket would refuse every link that has
   * ever been useful — including the one `prompts/task.md` instructs every
   * agent to create, `Relates` from a follow-up it just filed to its own ticket
   * — and permitting a link between two issues that are *both* somebody else's
   * is the thing worth refusing. "At least one end is mine" is the rule that
   * keeps the second and allows the first.
   *
   * What it concedes, said plainly: an agent can attach a link to somebody
   * else's ticket, provided the other end is its own. That is a visible,
   * attributable, reversible edit to a field designed to be edited, and it is
   * the smallest concession that leaves the tool able to do its job.
   */
  | { kind: 'own-ticket-endpoint'; issues(args: Record<string, any>): string[] }
  /**
   * A new issue in the caller's own project.
   *
   * The other case KAN-291's policy does not reach, for a reason that is not a
   * loophole: a created issue has no key to compare against the caller's, so
   * "your own ticket" is not a rule that can be evaluated. The nearest bound
   * that *can* be — and it is derived from the caller's identity in exactly the
   * way A's rule is, rather than invented alongside it — is the project the
   * caller's own ticket lives in. `task/KAN-293` files into `KAN` and nowhere
   * else.
   *
   * It bounds what it can: an agent cannot create issues in a project it has no
   * business in. It does not bound how *many*, and nothing here pretends to —
   * see {@link refuseWriteOutsideCaller}.
   */
  | { kind: 'own-project'; project(args: Record<string, any>): string | null }
  /**
   * Nothing about the caller bounds this write, and the table has to say why.
   *
   * Accepted **only** on the `confluence-write` rung — the type below is what
   * enforces that — because Confluence is the one product where no bound
   * derivable from a Jira key exists. The `justification` is not decoration: it
   * is carried into {@link AtlassianProxyReport} so an operator deciding
   * whether to enable that rung reads the reason next to the grant.
   */
  | { kind: 'unscoped'; justification: string };

/**
 * The write scopes that bound a write by the caller's own identity.
 *
 * Everything except `unscoped`, derived rather than re-listed so that a scope
 * added later is bounded-by-default and has to be *excluded* here to become
 * unbounded — the safe direction, and the one that survives somebody adding a
 * fifth kind without reading this paragraph.
 */
export type CallerBoundedScope = Exclude<WriteScope, { kind: 'unscoped' }>;

/**
 * One operation the proxy serves — a read or a write, and the type knows which.
 *
 * ## WHY THIS IS A UNION AND NOT AN INTERFACE WITH OPTIONAL FIELDS
 *
 * KAN-291 left the write policy resting on one optional member: `writesTo` was
 * present on the single write and absent on every read, and a write added
 * without one would have been unrestricted. That was guarded by a verify script
 * — a real guard, and the right one at the time — but a script is a thing that
 * runs *after* somebody has written the code, and `prompts/task.md` is explicit
 * about the order to prefer: **an assertion can be deleted by a later author
 * and the build still passes; an unrepresentable state cannot be introduced at
 * all.**
 *
 * Nine writes is where that stops being a stylistic preference. These four
 * states no longer compile:
 *
 *  1. **A write with no declared scope.** `writeScope` is required on the write
 *     half of the union, so the omission KAN-291's script had to hunt for is
 *     now a red squiggle under the operation that omitted it.
 *  2. **An unscoped write below the top rung.** The `jira-write` member accepts
 *     only {@link CallerBoundedScope}, so the sentence "every write in
 *     `jira-write` is bounded by the caller's own identity" is checked by
 *     `tsc` on every build rather than believed.
 *  3. **A read that claims a write scope**, or sits in a write mode.
 *  4. **A write with no `bodyShape`.** Required here, optional before. For a
 *     write the path alone does not say what the credential can do, so the
 *     enumeration a reviewer reads would have had a hole in it exactly where
 *     the risk is.
 *
 * The runtime checks all remain, and that ordering is deliberate: belt and
 * braces, in that order. What the type removes is the *class* of mistake, and
 * what the checks remain for is the day somebody widens the type.
 */
export type ProxyOperation =
  | (ProxyOperationBase & {
      mode: 'jira-read' | 'confluence-read';
      method: 'GET';
      bodyShape?: never;
      writeScope?: never;
    })
  | (ProxyOperationBase & {
      mode: 'jira-write';
      method: 'POST' | 'PUT';
      bodyShape: string;
      writeScope: CallerBoundedScope;
    })
  | (ProxyOperationBase & {
      mode: 'confluence-write';
      method: 'POST' | 'PUT';
      bodyShape: string;
      writeScope: WriteScope;
    });

/**
 * The non-secret facts a {@link ProxyOperation.transform} may use.
 *
 * Deliberately only these two. A transform that wanted the token would be
 * asking to put it in a response body, which is the one direction a credential
 * must never travel — *credentials stop at the daemon* is one of KAN-39's
 * invariants and this type is where that is enforced by shape rather than by
 * care.
 */
export interface ProxyTransformContext {
  /** The site the daemon's credential is configured against. */
  siteUrl?: string;
  /** The account email. Non-secret; the token half of Basic auth is not here. */
  email?: string;
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

/** How many rows one proxied Confluence or directory listing may ask for. */
export const PROXY_LIST_MAX_RESULTS = 50;

/**
 * How many comments one proxied page of an issue's history may ask for.
 *
 * 100 rather than {@link PROXY_LIST_MAX_RESULTS}'s 50 because this is the one
 * read whose *purpose* is to reach a history the issue endpoint cannot, and
 * 100 is what that endpoint itself returns — measured on KAN-39, 2026-08-15:
 * `maxResults: 100, total: 211`. Matching it means a caller pages a long
 * ticket in the same number of requests either surface would have taken, and
 * never has to wonder whether the proxy shortened the history further.
 */
export const PROXY_COMMENT_MAX_RESULTS = 100;

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

function numericId(
  args: Record<string, any>,
  field: string,
  what: string
): { id: string } | { error: string } {
  const raw =
    typeof args?.[field] === 'string' || typeof args?.[field] === 'number'
      ? String(args[field]).trim()
      : '';
  if (!raw) return { error: `${field} is required — the numeric id of ${what}.` };
  if (!ATLASSIAN_ID.test(raw)) {
    return {
      error:
        `"${raw.slice(0, 40)}" is not ${what} id. Expected digits, e.g. "163933". This proxy ` +
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

function projectKey(args: Record<string, any>): { key: string } | { error: string } {
  const raw = typeof args?.projectKey === 'string' ? args.projectKey.trim() : '';
  if (!raw) return { error: 'projectKey is required, e.g. "KAN".' };
  if (!PROJECT_KEY.test(raw)) {
    return {
      error:
        `"${raw.slice(0, 40)}" is not a Jira project key. Expected a letter followed by ` +
        'letters, digits or underscores, e.g. "KAN".'
    };
  }
  return { key: raw.toUpperCase() };
}

/**
 * The `fields` object `atlassian_create_issue` sends, with `assignee` required.
 *
 * ---------------------------------------------------------------------------
 * WHY A TYPE AND NOT AN ASSERTION (KAN-577)
 * ---------------------------------------------------------------------------
 *
 * This object was a `Record<string, unknown>` and the defect was a field that
 * was **not there**. That is the one shape a free-form record cannot notice:
 * every key is optional, so omitting the one that makes a ticket staffable
 * type-checks, reviews clean, reads as finished, and produces a ticket the
 * board reconciler can never see. 104 of them accumulated before anybody asked
 * why a filed ticket had not started.
 *
 * Declaring `assignee` required moves that from *a thing to remember* to *a
 * thing the compiler refuses*. An assertion would have been equally correct and
 * strictly weaker: a later author deleting the assignee line would delete the
 * assertion with it and the build would still pass. Here the deletion is a
 * compile error, which is the mutation `verify-create-issue-staffable.mjs`
 * drives to prove this paragraph is not decoration.
 *
 * `description` and `parent` stay optional because they genuinely are — a
 * ticket with no description is a ticket, and an epic has no parent.
 */
interface StaffableIssueFields {
  project: { key: string };
  issuetype: { name: string };
  summary: string;
  /** The daemon's own account. Never a caller's choice — see {@link ProxyBuildContext}. */
  assignee: { accountId: string };
  description?: unknown;
  parent?: { key: string };
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
function freeText(
  args: Record<string, any>,
  field: string,
  example: string,
  limit = 2000
): { value: string } | { error: string } {
  const raw = typeof args?.[field] === 'string' ? args[field].trim() : '';
  if (!raw) return { error: `${field} is required, e.g. ${example}` };
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

/**
 * Coercions recorded by every {@link markdownBody} call of the operation
 * currently being built, so the agent can be told what changed in its content.
 *
 * ## WHY A COLLECTOR RATHER THAN A RETURN VALUE (KAN-502)
 *
 * `markdownToAdf` has always returned `coercions`, and `markdownBody` has
 * always passed them back, and **every one of the eight call sites dropped
 * them on the floor**. Nothing consumed the field, so an agent whose heading
 * became a bold paragraph was never told — the converter's own header says the
 * list is *"returned rather than logged so that the caller can put it in front
 * of the agent"*, and for the whole life of the proxy the caller did not.
 *
 * That was not carelessness at any one site; it is what threading a value
 * through eight independent `build` functions produces. So the value is
 * collected here, at the one place every conversion passes through, and read
 * once in `router.ts` around the `build` call. An operation added tomorrow
 * gets this for free and cannot forget it, because there is nothing for its
 * author to remember.
 *
 * **`build` is synchronous** — `router.ts` calls it without `await` and it
 * returns a `BuildResult`, not a promise — so a reset immediately before and a
 * read immediately after cannot interleave with another request. That is the
 * same argument `adf.ts` makes for `pendingCoercions`, and it holds here for
 * the same reason.
 *
 * ⚠ **This is disclosure, not permission.** It exists so a content change is
 * *reported*; it is never a licence to make one silently that could have been
 * avoided. The distinction matters on this ticket in particular: the official
 * Atlassian server also rewrites a code span out of a bold run, returns 200,
 * and says nothing — measured twice on 2026-08-18, by `epic/KAN-39` on KAN-39's
 * own description and by `epic/KAN-203` on comment 12903. A fix that matched
 * that behaviour would have adopted the silence. What separates this from it is
 * exactly this list arriving with the response.
 */
let buildCoercions: string[] = [];

/** Start collecting for one `build` call. Called by `router.ts` immediately before it. */
export function beginBuildCoercions(): void {
  buildCoercions = [];
}

/** What that `build` call changed about the agent's content. Read immediately after. */
export function takeBuildCoercions(): string[] {
  const out = buildCoercions;
  buildCoercions = [];
  return out;
}

function markdownBody(
  args: Record<string, any>,
  field: string,
  what: string,
  target: AdfTarget,
  required = true
): { doc: AdfDoc; coercions: string[] } | { absent: true } | { error: string } {
  const raw = typeof args?.[field] === 'string' ? args[field] : '';
  if (!raw.trim()) {
    if (!required) return { absent: true };
    return {
      error:
        `${field} is required — ${what}, as Markdown. Butchr converts it to ADF itself rather ` +
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
    // Recorded for the agent here rather than at the eight call sites, none of
    // which ever read the value they were handed. See `buildCoercions`.
    for (const coercion of coercions) buildCoercions.push(`${field}: ${coercion}`);
    return { doc, coercions };
  } catch (err: any) {
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
function plainLine(
  args: Record<string, any>,
  field: string,
  what: string,
  limit = 255
): { value: string } | { error: string } {
  const raw = typeof args?.[field] === 'string' ? args[field].replace(/\s+/g, ' ').trim() : '';
  if (!raw) return { error: `${field} is required — ${what}.` };
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

function timeSpent(args: Record<string, any>): { value: string } | { error: string } {
  const raw = typeof args?.timeSpent === 'string' ? args.timeSpent.trim() : '';
  if (!raw) return { error: 'timeSpent is required, e.g. "3h" or "1d 4h".' };
  if (!TIME_SPENT.test(raw)) {
    return {
      error:
        `"${raw.slice(0, 40)}" is not a Jira time expression. Use w/d/h/m units, e.g. "3h", ` +
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

function typeName(
  args: Record<string, any>,
  field: string,
  what: string,
  example: string
): { value: string } | { error: string } {
  const raw = typeof args?.[field] === 'string' ? args[field].trim() : '';
  if (!raw) return { error: `${field} is required — ${what}, e.g. "${example}".` };
  if (!TYPE_NAME.test(raw)) {
    return {
      error:
        `"${raw.slice(0, 40)}" is not ${what}. Expected a name like "${example}" — letters, ` +
        `spaces and hyphens. Read the names this site actually has with ` +
        `${field === 'linkType' ? 'atlassian_get_issue_link_types' : 'atlassian_get_project_issue_types'}.`
    };
  }
  return { value: raw };
}

/** A bounded `limit`, clamped rather than refused. See `maxResults` on search. */
function listLimit(
  args: Record<string, any>,
  field = 'limit',
  cap: number = PROXY_LIST_MAX_RESULTS
): number {
  const asked = Number(args?.[field]);
  return Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), cap) : cap;
}

/**
 * A 0-based page offset, clamped to something a REST path can carry (KAN-471).
 *
 * Unlike {@link listLimit} there is no useful ceiling here — a caller walking a
 * long history legitimately asks for `startAt=200` — so the only job is to
 * refuse what would not be a number. **Anything unusable becomes 0**, which is
 * the first page: a mistyped offset shows the caller the beginning of the
 * history rather than an empty result they would read as "there is nothing
 * there". That direction is deliberate and is the same argument
 * {@link snapshotFrom} makes for defaulting toward the safe reading.
 */
function pageOffset(args: Record<string, any>, field = 'startAt'): number {
  const asked = Number(args?.[field]);
  return Number.isFinite(asked) && asked >= 1 ? Math.min(Math.floor(asked), 100_000) : 0;
}

/**
 * How a caller asked for comment bodies, or the reason that is not an answer
 * (KAN-501).
 *
 * REFUSED RATHER THAN DEFAULTED, unlike every other optional argument in this
 * file, and the difference is deliberate. `pageOffset` above defaults a
 * mistyped offset to the first page because both readings are the same *kind*
 * of answer — some comments, from somewhere in the history. Here the two values
 * differ in what the answer *is*: `'adf'` returns a node tree, `'text'` returns
 * prose. A caller that typed `'ADF'` and silently got text would be reading a
 * rendered body believing it held the structure it asked for, and nothing in
 * the response would say otherwise. That is this ticket's own defect wearing a
 * different field name, so it goes back as an error.
 *
 * Called from both {@link ProxyOperationBase.build} and the operation's
 * transform, which is why it is a function rather than a line: the value the
 * transform acts on has to be the value `build` agreed to.
 */
function commentBodyFormat(
  args: Record<string, any>
): { format: 'text' | 'adf' } | { error: string } {
  const raw = args?.commentFormat;
  if (raw === undefined || raw === null || raw === '') return { format: 'text' };
  if (raw === 'text' || raw === 'adf') return { format: raw };
  return {
    error:
      `commentFormat must be "text" or "adf"; got ${JSON.stringify(raw)}. ` +
      '"text" (the default) renders each comment to plain text, which is what makes a page ' +
      'of a real ticket fit inside the response budget. "adf" returns Atlassian\'s raw ' +
      'document, which on a long comment can exceed that budget on its own.'
  };
}

/**
 * How a search result may be said (KAN-522).
 *
 * Same shape and same reasoning as {@link commentBodyFormat} one function up,
 * and refused rather than defaulted for the same reason: `'condensed'` and
 * `'raw'` differ in what the answer *is*, so a caller that typed `'RAW'` and
 * silently got condensed rows would be reading identity strings believing it
 * held Jira's objects.
 */
function searchIssueFormat(
  args: Record<string, any>
): { format: 'condensed' | 'raw' } | { error: string } {
  const raw = args?.issueFormat;
  if (raw === undefined || raw === null || raw === '') return { format: 'condensed' };
  if (raw === 'condensed' || raw === 'raw') return { format: raw };
  return {
    error:
      `issueFormat must be "condensed" or "raw"; got ${JSON.stringify(raw)}. ` +
      '"condensed" (the default) keeps every issue and says less about each, which is what ' +
      'makes an agent-sized search fit inside the response budget. "raw" returns ' +
      "Atlassian's own objects, which on this endpoint cost roughly 2,600 characters an " +
      'issue — so a raw search is given up whole, every issue of it, from about the fourth.'
  };
}

/**
 * The keys {@link condenseIssueValue} strips, named here so the answer can name
 * them too.
 *
 * EVERY ONE OF THEM IS A HANDLE THIS PROXY CANNOT BE GIVEN BACK. `self` and
 * `iconUrl` and the four `avatarUrls` are absolute REST and CDN URLs, and this
 * proxy takes no path — an agent cannot fetch one, so carrying it is a false
 * affordance in the KAN-501 sense as well as ~500 characters an issue. `expand`
 * names Jira's expansion parameters, and this operation's `build` does not
 * accept one. `avatarId` and `entityId` are internal ids with no operation on
 * this server that takes them.
 *
 * NOTHING ELSE IS DROPPED. A key this list does not name survives condensing,
 * so the renderer's default is to keep — which is why there is no counterpart
 * to `bodyUnrenderedNodes` here. A shape it has no rule for comes back whole
 * rather than coming back short.
 */
export const SEARCH_CONDENSED_AWAY: readonly string[] = [
  'self',
  'expand',
  'iconUrl',
  'avatarUrls',
  'avatarId',
  'entityId'
];

/**
 * The keys that name a Jira reference object, in the order a reader wants them.
 *
 * `key` first because `KAN-39` identifies a parent better than its summary
 * does; `name` next for `status`, `issuetype`, `priority` and `resolution`;
 * `displayName` for a user; `value` for a custom field option.
 */
const IDENTITY_KEYS = ['key', 'name', 'displayName', 'value'] as const;

function isAdfDoc(value: Record<string, unknown>): boolean {
  return value.type === 'doc' && Array.isArray(value.content);
}

/**
 * One Jira field value, reduced to what a reader steers by (KAN-522).
 *
 * THREE RULES, AND THE THIRD IS THE SAFE DEFAULT:
 *
 *  1. **An ADF document renders to text**, exactly as a comment body does one
 *     operation over — `description` and `comment` are ADF, and ADF is roughly
 *     five times the size of the prose in it.
 *  2. **A reference object collapses to its identity.** Jira answers `status`,
 *     `issuetype`, `assignee`, `priority`, `parent`, `project` and `resolution`
 *     as objects carrying a `self` URL and half a kilobyte of icons; what a
 *     caller reads off them is one string. The `self` key is what marks the
 *     shape, so this fires on the reference objects Jira sends and not on a
 *     custom field that happens to have a `name`.
 *  3. **Anything else is walked, not dropped.** Arrays map, plain objects
 *     recurse with {@link SEARCH_CONDENSED_AWAY} removed, scalars pass through.
 *     `issuelinks` is the case that matters — no identity key at its top level,
 *     so it is walked, and comes back as `{ type: 'Relates', outwardIssue:
 *     'KAN-501' }`: the relation the merge-governance lookup reads, at 1/20th
 *     the characters.
 *
 * WHAT COLLAPSING COSTS, SAID PLAINLY: `status.statusCategory` goes with the
 * object it was nested in, as does a parent's summary and a user's account id.
 * `issueFormat: 'raw'` returns all of it byte for byte.
 */
function condenseIssueValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(condenseIssueValue);
  if (typeof value !== 'object' || value === null) return value;

  const obj = value as Record<string, unknown>;
  if (isAdfDoc(obj)) return adfToText(obj).text;

  if (typeof obj.self === 'string') {
    for (const identity of IDENTITY_KEYS) {
      const candidate = obj[identity];
      if (typeof candidate === 'string' && candidate.length > 0) return candidate;
    }
  }

  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(obj)) {
    if (SEARCH_CONDENSED_AWAY.includes(key)) continue;
    out[key] = condenseIssueValue(member);
  }
  return out;
}

/** One search hit: its key, and its requested fields condensed. */
export function condenseSearchIssue(issue: unknown): Record<string, unknown> {
  if (typeof issue !== 'object' || issue === null) return { key: null };
  const row = issue as Record<string, unknown>;
  const fields = row.fields;
  return {
    key: row.key ?? null,
    fields:
      typeof fields === 'object' && fields !== null && !Array.isArray(fields)
        ? (condenseIssueValue(fields) as Record<string, unknown>)
        : (fields ?? null)
  };
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

export function parseAri(
  raw: unknown
): { product: 'jira' | 'confluence'; type: 'issue' | 'page'; id: string } | { error: string } {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) {
    return {
      error:
        'id is required — an Atlassian Resource Identifier, e.g. ' +
        '"ari:cloud:jira:{cloudId}:issue/10301" or "ari:cloud:confluence:{cloudId}:page/163933".'
    };
  }
  const m = ARI.exec(value);
  if (!m) {
    return {
      error:
        `"${value.slice(0, 60)}" is not an ARI. Expected ari:cloud:{product}:{cloudId}:{type}/{id} ` +
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
    if (ATLASSIAN_ID.test(trimmed)) return { product: 'jira', type: 'issue', id: trimmed };
    if (JIRA_KEY.test(trimmed.toUpperCase())) {
      return { product: 'jira', type: 'issue', id: trimmed.toUpperCase() };
    }
    return {
      error:
        `"${trimmed.slice(0, 40)}" is not a Jira issue id or key. Expected digits (e.g. "10301") ` +
        'or a key (e.g. "KAN-292").'
    };
  }

  if (product === 'confluence' && type === 'page') {
    const trimmed = id.trim();
    if (ATLASSIAN_ID.test(trimmed)) return { product: 'confluence', type: 'page', id: trimmed };
    return { error: `"${trimmed.slice(0, 40)}" is not a Confluence page id. Expected digits.` };
  }

  return {
    error:
      `This proxy fetches a Jira issue or a Confluence page and nothing else, so ` +
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
export const PROXY_OPERATIONS: readonly ProxyOperation[] = [
  {
    tool: 'atlassian_get_issue',
    mode: 'jira-read',
    products: ['jira'],
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
    // KAN-471. THE ONE READ ON THIS TABLE THAT REACHES SOMETHING NO OTHER
    // SURFACE CAN.
    //
    // `atlassian_get_issue` above can ask for `fields=comment`, and when it
    // does it inherits Jira's cap on the comment field: measured on KAN-39,
    // 2026-08-15, that endpoint returned **100 of 211** comments and the JQL
    // route returned **20 of 211**. Both report the cap honestly — the
    // container carries `total`, `maxResults` and a non-zero `startAt` — but
    // neither takes a parameter that reaches past it, so the older comments
    // are not addressable through the issue endpoint at all.
    //
    // This operation is the paginated comment endpoint, which is a different
    // REST resource rather than a bigger `fields` request, and `startAt` is
    // what makes the whole history reachable one page at a time.
    //
    // WHY IT IS WORTH AN OPERATION: this fleet's decisions live in ticket
    // comments, and KAN-39 is the most-cited history in the project. Before
    // this entry, 111 of its 211 comments could not be read by any agent
    // through any surface — official MCP included, which has no
    // comment-listing tool at all. "I checked the epic and found nothing" was
    // therefore a claim about the newest 100 comments, and read like a claim
    // about the ticket.
    //
    // `orderBy=created` is pinned rather than left to Jira's default so that
    // `startAt` means the same thing on every page — a caller walking
    // `startAt` 0, 100, 200 must not have the ordering change underneath it.
    tool: 'atlassian_get_issue_comments',
    mode: 'jira-read',
    products: ['jira'],
    scope: 'read:jira-work',
    method: 'GET',
    pathShape: '/rest/api/3/issue/{issueKey}/comment?startAt={startAt}&maxResults={maxResults}&orderBy=created',
    description:
      "Read one page of a Jira issue's comments through the Butchr daemon's own credential, " +
      'oldest first. USE THIS RATHER THAN atlassian_get_issue WITH fields=comment WHEN THE ' +
      'HISTORY MATTERS: the issue endpoint caps the comment field and cannot page past it, ' +
      'so on a long ticket it returns the newest window and nothing reaches the rest. The ' +
      'response carries total, maxResults and startAt — read total before you treat a page ' +
      'as the whole history, and walk startAt until startAt + returned reaches it. A failure ' +
      'is loud, as above. COMMENT BODIES ARE RENDERED TO TEXT BY DEFAULT (KAN-501): ADF is ' +
      'roughly five times the size of the words in it, which put every real ticket over the ' +
      'response budget and returned no comment body at all. Pass commentFormat: "adf" for the ' +
      'raw document when you need its structure, and expect a page of one on a long ticket. ' +
      'A rendered body carries bodyUnrenderedNodes when the renderer met an ADF node type it ' +
      'has no rule for — an empty list there is the claim that every node was understood.',
    inputSchema: {
      type: 'object',
      properties: {
        issueKey: { type: 'string', description: 'The issue key, e.g. "KAN-39".' },
        startAt: {
          type: 'number',
          description:
            'Optional. The 0-based index of the first comment to return; defaults to 0. ' +
            'Page by adding the number returned, and stop when startAt + returned === total.'
        },
        maxResults: {
          type: 'number',
          description: `Optional. 1..${PROXY_COMMENT_MAX_RESULTS}; defaults to ${PROXY_COMMENT_MAX_RESULTS}.`
        },
        commentFormat: {
          type: 'string',
          enum: ['text', 'adf'],
          description:
            "Optional, default 'text'. 'text' renders each comment to Markdown-flavoured " +
            "plain text, which is what the words cost rather than what the node tree costs. " +
            "'adf' returns Atlassian's raw document — complete, and large enough that one " +
            'comment can exceed the response budget on its own. NOT THE SAME PARAMETER AS ' +
            "`bodyFormat` on the Confluence page read, which takes 'storage' or 'view': " +
            'they are named apart because their values are disjoint, and one name over two ' +
            'domains is a value that is valid on one tool and refused on the next.'
        }
      },
      required: ['issueKey']
    },
    build(args) {
      const key = issueKey(args);
      if ('error' in key) return key;
      // Refused here rather than defaulted in the transform. A typo'd
      // `bodyFormat: "txt"` that silently produced the default would be a
      // caller believing it asked for something it did not get — which is this
      // ticket's own defect, one field over: an instruction that appears to
      // have been honoured.
      const format = commentBodyFormat(args);
      if ('error' in format) return format;
      return {
        path:
          `/rest/api/3/issue/${encodeURIComponent(key.key)}/comment` +
          `?startAt=${pageOffset(args)}` +
          `&maxResults=${listLimit(args, 'maxResults', PROXY_COMMENT_MAX_RESULTS)}` +
          `&orderBy=created`
      };
    },
    /**
     * KAN-501. Render the comment bodies, and keep the envelope in front.
     *
     * THE DEFECT THIS ENDS. Jira serves a comment as ADF, and ADF is about five
     * times the size of the prose inside it — measured on this site 2026-08-18,
     * KAN-501's own oldest comment is 1,930 characters of text inside a
     * 10,682-character response, and KAN-39's is 15,397. The response budget is
     * 9,000, so `maxResults: 1` — the narrowest request this schema permits —
     * was over budget on every ticket whose history anybody would page. The
     * budget replaced the whole body object, which took `total`, `startAt` and
     * `maxResults` with it: `epic/KAN-203`, 2026-08-18, was told to walk
     * `startAt` until it reached a `total` the same answer had just deleted.
     *
     * So this does two things and they are separate. It renders — which is what
     * makes a page of comments fit at all. And it lifts the paging envelope to
     * the top of the object it returns, beside `comments` rather than inside
     * anything, so that the fields the description tells a caller to steer by
     * are the last thing a further clip could reach.
     *
     * WHAT IS GIVEN UP, SAID PLAINLY, because a transform is where a field goes
     * missing: the ADF node tree, and every comment property this does not
     * name. `bodyFormat: 'adf'` returns Jira's own object untouched, which is
     * the escape hatch for anybody who needs either.
     */
    transform(bodies, _context, args) {
      const raw = bodies[0];
      if (!raw || typeof raw !== 'object') return raw;
      const page = raw as Record<string, any>;
      const format = commentBodyFormat(args);
      // A refusal cannot reach here — `build` returned it — but the type says
      // it can, and reading the raw page is the right answer if it ever does.
      if ('error' in format || format.format === 'adf') return page;

      const comments = Array.isArray(page.comments) ? page.comments : [];
      return {
        // The envelope first and at the top level, for the reason in the
        // docblock. `??` rather than `||` so that a genuine `0` survives.
        total: page.total ?? null,
        startAt: page.startAt ?? null,
        maxResults: page.maxResults ?? null,
        returned: comments.length,
        commentFormat: 'text',
        comments: comments.map((c: any) => {
          const rendered = adfToText(c?.body);
          return {
            id: c?.id ?? null,
            author: c?.author?.displayName ?? null,
            created: c?.created ?? null,
            ...(c?.updated && c.updated !== c?.created ? { updated: c.updated } : {}),
            body: rendered.text,
            // Named on the comment it happened to, not only in a summary: a
            // reader who meets `[adf:expand]` in the prose must be able to see,
            // on that comment, that the renderer said so about it.
            ...(rendered.unrendered.length > 0
              ? { bodyUnrenderedNodes: rendered.unrendered }
              : {})
          };
        })
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
    description:
      "Run a JQL search through the Butchr daemon's own credential. ISSUE ROWS ARE " +
      'CONDENSED BY DEFAULT (KAN-522): every issue this search found is returned, said as ' +
      'its `key` and its requested `fields`, with Jira reference objects collapsed to the ' +
      'one string a reader steers by — `status` to "In Progress", `assignee` to a display ' +
      'name, `parent` to "KAN-39" — and absolute `self`/`iconUrl`/`avatarUrls` handles this ' +
      'proxy cannot be given back dropped. Pass issueFormat: "raw" for Atlassian\'s own ' +
      "objects. WHY: raw rows cost ~2,600 characters each on this endpoint's default " +
      'fields and ~450 on `fields=summary`, against a 9,000-character response budget — so ' +
      'a raw search of more than three issues was reduced to NONE of them, and the ceiling ' +
      'was undocumented and found by bisection. READ `found` AND `isLast` BEFORE ' +
      'TREATING A PAGE AS THE BOARD: this endpoint sends no `total` (`total: null` says so ' +
      'rather than claiming zero), `isLast: false` means the board holds more than this ' +
      'call returned, and the proxy takes no page token — narrow the JQL to see the rest. ' +
      '`found` is how many this search found and is fixed before the response budget runs, ' +
      'so `issues.length < found` is the one comparison that says the budget trimmed the ' +
      'list; `completeness.clipped` then says by how many. ' +
      `Bounded at ${PROXY_SEARCH_MAX_RESULTS} results — this is a proxy for agent-sized ` +
      'questions, not a bulk export. A failure is loud, as above.',
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
        },
        issueFormat: {
          type: 'string',
          enum: ['condensed', 'raw'],
          description:
            'Optional, default "condensed" — every issue, with less said about each. "raw" ' +
            "returns Atlassian's own issue objects, which are large enough that a search of " +
            'more than a few is given up whole by the response budget.'
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
      // Refused here rather than defaulted in the transform, exactly as
      // `commentFormat` is: the transform must act on the value `build` agreed
      // to, and a mistyped format that silently condensed would be read as raw.
      const format = searchIssueFormat(args);
      if ('error' in format) return format;

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
    },
    /**
     * THE FOURTH TRANSFORM ON THIS SERVER (KAN-522), argued on the same terms
     * the third was and not by pointing at it.
     *
     * THE ALTERNATIVE IS NOT AN UNTRANSFORMED RESPONSE. IT IS NO ISSUES,
     * MEASURED. Against the fleet daemon on 2026-08-18, `project = KAN ORDER BY
     * created DESC` with `fields=summary` and `maxResults=30` returned
     * `issues: { omitted: 'for-budget', total: 30, chars: 13615 }` — thirty
     * issues found, none of them said. On this operation's *default* fields the
     * arithmetic is worse: one issue measured ~2,600 characters, of which ~120
     * carry information, so the budget is spent before the fourth row. There is
     * no narrower `fields` than the one field a search is for, and the ceiling
     * was stated nowhere — `epic/KAN-203` found it by bisecting one call at a
     * time and then correctly declined to file a ticket, because a search of six
     * results is not evidence about a board of forty-seven. That is the standing
     * search-before-filing rule degrading, which is what makes this worth a
     * transform rather than a smaller `maxResults`.
     *
     * WHAT IT DOES IS THE `agents-summarise` RUNG, WHICH IS ALREADY THIS
     * REPOSITORY'S ANSWER TO THIS QUESTION: keep every entry, say less about
     * each. `CLIP_LADDER` has that rung above every section it can drop, for the
     * reason this operation needs it — dropping entries is what makes a count
     * wrong.
     *
     * THE THREE THINGS THE PARAGRAPH ON {@link ProxyOperationBase.transform} IS
     * AFRAID OF, ANSWERED:
     *
     *  - **Atlassian's own object** is one argument away: `issueFormat: 'raw'`
     *    returns the page byte for byte, and `build` refuses any third value.
     *  - **What went missing is named in the answer**, not only here:
     *    `condensedAway` carries {@link SEARCH_CONDENSED_AWAY} on every
     *    condensed response, and every one of those keys is an absolute URL or
     *    an internal id that no operation on this server accepts. A key that
     *    list does not name is kept — the renderer's default is to keep, so a
     *    shape it has no rule for comes back whole rather than short.
     *  - **`via.reshapedByDaemon`** says a transform ran at all.
     *
     * AND THE ENVELOPE IS LIFTED TO THE TOP, for the reason KAN-501 lifted the
     * comment one: `returned`, `total` and `isLast` are scalars beside `issues`
     * rather than inside it, and {@link fitGenericResponse} descends one level
     * and gives up objects and arrays while keeping scalars — so the three
     * fields that say whether this page is the board are the ones a further clip
     * cannot reach.
     *
     * `nextPageToken` IS DROPPED ON PURPOSE, and this is the one place that says
     * so. Jira sends one; `build` above accepts no page token and constructs its
     * own path, so there is no call on this server that takes it. It is ~200
     * characters of recipe that cannot be typed, which is KAN-501's defect in
     * field form rather than in a string. `isLast` is what survives, and it
     * answers the question the token was being read for.
     */
    transform(bodies, _context, args) {
      const raw = bodies[0];
      if (!raw || typeof raw !== 'object') return raw;
      const page = raw as Record<string, any>;
      const format = searchIssueFormat(args);
      // A refusal cannot reach here — `build` returned it — but the type says
      // it can, and returning the raw page is the right answer if it ever does.
      if ('error' in format || format.format === 'raw') return page;

      const issues = Array.isArray(page.issues) ? page.issues : [];
      return {
        // `??` rather than `||` so a genuine `0` survives. `total` is `null` on
        // this endpoint rather than absent: Jira's `/search/jql` does not send
        // one, and an absent field would read as "this search had no total to
        // report" — which is the same absence as "the clip took it".
        total: page.total ?? null,
        // `found` RATHER THAN `returned`, AND THE NAME IS THE POINT. It is how
        // many issues this search found, fixed here before the response budget
        // sees the answer — so `issues.length < found` is the whole check that
        // a further clip trimmed the list, in one comparison and without
        // reading anything else. That is `agentsTotal` versus `agents.length`
        // from KAN-423, which is this repository's proven shape for the
        // question; `returned` would have been a claim the clip could falsify.
        found: issues.length,
        isLast: page.isLast ?? null,
        issueFormat: 'condensed',
        condensedAway: SEARCH_CONDENSED_AWAY,
        issues: issues.map(condenseSearchIssue)
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
    description:
      'List the workflow transitions available on a Jira issue right now, through the Butchr ' +
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
      if ('error' in key) return key;
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
    description:
      'List the Jira issue link types on this site (Blocks, Relates, Duplicate, Clones) with ' +
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
    description:
      "Read the remote links on one Jira issue — links out to things that are not Jira issues, " +
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
      if ('error' in key) return key;
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
    description:
      'List the issue types you can create in one Jira project, with their ids and hierarchy ' +
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
      if ('error' in key) return key;
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
    description:
      'List the fields available when creating one issue type in one Jira project — which are ' +
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
      if ('error' in key) return key;
      const id = numericId(args, 'issueTypeId', 'a Jira issue type');
      if ('error' in id) return id;
      return {
        path:
          `/rest/api/3/issue/createmeta/${encodeURIComponent(key.key)}` +
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
    description:
      "List the Jira projects the daemon's credential can see, through that credential. NOTE " +
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
    description:
      'Find Atlassian account ids by name or email, through the Butchr daemon\'s own ' +
      'credential. An account id is what assignee and reporter fields want; a display name is ' +
      'not one. THIS READS THE USER DIRECTORY, which is a different scope from reading issues ' +
      `— see the proxy's scope enumeration. Bounded at ${PROXY_LIST_MAX_RESULTS} results. A ` +
      'failure is loud, as above.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A name or email fragment to search for, e.g. "ada" or "ada@example.com".'
        },
        limit: {
          type: 'number',
          description: `Optional. 1..${PROXY_LIST_MAX_RESULTS}; defaults to ${PROXY_LIST_MAX_RESULTS}.`
        }
      },
      required: ['query']
    },
    build(args) {
      const q = freeText(args, 'query', '"ada"', 200);
      if ('error' in q) return q;
      return {
        path:
          `/rest/api/3/user/search?query=${encodeURIComponent(q.value)}` +
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
    description:
      "List the Confluence spaces the daemon's credential can see, through that credential. " +
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
    description:
      'List the pages in one Confluence space, through the Butchr daemon\'s own credential. ' +
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
      if ('error' in id) return id;
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
    description:
      "Read one Confluence page through the Butchr daemon's own credential, body included. " +
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
      if ('error' in id) return id;
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
    description:
      'List everything beneath one Confluence page in the page tree, through the Butchr ' +
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
      if ('error' in id) return id;
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
    description:
      "Read the footer comments on one Confluence page — the ones at the bottom, not the ones " +
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
      if ('error' in id) return id;
      return {
        path:
          `/wiki/api/v2/pages/${encodeURIComponent(id.id)}/footer-comments?limit=${listLimit(args)}`
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
    description:
      'Read the inline comments on one Confluence page — the ones anchored to a selection of ' +
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
      if ('error' in id) return id;
      return {
        path:
          `/wiki/api/v2/pages/${encodeURIComponent(id.id)}/inline-comments?limit=${listLimit(args)}`
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
    description:
      'Read the replies to one Confluence footer comment, through the Butchr daemon\'s own ' +
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
      if ('error' in id) return id;
      return {
        path:
          `/wiki/api/v2/footer-comments/${encodeURIComponent(id.id)}/children` +
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
    description:
      "Run a CQL search against Confluence through the Butchr daemon's own credential — the " +
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
      if ('error' in cql) return cql;
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
    description:
      'Read the Atlassian account the Butchr daemon is authenticating as. THIS IS THE ' +
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
    description:
      'List the Atlassian sites the Butchr daemon can reach. THERE IS ALWAYS EXACTLY ONE, and ' +
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
      const cloudId = (bodies[0] as any)?.cloudId;
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
    description:
      'Fetch one Jira issue or one Confluence page by its ARI — the identifier that comes back ' +
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
          description:
            'The ARI, e.g. "ari:cloud:jira:{cloudId}:issue/10301" or ' +
            '"ari:cloud:confluence:{cloudId}:page/163933".'
        }
      },
      required: ['id']
    },
    build(args) {
      const ari = parseAri(args?.id);
      if ('error' in ari) return ari;
      if (ari.product === 'jira') {
        return {
          product: 'jira' as const,
          path:
            `/rest/api/3/issue/${encodeURIComponent(ari.id)}` +
            `?fields=${encodeURIComponent('status,summary,issuetype,assignee,parent,updated,issuelinks')}`
        };
      }
      return {
        product: 'confluence' as const,
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
    pathShape:
      '/rest/api/3/search/jql?jql=text~{query} + /wiki/rest/api/search?cql=text~{query}',
    description:
      'Search Jira and Confluence for a plain-text phrase through the Butchr daemon\'s own ' +
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
      if ('error' in q) return q;
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
            product: 'jira' as const,
            path:
              `/rest/api/3/search/jql?jql=${encodeURIComponent(jql)}` +
              `&fields=${encodeURIComponent('status,summary,issuetype,updated')}` +
              `&maxResults=${limit}`
          },
          {
            product: 'confluence' as const,
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
      const [jira, confluence] = bodies as any[];
      return {
        jira: { issues: jira?.issues ?? [] },
        confluence: { results: confluence?.results ?? [] },
        note:
          'Two independent product searches, not Rovo Search. Ranked within each product ' +
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
  // THAT ARITHMETIC IS KAN-293'S AND IS LEFT AS IT WAS. KAN-471 added a
  // twenty-second read (`atlassian_get_issue_comments`), so the table is 32
  // and the reads no longer match the official tool list one for one — by
  // design, because the official server has no comment-listing tool to match.
  // The number to trust is `PROXY_OPERATIONS.length`, never a figure in a
  // comment; the read-surface count is asserted in
  // `verify-atlassian-proxy-read-surface.mjs` and that is where it is kept
  // honest.
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
    description:
      "Comment on a Jira issue, using the Butchr daemon's own credential. YOU MAY ONLY " +
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
      if ('error' in key) return key;
      const body = markdownBody(args, 'bodyMarkdown', 'the comment text', 'jira');
      if ('error' in body) return body;
      if ('absent' in body) return { error: 'bodyMarkdown is required.' };
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
    description:
      "Log work against a Jira issue, using the Butchr daemon's own credential. YOU MAY ONLY " +
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
          description:
            'Optional ISO-8601 start time with milliseconds and a numeric offset, e.g. ' +
            '"2026-08-12T04:00:00.000+0000". Defaults to now.'
        }
      },
      required: ['issueKey', 'timeSpent']
    },
    build(args) {
      const key = issueKey(args);
      if ('error' in key) return key;
      const spent = timeSpent(args);
      if ('error' in spent) return spent;
      const comment = markdownBody(args, 'comment', 'a note about the work', 'jira', false);
      if ('error' in comment) return comment;

      // Jira's worklog `started` is one of its fussiest formats and it rejects
      // anything else with a 400 that does not say so. Matched here, and
      // omitted entirely when absent so Jira applies its own default.
      const startedRaw = typeof args?.started === 'string' ? args.started.trim() : '';
      if (startedRaw && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{4}$/.test(startedRaw)) {
        return {
          error:
            `"${startedRaw.slice(0, 40)}" is not a Jira worklog start time. Jira wants exactly ` +
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
    description:
      "Edit a Jira issue's summary, description, parent epic or labels, using the Butchr " +
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
          description:
            'Optional parent EPIC key. A Task cannot be a child of a Story — both sit at the ' +
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
      if ('error' in key) return key;

      const fields: Record<string, unknown> = {};

      if (args?.summary !== undefined && args.summary !== '') {
        const summary = plainLine(args, 'summary', 'the new issue summary');
        if ('error' in summary) return summary;
        fields.summary = summary.value;
      }

      const description = markdownBody(args, 'description', 'the new description', 'jira', false);
      if ('error' in description) return description;
      if (!('absent' in description)) fields.description = description.doc;

      if (args?.parent !== undefined && args.parent !== '') {
        const parent = issueKey({ issueKey: args.parent });
        if ('error' in parent) {
          return { error: `parent: ${parent.error}` };
        }
        fields.parent = { key: parent.key };
      }

      if (args?.labels !== undefined) {
        if (!Array.isArray(args.labels)) return { error: 'labels must be an array of strings.' };
        const labels = args.labels.map((label: any) => String(label).trim());
        const bad = labels.find((label: string) => !/^[A-Za-z0-9_.-]{1,255}$/.test(label));
        if (bad !== undefined) {
          return {
            error:
              `"${String(bad).slice(0, 40)}" is not a usable Jira label. Labels carry no spaces ` +
              '— letters, digits, underscore, dot and hyphen.'
          };
        }
        fields.labels = labels;
      }

      if (!Object.keys(fields).length) {
        return {
          error:
            'Nothing to edit. Give at least one of summary, description, parent or labels — ' +
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
    description:
      "Link two Jira issues, using the Butchr daemon's own credential. AT LEAST ONE END MUST " +
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
      if ('error' in type) return type;
      const inward = issueKey({ issueKey: args?.inwardIssue });
      if ('error' in inward) return { error: `inwardIssue: ${inward.error}` };
      const outward = issueKey({ issueKey: args?.outwardIssue });
      if ('error' in outward) return { error: `outwardIssue: ${outward.error}` };
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
    bodyShape:
      '{"fields":{"project":{"key":…},"issuetype":{"name":…},"summary":…,' +
      '"assignee":{"accountId":…},"description":{ADF}?,"parent":{"key":…}?}}',
    // KAN-577. `assignee` is not in `inputSchema` and never will be: it is the
    // daemon's own account id, from `ProxyBuildContext`, and a caller cannot
    // choose it. See `build` below for what happens when it cannot be resolved.
    needsSelfAccountId: true,
    description:
      "File a new Jira issue, using the Butchr daemon's own credential. YOU MAY ONLY CREATE " +
      "IN YOUR OWN PROJECT — the project is taken from your own ticket's key and a call " +
      'naming another project is refused. SET THE PARENT EPIC AT CREATION: an unparented ' +
      "ticket is invisible in its epic's org chart and names nobody as its approver. Read " +
      "your own ticket's parent with atlassian_get_issue and copy it; the parent is the EPIC " +
      'and never a Story, because Story and Task sit at the same hierarchy level and Jira ' +
      'refuses that write. The description is Markdown converted to ADF by Butchr. ' +
      'THE ASSIGNEE IS SET FOR YOU AND YOU CANNOT CHOOSE IT: every ticket filed here is ' +
      "assigned to the daemon's own Atlassian account, because the board reconciler starts " +
      'an agent only for a ticket that is `assignee = currentUser()` AND In Progress or In ' +
      'Review — so a ticket filed with an empty assignee can never be staffed, reads exactly ' +
      'like one nobody has triaged, and nothing surfaces the difference (KAN-577). If the ' +
      'daemon cannot establish which account it is, this call is REFUSED and nothing is ' +
      'filed, rather than filing a ticket that could never start. A failure is loud.',
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
    // `context` is DEFAULTED rather than required, and the default is the
    // refusing one. Every caller in `daemon/scripts` is JavaScript and passes
    // one argument, so a required parameter throws `Cannot read properties of
    // undefined` at them — which is what it did, reddening two proxy proofs
    // that had nothing to do with this change. That is KAN-493's finding
    // exactly: a seam gains a parameter, and the `.mjs` mirrors no compiler
    // checks fall off it. Defaulting to `{ selfAccountId: null }` makes a
    // one-argument call take the refusal branch below — fails closed, and
    // loudly, rather than throwing or filing an unassigned ticket.
    build(args, context = { selfAccountId: null }) {
      const project = projectKey(args);
      if ('error' in project) return project;
      const type = typeName(args, 'issueType', 'a Jira issue type', 'Task');
      if ('error' in type) return type;
      const summary = plainLine(args, 'summary', 'the issue summary');
      if ('error' in summary) return summary;
      const description = markdownBody(args, 'description', 'the issue description', 'jira', false);
      if ('error' in description) return description;

      // KAN-577, AND IT IS A REFUSAL RATHER THAN A DEFAULT ON PURPOSE.
      //
      // There is no assignee this could fall back to. `-1` means "the project's
      // default assignee", which is a configuration this fleet does not control
      // and which resolves to nobody on a project set to leave issues
      // unassigned; omitting the field is precisely the defect. Both fallbacks
      // file a ticket that looks filed and can never start, which is the state
      // that cost KAN-568 a night — so the only honest branch is to send
      // nothing and say why.
      if (!context.selfAccountId) {
        return {
          error:
            'Cannot file an issue: the daemon could not establish which Atlassian account it ' +
            'authenticates as, and every ticket filed here has to be assigned to that account ' +
            'to be staffable at all. Nothing was sent. `/rest/api/3/myself` is what was asked ' +
            'and it did not answer — check the credential with atlassian_get_user_info, which ' +
            'reads the same endpoint. Filing an unassigned ticket instead is what KAN-577 ' +
            'exists to stop: it would look filed, and the board reconciler could never see it.'
        };
      }

      // Typed, rather than `Record<string, unknown>`, so that `assignee` cannot
      // be dropped by a later edit without the build failing. This is the type
      // standing in for an assertion a later author could delete — the defect
      // being guarded is a field's ABSENCE, which is exactly the shape a
      // free-form record cannot notice (KAN-527's rule, KAN-577's instance).
      const fields: StaffableIssueFields = {
        project: { key: project.key },
        issuetype: { name: type.value },
        summary: summary.value,
        assignee: { accountId: context.selfAccountId }
      };
      if (!('absent' in description)) fields.description = description.doc;

      if (args?.parent !== undefined && args.parent !== '') {
        const parent = issueKey({ issueKey: args.parent });
        if ('error' in parent) return { error: `parent: ${parent.error}` };
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
    bodyShape:
      '{"spaceId":…,"status":"current","title":…,"parentId":…?,"body":{"representation":"atlas_doc_format","value":"{ADF}"}}',
    description:
      "Create a Confluence page, using the Butchr daemon's own credential. THIS IS NOT " +
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
      if ('error' in space) return space;
      const title = plainLine(args, 'title', 'the page title');
      if ('error' in title) return title;
      const body = markdownBody(args, 'bodyMarkdown', 'the page content', 'confluence');
      if ('error' in body) return body;
      if ('absent' in body) return { error: 'bodyMarkdown is required.' };

      let parentId: string | undefined;
      if (args?.parentId !== undefined && args.parentId !== '') {
        const parent = numericId(args, 'parentId', 'a Confluence page');
        if ('error' in parent) return parent;
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
      justification:
        'A Confluence page has no Jira issue key, so the caller\'s own ticket names no page ' +
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
    bodyShape:
      '{"id":…,"status":"current","title":…,"version":{"number":…},"body":{"representation":"atlas_doc_format","value":"{ADF}"}}',
    description:
      "Replace a Confluence page's content, using the Butchr daemon's own credential. NOT " +
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
          description:
            "The page's CURRENT version number, from atlassian_get_confluence_page. Butchr " +
            'sends the next one.'
        },
        versionMessage: { type: 'string', description: 'Optional note for the version history.' }
      },
      required: ['pageId', 'title', 'bodyMarkdown', 'version']
    },
    build(args) {
      const page = numericId(args, 'pageId', 'a Confluence page');
      if ('error' in page) return page;
      const title = plainLine(args, 'title', 'the page title');
      if ('error' in title) return title;
      const body = markdownBody(args, 'bodyMarkdown', 'the page content', 'confluence');
      if ('error' in body) return body;
      if ('absent' in body) return { error: 'bodyMarkdown is required.' };
      const current = numericId(args, 'version', "the page's current version");
      if ('error' in current) return current;

      let message: string | undefined;
      if (args?.versionMessage !== undefined && args.versionMessage !== '') {
        const note = plainLine(args, 'versionMessage', 'the version note');
        if ('error' in note) return note;
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
      justification:
        'As atlassian_create_confluence_page: no Jira key names a page. Additionally bounded ' +
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
    bodyShape:
      '{"pageId":…,"parentCommentId":…?,"body":{"representation":"atlas_doc_format","value":"{ADF}"}}',
    description:
      "Comment at the foot of a Confluence page, using the Butchr daemon's own credential. " +
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
      if ('error' in page) return page;
      const body = markdownBody(args, 'bodyMarkdown', 'the comment text', 'confluence');
      if ('error' in body) return body;
      if ('absent' in body) return { error: 'bodyMarkdown is required.' };

      let parent: string | undefined;
      if (args?.parentCommentId !== undefined && args.parentCommentId !== '') {
        const reply = numericId(args, 'parentCommentId', 'a Confluence comment');
        if ('error' in reply) return reply;
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
    bodyShape:
      '{"pageId":…,"body":{…},"inlineCommentProperties":{"textSelection":…,"textSelectionMatchCount":…,"textSelectionMatchIndex":…}}',
    description:
      "Comment on a specific passage of a Confluence page, using the Butchr daemon's own " +
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
          description:
            'Which occurrence of that passage, counting from 0, when it appears more than ' +
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
      if ('error' in page) return page;
      const body = markdownBody(args, 'bodyMarkdown', 'the comment text', 'confluence');
      if ('error' in body) return body;
      if ('absent' in body) return { error: 'bodyMarkdown is required.' };
      const selection = freeText(args, 'textSelection', '"the sentence you are commenting on"', 500);
      if ('error' in selection) return selection;

      const count = Number.isFinite(Number(args?.matchCount)) ? Math.max(1, Math.floor(Number(args.matchCount))) : 1;
      const index = Number.isFinite(Number(args?.matchIndex)) ? Math.max(0, Math.floor(Number(args.matchIndex))) : 0;
      if (index >= count) {
        return {
          error:
            `matchIndex ${index} is not inside matchCount ${count} — the index counts from 0, ` +
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
  return [...new Set(operationsFor(mode).flatMap((op) => scopesOf(op)))].sort();
}

/**
 * The scopes one operation needs, always as a list.
 *
 * The single normalisation point for {@link ProxyOperation.scope}'s two shapes,
 * so that "which scopes does this need" has exactly one answer everywhere — the
 * report, the enumeration and any check that reads either.
 */
export function scopesOf(op: ProxyOperation): string[] {
  return typeof op.scope === 'string' ? [op.scope] : [...op.scope];
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
  method: 'GET' | 'POST' | 'PUT';
  /** Which products this operation's paths reach. See {@link ProxyProduct}. */
  products: readonly ProxyProduct[];
  pathShape: string;
  /** Present exactly when the operation sends one. */
  bodyShape?: string;
  /** Always a list here, however the table spelled it. See {@link scopesOf}. */
  scope: string[];
  /**
   * Whether this operation is restricted to the caller's own ticket.
   *
   * **It stopped being "true for every write" in KAN-293, and that is the point
   * of reporting it.** Of the ten writes, **four** are own-ticket, one is
   * own-project, one needs only one endpoint to be the caller's, and four are
   * unscoped. A reader who inferred the answer from the method would now be
   * wrong six times out of ten, which is exactly why it was reported rather
   * than inferred in the first place.
   *
   * **The four numbers used to read "five … one … one … four", which sums to
   * eleven for a table of ten** — a doc-constant drift of exactly the class
   * `docs/doc-constant-drift.md` describes, sitting in a source docblock, which
   * that page's guard explicitly does not reach. Counted rather than corrected
   * by eye: `verify-task-agent-write-list.mjs` §1 derives all four figures from
   * the table below and fails if this sentence stops matching them.
   */
  ownTicketOnly: boolean;
  /**
   * What actually bounds this write, and — where nothing about the caller does
   * — the table's own justification for that (KAN-293).
   *
   * Absent on reads. The justification is surfaced rather than left in the
   * source because the operator deciding whether to enable a rung is the person
   * the argument was written for, and it is no use to them in a docblock.
   */
  writeScope?: { kind: WriteScope['kind']; justification?: string };
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

/**
 * A sentence stating what is known about the credential. **Every branch of
 * {@link proxyReport}'s summary must carry one**, and the type is what makes
 * that true rather than a comment asking politely.
 *
 * ⚠ THIS IS A TYPE RATHER THAN AN ASSERTION ON PURPOSE (KAN-441), and the
 * defect it closes was a *missing branch*. The credential warning used to live
 * only in the on-state arm, so while the proxy was `off` — the one state in
 * which the answer can still prevent something — the summary could not mention
 * the credential at all, and a report built with `configured: false` read
 * byte-identically to one built with `configured: true`. An assertion that
 * "the summary mentions the credential" can be deleted by a later author and
 * the build still passes; a required field of a branded type cannot. A branch
 * that omits it does not compile, and a plain string cannot be passed in its
 * place because nothing outside this module can produce the brand.
 */
declare const credentialSentenceBrand: unique symbol;
export type CredentialSentence = string & { readonly [credentialSentenceBrand]: true };

/**
 * ⚠ STATE IT WHILE OFF; WARN ONLY WHILE ON. The two states are not equally
 * urgent and the wording must not pretend they are.
 *
 * While the proxy is `off` **nothing is wrong**: no call is being made through
 * it, so a missing credential has not cost anything yet. Importing the
 * on-state's alarm into that branch would manufacture a fault where there is
 * none — which is its own version of an instrument that misdescribes the world.
 * While it is `on`, a missing credential means every call refuses, and the
 * alarm is the honest reading.
 *
 * ⚠ `configured` IS NOT `working`, in either branch. A token on this machine is
 * not a token Atlassian still accepts — the 2026-08-10 outage is the whole
 * reason {@link AtlassianProxyReport.credential} says so — and only a call
 * settles the second. The wording below claims presence and never acceptance.
 */
function credentialSentence(
  mode: ProxyMode,
  credential: { configured: boolean; siteUrl?: string; email?: string; storage?: string }
): CredentialSentence {
  const who =
    `${credential.email ?? 'the configured account'} @ ` +
    `${credential.siteUrl ?? 'the configured site'}`;

  if (mode === 'off') {
    return (
      credential.configured
        ? `A credential IS configured (${who}` +
          `${credential.storage ? `, stored in the ${credential.storage}` : ''}) — that is ` +
          'PRESENCE and not proof it works: nothing has called Atlassian with it, and only a ' +
          'call establishes that it is still accepted. It is what a flip would run on.'
        : 'NO credential is configured. Nothing is failing while the proxy is off — nothing is ' +
          'calling Atlassian through it — but a flip onto this state would produce a fleet ' +
          'whose every call refuses, so it is the thing to fix before turning it on.'
    ) as CredentialSentence;
  }

  return (credential.configured
    ? who
    : 'NO CONFIGURED CREDENTIAL — every call will refuse') as CredentialSentence;
}

export function proxyReport(
  decision: ProxyDecision,
  credential: { configured: boolean; siteUrl?: string; email?: string; storage?: string },
  now: () => Date = () => new Date()
): AtlassianProxyReport {
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

  // ⚠ BOTH ARMS MUST NAME THE CREDENTIAL, AND THE TYPE IS WHAT ENFORCES IT
  // (KAN-441). `credential` is a required field of a branded type here, so an
  // arm that drops the clause fails to compile rather than silently producing
  // the reassuring paragraph that this ticket exists to remove. Do not relax
  // this to `string`: that restores the exact hole, and an assertion in a
  // sibling script is the weaker guard the branding replaces.
  const summaryOf = (parts: {
    lead: string;
    credential: CredentialSentence;
    tail: string;
  }): string => parts.lead + parts.credential + parts.tail;

  const summary =
    decision.mode === 'off'
      ? summaryOf({
          lead:
            `The Atlassian proxy is OFF. ` +
            (decision.source === 'default' && decision.rawValue === null
              ? `${PROXY_ENV_VAR} is not set, which is the default.`
              : decision.fallbackReason
                ? decision.fallbackReason
                : `Turned off explicitly by ${PROXY_ENV_VAR}=${decision.rawValue}.`) +
            ' No agent can reach Atlassian through the daemon; every agent still has its own ' +
            'Atlassian MCP session and nothing about this is a degradation. ',
          credential: credentialSentence(decision.mode, credential),
          tail: ''
        })
      : summaryOf({
          lead:
            `The Atlassian proxy is serving ${operations.length - writes.length} read operation(s) ` +
            `and ${writes.length} write operation(s) ` +
            `(${operations.map((op) => op.tool).join(', ')}) against `,
          credential: credentialSentence(decision.mode, credential),
          tail: `, `
        }) +
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
        `credential holding ${scopesOf(op).join(' + ') || 'no scope at all'}, which a read-only token may not have.`
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
 * able to do most of the job it was added for — the brief every agent runs
 * under tells it to claim its ticket, move it to In Progress, and move it to
 * In Review, and all three of those are writes to its own key.
 *
 * ## IT DOES NOT COVER THE WHOLE BRIEF, AND THIS PARAGRAPH IS THE CORRECTION
 *
 * **This docblock claimed until KAN-515 that the brief's writes were own-ticket
 * and that "none of them writes to anybody else's". That was false, and it was
 * the load-bearing premise under three tickets.** `prompts/task.md` also tells
 * every task agent, on the merge path of every task it will ever do, to *"post
 * a short pointer comment on your approver's own ticket"* — a comment on an
 * issue the caller does not own, which this function refuses `not-your-ticket`.
 * The same brief contemplates two more: a comment on somebody else's ticket
 * where the poller cannot announce a merge, and a transition of a ticket that
 * is not the caller's.
 *
 * **The refusal is correct and is not the defect.** What was wrong was a
 * sentence in this file asserting a coverage that had never been measured, and
 * which read as settled precisely because it looked like it had been. Three
 * tickets inherited it — KAN-293 stated it correctly about the *tools*, KAN-421
 * measured the supervisor list off `prompts/story.md` and `prompts/epic.md`
 * only, and KAN-513 scoped itself to configuration on the strength of both.
 * Nobody was careless; the gap was between the tickets and no ticket owned it.
 *
 * **What follows from it is recorded once**, in `docs/atlassian-proxy.md` §4,
 * and is deliberately not restated here: a second copy is how it drifts, and
 * this file has just demonstrated what a drifted copy costs.
 * `daemon/scripts/verify-task-agent-write-list.mjs` re-derives the list from
 * this table and from `prompts/task.md` on every pull request, so the fourth
 * ticket in the chain inherits a measurement rather than a sentence.
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
): {
  error: string;
  reason:
    | 'unidentified-caller'
    | 'caller-has-no-ticket'
    | 'not-your-ticket'
    | 'not-your-project';
} | null {
  // Reads are not restricted by this rule, and the TYPE says which is which:
  // `writeScope` exists on the write half of `ProxyOperation` and nowhere else,
  // so a write that reaches this function without one does not compile.
  if (!op.writeScope) return null;
  const scope = op.writeScope;

  // KAN-293: an unattributable write is refused whatever its scope, INCLUDING
  // the unscoped ones. That is not ceremony. `unscoped` means the caller's
  // identity does not *narrow* the write; it does not mean the write may be
  // anonymous. The audit line is the only remaining bound on a Confluence
  // write, and an audit line naming nobody bounds nothing at all.
  if (!caller || !caller.type || !caller.key) {
    return {
      reason: 'unidentified-caller',
      error:
        `${op.tool} is refused because this call did not say which workspace it came from, ` +
        'and every write through this proxy must be attributable. Nothing was sent to ' +
        'Atlassian. This is a bug in whatever made the call rather than something to work ' +
        'around: an unattributable write is exactly the one this proxy will not make.'
    };
  }

  if (scope.kind === 'unscoped') return null;

  // Every remaining scope is derived from the caller's own Jira key, so a
  // caller without one fails closed. See the docblock: a `confluence` workspace
  // keyed by a page id is the ordinary case here, not a corner one.
  if (!JIRA_KEY.test(caller.key.toUpperCase())) {
    return {
      reason: 'caller-has-no-ticket',
      error:
        `${op.tool} is refused: this is the "${caller.type}" workspace ${caller.key}, whose key ` +
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
    if (!target) return null;
    if (target !== mine) {
      return {
        reason: 'not-your-ticket',
        error:
          `${op.tool} is refused: ${caller.type}/${caller.key} asked to write to ${target}, and ` +
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
    if (targets.length < 2) return null;
    if (!targets.includes(mine)) {
      return {
        reason: 'not-your-ticket',
        error:
          `${op.tool} is refused: ${caller.type}/${caller.key} asked to link ${targets.join(' to ')}, ` +
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
  if (!target) return null;
  const myProject = mine.split('-')[0];
  if (target.toUpperCase() !== myProject) {
    return {
      reason: 'not-your-project',
      error:
        `${op.tool} is refused: ${caller.type}/${caller.key} asked to create an issue in ` +
        `project ${target}, and its own ticket lives in ${myProject}. The Butchr proxy permits ` +
        "creation only in the caller's own project. Nothing was sent to Atlassian and no " +
        `issue was created. Use this agent's own Atlassian MCP tools if you genuinely need to ` +
        `file into ${target}.`
    };
  }
  return null;
}
