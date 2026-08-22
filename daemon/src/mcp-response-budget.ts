/**
 * KAN-423: an MCP tool answer is bounded before it is sent, and says so.
 *
 * THE DEFECT THIS EXISTS TO END. `butchr_list_agents` serialised the whole
 * fleet census and handed it to the client, which cut it to fit and handed the
 * model what was left. Measured on this machine on 2026-08-15 against a
 * seven-agent fleet: the response was **44,557 characters** and the calling
 * client (claude-code 2.1.232, no `MAX_MCP_OUTPUT_TOKENS` override) delivered
 * **10,000** of them — head and tail kept, 34,557 characters elided from the
 * middle. `44557 - 34557 = 10000` exactly, on the second of two paired runs
 * where the payload was measured over the daemon socket in the same moment.
 *
 * **The bytes that went missing were the middle of the `agents` array.** Four
 * rows arrived whole, the fifth stopped inside a string, and rows six and seven
 * did not arrive at all. Nothing in what arrived said how many there were, so a
 * reader that counted got 5 for a fleet of 7 — and 5 is a perfectly well-formed
 * answer. That is the whole ticket: **a short list and a clipped list were the
 * same bytes**, and every conclusion drawn from the short one falls the same
 * way — *nothing else is running, nobody holds that file, that key is free.*
 *
 * WHY THE FIX IS HERE AND NOT IN THE CLIENT. The cap belongs to the client and
 * we do not control it; what we control is how much we hand it. So the answer
 * is fitted to a declared budget **before it is serialised out**, and what the
 * fitting removed is named in the answer itself. The daemon's own socket API is
 * untouched — the extension's board page reads it with no such cap, and this is
 * about how the list is reported rather than how the census is built.
 *
 * WHY A DISCRIMINATED UNION AND NOT A FLAG. `epic/KAN-39` measured that Jira's
 * `hasNextPage` reads `false` in **both** the complete and the truncated case,
 * with only `remainingCount`'s presence telling them apart — so "do what JQL
 * does" is the right shape and the wrong exemplar. A boolean that is falsy in
 * both cases is the defect wearing a field name. Here the two answers are
 * different *shapes*: `kind: 'complete'` has no `clipped` key at all, and
 * `kind: 'clipped'` carries a **non-empty tuple** of what went, so a clipped
 * verdict that names nothing is not constructible rather than merely
 * discouraged. Preferring the type to the assertion, per the standing rule: an
 * assertion can be deleted by a later author and the build still passes.
 */

/**
 * What the calling client actually delivered, measured rather than assumed.
 *
 * Quoted as a measurement of one client on one day, never as a constant to
 * design against — the next client has a different one and this number cannot
 * see it. It is here to justify the default below and for no other purpose.
 */
export const MEASURED_CLIENT_CAP_CHARS = 10_000;

/**
 * What we will actually emit.
 *
 * Below the measured cap rather than equal to it, because the number we are
 * hiding from is somebody else's and may move down as easily as up. The
 * headroom is the point: a budget set *at* an observed cap is a budget that
 * fails the first time the observation is wrong.
 */
export const DEFAULT_BUDGET_CHARS = 9_000;

/** Env override, so an operator on a roomier client is not stuck at ours. */
export function budgetFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.BUTCHR_MCP_RESPONSE_BUDGET_CHARS;
  if (!raw) return DEFAULT_BUDGET_CHARS;
  const n = Number(raw);
  // A malformed override falls back rather than throwing: an unparseable
  // number in the environment must not be able to take the tool off the air.
  return Number.isFinite(n) && n >= MIN_BUDGET_CHARS ? Math.floor(n) : DEFAULT_BUDGET_CHARS;
}

/**
 * The floor. Below this the minimal answer itself does not fit, so an override
 * under it is refused rather than honoured — a budget that cannot carry the
 * disclosure would produce exactly the silent short answer this file exists to
 * prevent.
 */
export const MIN_BUDGET_CHARS = 1_000;

/** How one field was reduced, in the answer that reduced it. */
export type ClipRecord = {
  /** The top-level field this happened to. */
  readonly field: string;
  /**
   * What was done to it. Three different things, kept apart because they lose
   * different information: a summarised row still names its agent, an omitted
   * entry does not, and an omitted section took everything with it.
   */
  readonly reduction:
    | 'rows-summarised'
    | 'rows-addressed'
    | 'entries-omitted'
    | 'section-omitted'
    /**
     * KAN-501. A field kept, with its large members given up and its small ones
     * left where they were. The rung that exists because the paging envelope
     * was collateral: `atlassian_get_issue_comments` put `total`, `startAt` and
     * `maxResults` inside the one object `section-omitted` replaced, so a
     * caller was told to page by a number the same answer had just deleted.
     */
    | 'members-omitted'
    /**
     * KAN-525. NOTHING WENT, AND THE ANSWER IS STILL OVER BUDGET — the one
     * record that reports a reduction that could not happen. It exists because
     * the alternative is worse than useless: before this, an answer whose
     * irreducible fields alone exceeded the budget came back with
     * `kind: 'complete'` and the sentence *"WHOLE: every field is present and
     * every list entire"* on it, and the client then cut the middle out of it.
     * That is KAN-423's own defect rebuilt inside the fix for it — measured at
     * 73,312 characters against a 9,000 budget on a census carrying 300
     * `missingAgents`, verdict `complete`.
     *
     * The field named is the largest one left, so a reader knows where the
     * budget went. `returned`, `total` and `omitted` are all `null` because
     * nothing was dropped HERE — what this record says is that the answer as
     * sent is larger than the budget, so whether it arrives whole is now the
     * client's business rather than ours.
     */
    | 'irreducible';
  /** How many entries came back. `null` where the field is not a list. */
  readonly returned: number | null;
  /** How many exist. `null` where the field is not a list. */
  readonly total: number | null;
  /** How many did not come back. `null` where the field is not a list. */
  readonly omitted: number | null;
  /** The exact call that returns this field unreduced. */
  readonly readTheRest: string;
  /**
   * KAN-525. Present only on a field that is ON the exempt list and lost its
   * exemption because it outgrew the ceiling declared for it in
   * `NEVER_CLIPPED_FIELDS`.
   *
   * SAID IN THE ANSWER RATHER THAN ONLY IN A LOG, because the reader's question
   * is not "was this clipped" — the record above already says that — but "why
   * was a field that is documented as never clipped clipped anyway?" Without
   * this, the honest reduction looks like a bug in the exemption.
   */
  readonly exemptionRevoked?: {
    readonly declaredMaxChars: number;
    readonly measuredChars: number;
  };
};

/**
 * Whether this answer is the whole answer.
 *
 * The two arms are different shapes rather than one shape with a flag in it —
 * see the header. `clipped` is a non-empty tuple: TypeScript will not let you
 * build a clipped verdict that names nothing.
 */
export type Completeness =
  | {
      readonly kind: 'complete';
      readonly chars: number;
      readonly budgetChars: number;
      readonly detail: string;
    }
  | {
      readonly kind: 'clipped';
      readonly chars: number;
      readonly budgetChars: number;
      /** What the unreduced answer would have measured. */
      readonly unclippedChars: number;
      readonly clipped: readonly [ClipRecord, ...ClipRecord[]];
      readonly detail: string;
    };

/** What a caller may ask for. */
export type FitOptions = {
  readonly budgetChars?: number;
  /** `'full'` is every field; `'summary'` is counts and identities only. */
  readonly view?: 'full' | 'summary';
  /** Return exactly one top-level section, unreduced if it fits. */
  readonly section?: string | null;
  /** Where the `agents` window starts. Lets a caller walk a long fleet. */
  readonly offset?: number;
  /** The tool this is an answer from, for the `readTheRest` recipes. */
  readonly tool?: string;
};

export type Fitted = {
  /** The object to serialise, with `completeness` first. */
  readonly payload: Record<string, unknown>;
  /** That object, serialised exactly as the caller will receive it. */
  readonly text: string;
  readonly completeness: Completeness;
};

/** One rung of the ladder. */
export type LadderStep =
  /** Replace a whole top-level field with a stub naming how to fetch it. */
  | { readonly kind: 'section'; readonly field: string }
  /** Keep every agent, say less about each. */
  | { readonly kind: 'agents-summarise' }
  /** Keep every agent, as `type/key` and nothing else. */
  | { readonly kind: 'agents-addresses' };

/**
 * The order things are given up in, least load-bearing first.
 *
 * DECLARED RATHER THAN DERIVED, and the order is the design. Giving up the
 * largest field first would be simpler and would give up `agents` — the field
 * the tool exists to answer — before `staleness`, which has a tool of its own.
 * What governs the order is how much of *the question this tool answers* each
 * rung costs.
 *
 * WHY `agents-summarise` SITS IN THE MIDDLE RATHER THAN AFTER EVERY SECTION.
 * The first draft put both `agents` rungs last, on the reasoning that the fleet
 * matters most. Run against the real eight-agent census it gave up **all
 * eleven** diagnostic sections and then had to summarise the rows anyway —
 * because eight full rows are ~8.6k characters on their own, and roughly 40% of
 * each is one `channel.detail` sentence. So the ordering was spending
 * `undeliveredNotifications` — which answers *who was never told* — to buy
 * prose about agents that were all still listed either way. Summarising a row
 * costs detail about an agent; dropping an absence field costs the whole
 * question. The cheap rung goes first.
 *
 * `capacity` and `undeliveredNotifications` are last of the sections for the
 * same reason: they answer questions about absence, and an absence field that
 * quietly went missing is this ticket's own defect one field over.
 */
export const CLIP_LADDER: readonly LadderStep[] = [
  { kind: 'section', field: 'reclaim' },
  { kind: 'section', field: 'herdrHealth' },
  { kind: 'section', field: 'staleness' },
  { kind: 'section', field: 'priorities' },
  { kind: 'section', field: 'standbyAgents' },
  { kind: 'section', field: 'unbackedPanes' },
  { kind: 'agents-summarise' },
  { kind: 'section', field: 'prWatch' },
  { kind: 'section', field: 'channelLiveness' },
  { kind: 'section', field: 'guardian' },
  { kind: 'section', field: 'boardControl' },
  { kind: 'section', field: 'capacity' },
  { kind: 'section', field: 'undeliveredNotifications' },
  { kind: 'agents-addresses' }
];

/** The sections the ladder may give up, in ladder order. */
export const SECTION_CLIP_ORDER: readonly string[] = CLIP_LADDER.flatMap((s) =>
  s.kind === 'section' ? [s.field] : []
);

/**
 * WHY A NAME IS EXEMPT — and what the exemption obliges the field to stay.
 *
 * KAN-525. THE LIST BELOW USED TO BE FIFTEEN BARE STRINGS, AND THAT WAS THE
 * DEFECT. The exemption matches on a field's NAME and is honoured at every rung
 * of both fitters, so an exempt field is irreducible everywhere — while what
 * made that safe was the SHAPE of the values those names happened to carry, and
 * nothing connected the two. A tool answering `available: [...]` as a list, or
 * an existing exempt name growing a collection, would have been un-clippable at
 * every rung with nothing able to say so.
 *
 * It was not hypothetical. Two instances were measured on `origin/main`'s build
 * while writing this, both of them live:
 *
 *   * `via` on an `atlassian_search` envelope is **5,335 characters**, because
 *     `via.path` is the audit path and the audit path carries the caller's own
 *     query — `freeText` accepts 2,000 characters and `encodeURIComponent`
 *     expands them. At the default budget that irreducible field forced `body`,
 *     the entire answer, to be given up in order to echo the caller's own
 *     question back at it. At `MIN_BUDGET_CHARS` the answer came to 6,330
 *     characters against 1,000 with no lever left at all.
 *   * `censusUnreadableRecords` measures **~730 characters per entry** on this
 *     machine today (one entry, read 2026-08-18). Thirteen of them exceed the
 *     whole budget on their own; three hundred `missingAgents` produced a
 *     **73,312**-character answer whose verdict read `kind: 'complete'`.
 *
 * SO THE INVARIANT IS THIS, AND IT IS DELIBERATELY NOT "AN EXEMPT FIELD IS
 * NEVER A LIST" — three of them are lists on purpose:
 *
 *   **No exempt field may be unbounded.** A `bounded` one is capped by
 *   declaration, and demoted to an ordinary clip candidate when it exceeds its
 *   cap. A `disclosure` one is capped by WINDOWING rather than by omission —
 *   it may lose entries, never the count, because the count is the whole of
 *   what makes it exempt.
 *
 * The two buckets are two different reasons that were sharing one name:
 *
 *   `bounded`     — small at every site that produces it, and losing it would
 *                   cost the reader the verdict while saving a few dozen
 *                   characters. `maxChars` is what "small" was measured to
 *                   mean, with headroom, and it is an obligation rather than a
 *                   description: over it, the exemption does not apply.
 *   `disclosure`  — answers "is the list above whole?", which is the question
 *                   this whole module exists to protect. Omitting it to make
 *                   room for the thing it qualifies would be the defect rebuilt
 *                   with extra steps, so it is never omitted — but a list that
 *                   can grow without limit is not protecting that question, it
 *                   is destroying the answer it sits on, so it is windowed.
 *
 * WHAT NO STATIC CHECK CAN DO, NAMED HERE RATHER THAN LEFT TO BE INFERRED: a
 * ceiling is per field, and nothing here knows which exempt fields CO-OCCUR on
 * a given answer. A set of fields each individually inside its ceiling can
 * still exhaust the budget together. That case is not prevented — it is made
 * LOUD, by `reduction: 'irreducible'` above: an answer that is still over
 * budget after every lever never comes back saying it is whole.
 */
export type ExemptionReason =
  | {
      readonly kind: 'bounded';
      /**
       * The declared ceiling, in characters of `JSON.stringify(value, null, 2)`.
       *
       * MEASURED AND THEN GIVEN HEADROOM, never guessed: each entry's `why`
       * names the value it was derived from. It is not a budget to spend — it
       * is the size past which this field stops looking like the scalar it was
       * exempted for being.
       */
      readonly maxChars: number;
      readonly why: string;
    }
  | {
      readonly kind: 'disclosure';
      /**
       * `'never-reduced'` — not a list, and left exactly as it is at any
       * budget. `completeness` itself is the case: it is the answer about the
       * answer, and it is bounded by the number of fields there are to clip.
       * `'windowed'` — a list that may lose entries from the end, keeping
       * `total` and `omitted`, so it can always still answer its own question.
       */
      readonly whenOverBudget: 'never-reduced' | 'windowed';
      readonly why: string;
    };

/** Every exempt name, with the reason it is exempt and what that costs it. */
export const NEVER_CLIPPED_FIELDS: Readonly<Record<string, ExemptionReason>> = {
  action: {
    kind: 'bounded',
    maxChars: 128,
    why: 'the envelope name. Measured 22 chars (`list_agents_response`); the longest in this daemon is `launchdarkly_proxy_call_response` at 34.'
  },
  success: {
    kind: 'bounded',
    maxChars: 32,
    why: 'the envelope verdict, a boolean. A reduced answer must not be able to lose whether it is an answer at all.'
  },
  completeness: {
    kind: 'disclosure',
    whenOverBudget: 'never-reduced',
    why: 'the answer about the answer. Clipping it is the only reduction that could not be reported, because it is what does the reporting.'
  },
  agentsTotal: {
    kind: 'bounded',
    maxChars: 32,
    why: 'a count. `agents.length < agentsTotal` is the whole short-list check, and it holds whoever did the clipping.'
  },
  censusScope: {
    kind: 'bounded',
    maxChars: 768,
    why: 'the population every count on this answer covers (KAN-630) — host, runtime, workspaces root and the sentence that completes them. Measured 471 chars on this machine. IT MUST OUTLIVE A CLIP FOR THE SAME REASON `agentsTotal` MUST: a reduced answer that keeps the counts and drops what they are counts OF is exactly the fleet-shaped box answer this field exists to make unavailable, and it would be produced by the fitter rather than by the daemon.'
  },
  standbyTotal: {
    kind: 'bounded',
    maxChars: 32,
    why: 'a count, for the same reason as `agentsTotal` one field over.'
  },
  censusUnreadableRecordsTotal: {
    kind: 'bounded',
    maxChars: 32,
    why: 'a count, and `null` is not zero here — it means no disclosure reached this daemon at all, which is exactly the distinction a clip would delete.'
  },
  censusUnreadableRecords: {
    kind: 'disclosure',
    whenOverBudget: 'windowed',
    why: 'names the registry rows the census could not read, so it says how the list above is short. Measured ~730 chars PER ENTRY on 2026-08-18, so 13 of them exceed the budget alone — windowed rather than omitted, and never the reverse.'
  },
  missingAgents: {
    kind: 'disclosure',
    whenOverBudget: 'windowed',
    why: 'agents the durable registry records active that herdr has no agent by that NAME for — which is not the same as work that has stopped, and each row now carries the difference in `occupiedBy` (KAN-579). 300 of them measured 69,302 chars, which is why this is windowed rather than exempt outright; `occupiedBy` is null on the overwhelming majority of rows and adds nothing to that figure where it is.'
  },
  preemptedAgents: {
    kind: 'disclosure',
    whenOverBudget: 'windowed',
    why: 'agents stood down to free capacity, listed until they are put back. Bounded in practice by the fleet size, and windowed for the same reason as its two neighbours.'
  },
  // KAN-501, and these are here BY DECISION rather than by luck. `task/KAN-420`
  // observed that `butchr_atlassian_proxy_status` keeps `outcome` and `mode`
  // through a clip only because they are small and this function drops
  // largest-first — "the tool is degraded, not blind" — and asked that whoever
  // fixed the clip keep that property deliberately. It is the field an operator
  // is *instructed* to read to confirm a rung, so a future field ordering that
  // happened to reach it would silence the one answer that check depends on.
  outcome: {
    kind: 'bounded',
    maxChars: 64,
    why: "an enum union. Measured 9 chars (`serving`); the longest arm is `unreachable` at 13. It is the field an operator is instructed to read instead of counting their tool list."
  },
  mode: {
    kind: 'bounded',
    maxChars: 64,
    why: 'an enum union. Measured 18 chars (`confluence-write`), which is the longest arm there is.'
  },
  available: {
    kind: 'bounded',
    maxChars: 32,
    why: "a boolean: the daemon answered but has no service at all, which is a third thing from `off` and `unreachable`. THE FIELD THIS TICKET'S OWN EXAMPLE WAS ABOUT — `available: [...]` as a list is what the ceiling refuses."
  },
  whatAnEmptyToolListMeans: {
    kind: 'bounded',
    maxChars: 256,
    why: 'one prose constant, measured 68 chars. Stated rather than left to be inferred from an empty list, because inferring it from an empty list is the defect.'
  },
  // The proxy envelope's own verdict, for the same reason one field over: a
  // reduced answer must not be able to lose the status it is an answer with.
  status: {
    kind: 'bounded',
    maxChars: 64,
    why: 'the upstream HTTP status a proxied call came back with — a number, or a short string.'
  },
  via: {
    kind: 'bounded',
    maxChars: 384,
    why: 'what actually happened: tool, method, path, products, servedBy. NOT the four scalars it was taken for — `path` is the audit path and carries the CALLER\'S OWN QUERY, so an `atlassian_search` with a 2,000-character CQL measured this field at 5,335 chars. An ordinary call is ~200.'
  }
};

/**
 * Fields that are never given up, at any budget — BY NAME.
 *
 * DERIVED RATHER THAN DECLARED A SECOND TIME. A hand-kept list beside the
 * registry is a list that drifts from it, and a name in one but not the other
 * is either an exemption with no stated reason or a stated reason that exempts
 * nothing. Both read as working.
 */
export const NEVER_CLIPPED: readonly string[] = Object.keys(NEVER_CLIPPED_FIELDS);

/** The exempt lists that may lose entries rather than be omitted whole. */
export const DISCLOSURE_WINDOWED_FIELDS: readonly string[] = Object.entries(NEVER_CLIPPED_FIELDS)
  .filter(([, reason]) => reason.kind === 'disclosure' && reason.whenOverBudget === 'windowed')
  .map(([field]) => field);

/**
 * Whether this field's exemption applies to THIS value.
 *
 * ASKED OF THE VALUE AND NOT ONLY OF THE NAME, which is the whole of KAN-525.
 * `NEVER_CLIPPED.includes(field)` — the three guards this replaces — answered a
 * question about the list; this answers the question the guards were there to
 * ask, which is whether giving this field up is a loss the reader cannot afford
 * or a lever the fitter cannot reach.
 *
 * A `disclosure` field always holds: it is never omitted, and the windowing
 * pass is what keeps it from being unbounded. A `bounded` field holds only
 * while it is inside the ceiling declared for it.
 */
export function exemptionHolds(field: string, value: unknown): boolean {
  const reason = NEVER_CLIPPED_FIELDS[field];
  if (!reason) return false;
  if (reason.kind === 'disclosure') return true;
  return sizeOf(value) <= reason.maxChars;
}

/**
 * What to say on the clip record of a field that lost its exemption, or
 * `undefined` where nothing was revoked because nothing was exempt.
 */
function revocationOf(field: string, value: unknown): ClipRecord['exemptionRevoked'] {
  const reason = NEVER_CLIPPED_FIELDS[field];
  if (!reason || reason.kind !== 'bounded') return undefined;
  const measuredChars = sizeOf(value);
  if (measuredChars <= reason.maxChars) return undefined;
  return { declaredMaxChars: reason.maxChars, measuredChars };
}

/** `revocationOf` as a spread, so an absent revocation adds no key at all. */
function revocationSpread(field: string, value: unknown): Partial<ClipRecord> {
  const exemptionRevoked = revocationOf(field, value);
  return exemptionRevoked ? { exemptionRevoked } : {};
}

type AgentRow = Record<string, unknown>;

/**
 * An agent reduced to what identifies it and what it is doing.
 *
 * WHAT IS KEPT IS NOT A JUDGEMENT ABOUT INTERESTINGNESS — it is what other
 * code joins on and decides with. `agentName` stays because it is the join key
 * (`verify-activation-records-real-parentage.mjs` matches rows on it, and a
 * digest without it would turn that script's lookup into `undefined` on a fleet
 * large enough to summarise). `activatedBy` stays because it is the org chart,
 * and it is the exact field KAN-145 was about — dropping it here to save 70
 * characters would rebuild that defect inside the fix for a different one.
 *
 * What goes is prose and provenance: `channel.detail` is ~380 characters of
 * sentence and roughly 40% of a full row on its own, and `sessionId`,
 * `workDir`, `url` and `createdAt` are all recoverable from
 * `butchr_agent_status` for the one agent a caller cares about.
 */
function digestAgent(row: AgentRow): Record<string, unknown> {
  const channel = row.channel as Record<string, unknown> | undefined | null;
  return {
    agentName: row.agentName ?? null,
    type: row.type ?? null,
    key: row.key ?? null,
    herdrStatus: row.herdrStatus ?? null,
    status: row.status ?? null,
    sessionless: row.sessionless ?? null,
    supervisor: row.supervisor ?? null,
    activatedBy: row.activatedBy ?? null,
    transport: channel && typeof channel === 'object' ? (channel.transport ?? null) : null,
    // Says plainly that this row is short, at the row rather than only in the
    // completeness block. A reader that reached for `channel.detail` and found
    // nothing must not have to infer why.
    rowSummarised: true,
    readTheRow: 'butchr_agent_status'
  };
}

/** An agent reduced to its address and nothing else. */
function addressOf(row: AgentRow): string {
  return `${String(row.type ?? '?')}/${String(row.key ?? '?')}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value, null, 2)?.length ?? 0;
  } catch {
    return 0;
  }
}

function callRecipe(tool: string, args: string): string {
  return `${tool}(${args})`;
}

/**
 * How — or whether — a caller can get back what this answer gave up.
 *
 * KAN-501, AND THE SHAPE IS THE FIX. Until this type existed the recipe was a
 * string built from the tool's *name*: `sectionStub` wrote
 * `<tool>({ section: '<field>' })` for whatever tool it happened to be fitting.
 * That is true of exactly one tool on this server — `butchr_list_agents`, which
 * advertises a `section` parameter and honours it — and false of the other
 * forty-odd, which do not have one. So every clipped Atlassian answer printed
 * an instruction that could not be typed, and `epic/KAN-39` and `epic/KAN-203`
 * each spent a real review following it in a circle.
 *
 * The defect was not that somebody wrote the wrong string. It was that the
 * string was **derivable from the tool name alone**, so a caller with no
 * recovery to offer could not say so — the only expressible answer was a recipe.
 * This union makes "there is no way back" a thing the type can say, and
 * {@link fitGenericResponse} the caller that says it. A false recipe is now
 * something you have to construct on purpose rather than something you get by
 * default.
 *
 * Preferring the type to the assertion, per the standing rule — with the
 * assertion as well: `verify-clip-recipes-are-executable.mjs` checks every
 * recipe this module can emit against the parameters its tool actually
 * advertises.
 */
export type Recovery =
  /** A call that returns the omitted field, executable exactly as printed. */
  | { readonly kind: 'call'; readonly call: string }
  /** There is none, and this says why in the answer rather than in a comment. */
  | { readonly kind: 'none'; readonly why: string };

/**
 * The recovery `butchr_list_agents` can offer, which is a real one.
 *
 * Kept as a named function rather than inlined so the one place a `section`
 * recipe is constructed is the one place that can be checked against the one
 * schema that carries a `section` parameter.
 */
function sectionRecovery(tool: string, field: string): Recovery {
  return { kind: 'call', call: callRecipe(tool, `{ section: '${field}' }`) };
}

/**
 * The stub a dropped section leaves behind.
 *
 * A stub rather than a deletion, because a deleted key and a key this daemon
 * does not carry are the same absence — and this codebase already draws that
 * distinction everywhere else (`boardControl` is omitted when no reconciler is
 * wired, precisely so it cannot be read as "the reconciler says nothing").
 * Deleting for budget would collide with that meaning. The stub keeps them
 * apart: `omitted: 'for-budget'` is a field that exists and was not sent.
 *
 * `readWith` and `noWayBack` are mutually exclusive by construction: the stub
 * carries whichever arm {@link Recovery} is, and never both. A reader that finds
 * no `readWith` is not looking at an oversight.
 */
function sectionStub(field: string, value: unknown, recovery: Recovery): Record<string, unknown> {
  const total = Array.isArray(value) ? value.length : null;
  return {
    omitted: 'for-budget',
    ...(total === null ? {} : { total }),
    chars: sizeOf(value),
    ...(recovery.kind === 'call' ? { readWith: recovery.call } : { noWayBack: recovery.why })
  };
}

/**
 * KAN-525. THE LAST LEVER, AND IT IS THE ONE THE EXEMPT FIELDS THEMSELVES GIVE.
 *
 * Reached only when every other rung has run and the answer is still over
 * budget, which means what is left is exempt. A `disclosure` list is exempt
 * because it answers *"is the list above whole?"* — so omitting it is refused,
 * and always will be. But a list that can grow without limit is not protecting
 * that question; it is destroying the answer it sits on. Measured on
 * `origin/main`'s build: 300 `missingAgents` produced a 73,312-character
 * response against a 9,000 budget, and `censusUnreadableRecords` is ~730
 * characters PER ENTRY on this machine today, so thirteen of them do the same.
 *
 * So the entries go and the COUNT STAYS. `total` and `omitted` on the record
 * below are the disclosure surviving its own reduction, which is the whole
 * difference between this and dropping the field: a reader still learns that
 * the census was short and by how much, and loses only which rows.
 *
 * Halved from the end rather than truncated to a fixed count, exactly as the
 * `agents` rung is, because the right window is whatever fits and nothing here
 * knows how large one entry is.
 */
function windowDisclosureLists(
  start: Record<string, unknown>,
  clips: ClipRecord[],
  fitsWith: (candidate: Record<string, unknown>, clips: readonly ClipRecord[]) => boolean
): Record<string, unknown> {
  let working = start;
  for (const field of DISCLOSURE_WINDOWED_FIELDS) {
    if (fitsWith(working, clips)) return working;
    const value = working[field];
    if (!Array.isArray(value) || value.length === 0) continue;
    const total = value.length;
    let keep = total;
    let at = -1;
    while (keep > 0) {
      keep = Math.floor(keep / 2);
      const record: ClipRecord = {
        field,
        reduction: 'entries-omitted',
        returned: keep,
        total,
        omitted: total - keep,
        readTheRest:
          `${field} is a disclosure field: it is never omitted, because it is what says whether ` +
          'the list above is whole. Its entries were windowed to fit; the count is what survives.'
      };
      if (at === -1) {
        clips.push(record);
        at = clips.length - 1;
      } else clips[at] = record;
      working = { ...working, [field]: value.slice(0, keep) };
      if (fitsWith(working, clips)) break;
    }
  }
  return working;
}

/**
 * KAN-525. SAY SO WHEN THERE WAS NOTHING LEFT TO GIVE UP.
 *
 * Every lever has run and the answer is still over budget. The one thing that
 * must not happen now is the thing that used to: come back with
 * `kind: 'complete'` and *"WHOLE: every field is present and every list
 * entire"*, and let the client cut the middle out of it. That is KAN-423's own
 * defect rebuilt inside the fix for it.
 *
 * Nothing is dropped here — the record is the honest report that the answer as
 * sent exceeds the budget, naming the largest field left so a reader knows
 * where it went. Whether it arrives whole is now the client's business, and
 * `completeness` is what tells them to check.
 */
function irreducibleRecord(full: Record<string, unknown>, budgetChars: number): ClipRecord {
  // MEASURED OVER THE PAYLOAD WITH ITS `completeness` BLOCK IN IT, and that is
  // not a detail. At a small budget the disclosure block is routinely the
  // largest thing left — it grows by one record per reduction — so a scan that
  // skipped it named whichever stub happened to be biggest and sent the reader
  // to a 219-character field while 1,700 characters of verdict sat beside it.
  // Naming `completeness` is the honest answer there: what does not fit is the
  // account of what did not fit, and the lever for that is the budget itself.
  const largest = Object.keys(full)
    .map((k) => [k, sizeOf(full[k])] as const)
    .sort((a, b) => b[1] - a[1])[0];
  const field = largest?.[0] ?? 'value';
  const measured = largest?.[1] ?? 0;
  const reason = NEVER_CLIPPED_FIELDS[field];
  return {
    field,
    reduction: 'irreducible',
    returned: null,
    total: null,
    omitted: null,
    // `measured` is this ONE FIELD's size, which no later pass rewrites — unlike
    // `completeness.chars`, which is the whole answer's and is restamped by
    // `serialiseWithExactChars` after this string exists. Quoting the stable
    // number and pointing at the authoritative one is the honest pairing.
    readTheRest:
      `nothing here could be given up. \`${field}\` is the largest field left at ${measured} ` +
      `characters against a ${budgetChars}-character budget` +
      (reason
        ? `, and it is exempt from reduction (${reason.kind}) — see NEVER_CLIPPED_FIELDS.`
        : '.') +
      ' Nothing was dropped, so what this daemon sent is whole; it is larger than the budget, ' +
      'so your client may have cut it. Compare what you received against `completeness.chars`.'
  };
}

/**
 * Fit a `list_agents` answer to the budget, and describe the fitting.
 *
 * THE FIXED POINT. Every reduction is measured against the serialised size of
 * the payload **with the completeness block already in it**, because that block
 * grows by one record per reduction and a budget check that ignored it would
 * hand the client a payload fractionally over. The loop terminates because the
 * ladder is finite and its last rung is a payload whose size depends only on
 * the number of agents, which the rung after that bounds as well.
 */
export function fitListAgentsResponse(
  response: Record<string, unknown>,
  options: FitOptions = {}
): Fitted {
  const tool = options.tool ?? 'butchr_list_agents';
  const budgetChars = Math.max(options.budgetChars ?? budgetFromEnv(), MIN_BUDGET_CHARS);
  const clips: ClipRecord[] = [];

  const agentsIn: AgentRow[] = Array.isArray(response.agents)
    ? (response.agents as AgentRow[])
    : [];
  const agentsTotal = agentsIn.length;

  // A single section, asked for by name. Answered on its own so that a reader
  // sent here by a `readWith` recipe gets that field and not the fleet again.
  if (options.section) {
    return fitSection(response, options.section, { tool, budgetChars, agentsTotal });
  }

  const offset = Math.max(0, Math.floor(options.offset ?? 0));

  // `agentsTotal` is added unconditionally and never clipped. IT IS THE ONE
  // FIELD THAT MAKES A SHORT LIST DETECTABLE WITHOUT READING ANYTHING ELSE:
  // `agents.length < agentsTotal` is the whole check, and it holds whoever did
  // the clipping — us, or a client we never hear from.
  let working: Record<string, unknown> = { ...response, agentsTotal };

  // The window first, so that everything after it — summary view, the ladder,
  // the final halving — operates on the rows the caller actually asked for.
  if (offset > 0) {
    working.agents = agentsIn.slice(offset);
    working.agentsOffset = offset;
  }

  // `Array.isArray` rather than assuming the field is there. A daemon that
  // answered without `agents` at all — an error response reaching this path, a
  // peer that never sent one — used to reach `.map` on `undefined` and throw,
  // which would have turned a degraded answer into no answer. This tool exists
  // to make a partial answer legible; crashing on one is the opposite.
  if (options.view === 'summary' && Array.isArray(working.agents)) {
    // Asked for outright rather than fallen back to, so it is not a clip: the
    // caller got exactly the answer it requested, and `agentsTotal` still says
    // how many there are. The ladder below still runs, because a fleet large
    // enough can overflow even this.
    working.agents = (working.agents as AgentRow[]).map(addressOf);
    working.agentsView = 'addresses';
    working.omittedForSummaryView = SECTION_CLIP_ORDER.filter((f) => f in response);
    for (const field of SECTION_CLIP_ORDER) {
      if (field in working) delete working[field];
    }
  }

  const unclippedChars = sizeOf({ ...response, agentsTotal });

  const provisional = (payload: Record<string, unknown>): Completeness =>
    clips.length === 0
      ? completeVerdict(sizeOf(payload), budgetChars)
      : clippedVerdict(
          sizeOf(payload),
          budgetChars,
          unclippedChars,
          clips as [ClipRecord, ...ClipRecord[]]
        );

  const fits = (payload: Record<string, unknown>): { ok: boolean; chars: number } => {
    const chars = sizeOf(withCompleteness(payload, provisional(payload)));
    return { ok: chars <= budgetChars, chars };
  };

  // ---- the ladder -------------------------------------------------------
  //
  // Each rung is applied, then measured, and the walk stops the moment the
  // answer fits. `CLIP_LADDER` is the declared order and its header is where
  // the reasoning for that order lives.
  //
  // NOTE WHAT NO RUNG HERE DOES: none of them drops an agent. Every rung down
  // to the last one keeps `agents.length === agentsTotal` and gives up detail
  // instead. Losing an agent outright is the separate halving below, reached
  // only when the whole ladder was not enough.

  let current = fits(working);

  /** What each rung took away, so the restore pass below can offer it back. */
  const takenBack = new Map<string, unknown>();

  for (const step of CLIP_LADDER) {
    if (current.ok) break;

    if (step.kind === 'section') {
      const field = step.field;
      if (!(field in working)) continue;
      if (exemptionHolds(field, working[field])) continue;
      const value = working[field];
      // A stub already stands here — the summary view emptied this field, or
      // the ladder has been walked twice by the re-fit backstop.
      if (isPlainObject(value) && value.omitted === 'for-budget') continue;
      takenBack.set(field, value);
      working = { ...working, [field]: sectionStub(field, value, sectionRecovery(tool, field)) };
      clips.push({
        field,
        reduction: 'section-omitted',
        returned: Array.isArray(value) ? 0 : null,
        total: Array.isArray(value) ? value.length : null,
        omitted: Array.isArray(value) ? value.length : null,
        readTheRest: callRecipe(tool, `{ section: '${field}' }`)
      });
      current = fits(working);
      continue;
    }

    if (!Array.isArray(working.agents) || working.agents.length === 0) continue;
    if (working.agentsView === 'addresses') continue;
    const rows = working.agents as AgentRow[];

    if (step.kind === 'agents-summarise') {
      if (working.agentsView === 'summarised') continue;
      takenBack.set('agents', rows);
      working = { ...working, agents: rows.map(digestAgent), agentsView: 'summarised' };
    } else {
      working = {
        ...working,
        agents: rows.map((r) => (typeof r === 'string' ? r : addressOf(r))),
        agentsView: 'addresses'
      };
    }

    // REPLACE THE EARLIER VIEW RECORD RATHER THAN PUSH A SECOND. Both rungs can
    // fire on the same answer, and pushing twice listed `agents rows-summarised
    // 400/400` in the verdict twice — identical numbers, no way to tell which
    // view actually resulted, and a `clipped` array that reads as two separate
    // losses where there was one. A reader wants the END STATE, and
    // `rows-addressed` subsumes `rows-summarised`.
    const record: ClipRecord = {
      field: 'agents',
      reduction: step.kind === 'agents-summarise' ? 'rows-summarised' : 'rows-addressed',
      returned: rows.length,
      total: agentsTotal,
      // Zero, and that is the point of these rungs: detail went, no agent did.
      omitted: 0,
      readTheRest: callRecipe(tool, `{ section: 'agents' }`)
    };
    const priorView = clips.findIndex(
      (c) => c.field === 'agents' && (c.reduction === 'rows-summarised' || c.reduction === 'rows-addressed')
    );
    if (priorView === -1) clips.push(record);
    else clips[priorView] = record;
    current = fits(working);
  }

  // ---- the restore pass ---------------------------------------------------
  //
  // WHY A LADDER ALONE IS NOT ENOUGH. The ladder stops at the first rung that
  // fits, and a rung is a whole field — so the step that finally brought the
  // answer under budget usually overshoots by most of that field's size.
  // Measured on the eight-agent census before this pass existed: the answer
  // came back at 5,861 characters against a 9,000 budget, having given up
  // `capacity` and `undeliveredNotifications` into 3,139 characters of headroom
  // that then went unused. Nothing was wrong — the fields were dropped in the
  // right order — and the answer was needlessly poorer than the budget allowed.
  //
  // So the ladder decides the ORDER things are given up in, and this decides
  // how MANY actually stay given up. Walking `clips` backwards is walking the
  // ladder in reverse, which offers the most load-bearing field back first:
  // `undeliveredNotifications` before `capacity`, both before full agent rows.
  //
  // Re-measured on every attempt, because removing a clip also removes its
  // record from the completeness block and so frees a little more room. And if
  // every clip comes back, `clips` empties and the verdict becomes `complete` —
  // which is correct rather than a special case: an answer that gave nothing up
  // is whole, however it got there.
  for (let i = clips.length - 1; i >= 0; i -= 1) {
    const clip = clips[i];
    if (clip.reduction === 'entries-omitted') continue;
    const original = takenBack.get(clip.field);
    if (original === undefined) continue;

    const candidateClips = clips.filter((_, j) => j !== i);
    const candidate: Record<string, unknown> = { ...working, [clip.field]: original };
    if (clip.field === 'agents') {
      // Restoring rows restores the view they were shown in.
      if (working.agentsView === 'addresses') continue;
      delete candidate.agentsView;
    }
    const verdict =
      candidateClips.length === 0
        ? completeVerdict(sizeOf(candidate), budgetChars)
        : clippedVerdict(
            sizeOf(candidate),
            budgetChars,
            unclippedChars,
            candidateClips as [ClipRecord, ...ClipRecord[]]
          );
    const chars = sizeOf(withCompleteness(candidate, verdict));
    if (chars > budgetChars) continue;

    working = candidate;
    clips.splice(i, 1);
    takenBack.delete(clip.field);
    current = { ok: true, chars };
  }

  // Last rung: drop agents from the end of the window, and say how many.
  // Reached only by a fleet whose addresses alone will not fit, and it is the
  // only rung that loses an agent entirely — so it is the only one that can
  // reintroduce an under-count, which is exactly why `agentsTotal` above is
  // never clipped and why the record below names the offset to resume from.
  if (!current.ok && Array.isArray(working.agents)) {
    const rows = working.agents as unknown[];
    const windowSize = rows.length;
    let keep = windowSize;
    while (keep > 0) {
      keep = Math.floor(keep / 2);
      working = { ...working, agents: rows.slice(0, keep) };
      const at = clips.findIndex((c) => c.field === 'agents' && c.reduction === 'entries-omitted');
      const record: ClipRecord = {
        field: 'agents',
        reduction: 'entries-omitted',
        returned: keep,
        total: agentsTotal,
        omitted: windowSize - keep,
        readTheRest: callRecipe(tool, `{ offset: ${offset + keep} }`)
      };
      if (at === -1) clips.push(record);
      else clips[at] = record;
      current = fits(working);
      if (current.ok) break;
    }
  }

  // KAN-525. What is left over budget now is exempt, and the disclosure lists
  // are the part of it that can still give something up without giving up the
  // question they answer.
  if (!current.ok) {
    working = windowDisclosureLists(working, clips, (candidate, withClips) => {
      const verdict =
        withClips.length === 0
          ? completeVerdict(0, budgetChars)
          : clippedVerdict(0, budgetChars, unclippedChars, withClips as [ClipRecord, ...ClipRecord[]]);
      return sizeOf(withCompleteness(candidate, verdict)) <= budgetChars;
    });
    current = fits(working);
  }

  if (!current.ok) {
    const provisionalVerdict =
      clips.length === 0
        ? completeVerdict(current.chars, budgetChars)
        : clippedVerdict(current.chars, budgetChars, unclippedChars, clips as [ClipRecord, ...ClipRecord[]]);
    clips.push(irreducibleRecord(withCompleteness(working, provisionalVerdict), budgetChars));
  }

  const completeness: Completeness =
    clips.length === 0
      ? completeVerdict(current.chars, budgetChars)
      : clippedVerdict(
          current.chars,
          budgetChars,
          unclippedChars,
          clips as [ClipRecord, ...ClipRecord[]]
        );

  return serialiseWithExactChars(working, completeness);
}

/** One named section, answered on its own. */
function fitSection(
  response: Record<string, unknown>,
  section: string,
  ctx: { tool: string; budgetChars: number; agentsTotal: number }
): Fitted {
  const available = Object.keys(response).filter(
    (k) => k !== 'action' && k !== 'success' && k !== 'completeness'
  );
  if (!(section in response)) {
    // A refusal rather than an empty answer. "That section is not on this
    // response" and "that section is empty" are different facts, and a caller
    // that cannot tell them apart is back inside this ticket.
    return serialiseWithExactChars(
      {
        action: response.action ?? null,
        success: false,
        error: `no section '${section}' on this response`,
        availableSections: available
      },
      completeVerdict(0, ctx.budgetChars)
    );
  }

  const value = response[section];
  const base: Record<string, unknown> = {
    action: response.action ?? null,
    success: response.success ?? true,
    section,
    agentsTotal: ctx.agentsTotal,
    [section]: value
  };

  const clips: ClipRecord[] = [];
  let working = base;
  let chars = sizeOf(withCompleteness(working, completeVerdict(0, ctx.budgetChars)));

  // A section that is itself too large is halved from the end until it fits,
  // and says so. Nothing here can return a short list silently.
  if (chars > ctx.budgetChars && Array.isArray(value)) {
    let keep = value.length;
    while (keep > 0 && chars > ctx.budgetChars) {
      keep = Math.floor(keep / 2);
      working = { ...base, [section]: value.slice(0, keep) };
      const record: ClipRecord = {
        field: section,
        reduction: 'entries-omitted',
        returned: keep,
        total: value.length,
        omitted: value.length - keep,
        readTheRest: 'not available in one call; this section exceeds the response budget'
      };
      clips[0] = record;
      chars = sizeOf(
        withCompleteness(working, clippedVerdict(0, ctx.budgetChars, sizeOf(base), [record]))
      );
    }
  } else if (chars > ctx.budgetChars) {
    const record: ClipRecord = {
      field: section,
      reduction: 'section-omitted',
      returned: null,
      total: null,
      omitted: null,
      readTheRest: 'not available over MCP; this section alone exceeds the response budget'
    };
    clips[0] = record;
    working = {
      ...base,
      [section]: sectionStub(section, value, {
        kind: 'none',
        why: `this section alone exceeds the ${ctx.budgetChars}-character response budget, so no call on this server returns it whole`
      })
    };
    chars = sizeOf(
      withCompleteness(working, clippedVerdict(0, ctx.budgetChars, sizeOf(base), [record]))
    );
  }

  const completeness: Completeness =
    clips.length === 0
      ? completeVerdict(chars, ctx.budgetChars)
      : clippedVerdict(chars, ctx.budgetChars, sizeOf(base), clips as [ClipRecord, ...ClipRecord[]]);

  return serialiseWithExactChars(working, completeness);
}

/**
 * `completeness` goes FIRST, and that placement is load-bearing rather than
 * tidy. The client that truncates keeps the head and the tail and elides the
 * middle — so a disclosure at the front survives a clip we did not do and did
 * not expect. If our budget is ever wrong about somebody's cap, the field that
 * says "this may not be whole" is the one field guaranteed to arrive.
 */
function withCompleteness(
  payload: Record<string, unknown>,
  completeness: Completeness
): Record<string, unknown> {
  const { completeness: _drop, ...rest } = payload;
  return { completeness, ...rest };
}

/**
 * Serialise, and make `completeness.chars` the length of what was serialised.
 *
 * `chars` is inside the string whose length it reports, so writing it changes
 * it — one more digit in the number is one more character in the answer. Every
 * call site here computed it against a *provisional* block and happened to
 * agree with the final one, which is agreement by luck rather than by
 * construction; the section-refusal path did not agree at all and reported
 * `chars: 0` for an 825-character answer.
 *
 * A ticket about a field that misreports what it describes should not ship a
 * field that misreports what it describes. So this iterates to the fixed point:
 * stamp the measured length, re-measure, and stop when they agree. It converges
 * in at most a couple of passes because only the digit count can move, and it
 * returns whatever it has if they oscillate across a digit boundary — an answer
 * one character out is not worth a loop that does not terminate.
 */
function serialiseWithExactChars(
  payload: Record<string, unknown>,
  completeness: Completeness
): { payload: Record<string, unknown>; text: string; completeness: Completeness } {
  let verdict = completeness;
  let full = withCompleteness(payload, verdict);
  let text = JSON.stringify(full, null, 2);
  for (let pass = 0; pass < 3 && verdict.chars !== text.length; pass += 1) {
    verdict = { ...verdict, chars: text.length } as Completeness;
    full = withCompleteness(payload, verdict);
    text = JSON.stringify(full, null, 2);
  }
  return { payload: full, text, completeness: verdict };
}

function completeVerdict(chars: number, budgetChars: number): Completeness {
  return {
    kind: 'complete',
    chars,
    budgetChars,
    detail:
      'WHOLE: every field is present and every list entire. A clipped answer ' +
      'reads `kind: "clipped"` and carries a `clipped` array; this one has no ' +
      'such key, so the two are different shapes rather than one shape with a flag.'
  };
}

function clippedVerdict(
  chars: number,
  budgetChars: number,
  unclippedChars: number,
  clipped: readonly [ClipRecord, ...ClipRecord[]]
): Completeness {
  const lists = clipped.filter((c) => c.omitted !== null && c.omitted > 0);
  const lost = lists.reduce((n, c) => n + (c.omitted ?? 0), 0);
  return {
    kind: 'clipped',
    chars,
    budgetChars,
    unclippedChars,
    clipped,
    // KEPT SHORT ON PURPOSE. This block sits inside the budget it describes, so
    // every sentence here is a field somewhere else that had to go — an early
    // draft ran to ~800 characters and cost this response its
    // `undeliveredNotifications`, which answers who was never told. The
    // reasoning belongs in the tool description, which costs the answer nothing;
    // what belongs here is the verdict and the numbers.
    // WHAT HAPPENED, DERIVED FROM WHAT HAPPENED (KAN-501). The no-loss branch
    // used to read "every agent is named, with less said about some" for every
    // tool on this server, because the only tool that could reach this code when
    // it was written was the fleet census. It was then printed verbatim on Jira
    // comment reads and on `butchr_atlassian_proxy_status` — responses with no
    // agents in them at all. A sentence that is true of one caller and asserted
    // for all of them is the same defect as a recipe built from a tool's name:
    // both are a fact about one shape, generalised by the code that emits it.
    // So the agent sentence is now conditioned on an agent rung having fired.
    // KAN-525 ADDS THE FIRST BRANCH, AND IT IS THE ONE THAT SAYS THE OPPOSITE
    // OF THE OTHER THREE. Every sentence below it reports a reduction that
    // happened; `irreducible` reports one that could not, so a verdict carrying
    // it must not open with "reduced to fit" — the answer is over the budget,
    // not inside it, and what a reader has to do about that is check what
    // arrived rather than fetch what went.
    detail: clipped.some((c) => c.reduction === 'irreducible')
      ? // `chars` is NOT interpolated here on purpose: `serialiseWithExactChars`
        // rewrites that field to the true length after this string is built, so
        // a number baked in now would disagree with the field beside it. Read
        // `chars` above against `budgetChars`.
        `STILL OVER BUDGET: this answer is larger than its ${budgetChars}-character budget and ` +
        'nothing left could be given up — compare `chars` above. Nothing was dropped by this ' +
        'daemon, but your client may have cut what it delivered; `clipped` names the field the ' +
        'budget went to.'
      : `NOT WHOLE: ${unclippedChars} chars reduced to fit ${budgetChars}. ` +
        (lost > 0
          ? `${lost} list entr(ies) are absent — \`clipped\` names the field and the call that returns them.`
          : clipped.some((c) => c.reduction === 'rows-summarised' || c.reduction === 'rows-addressed')
            ? 'No entry was dropped; every agent is named, with less said about some.'
            : 'No list entry was dropped; `clipped` names each field that was reduced and what, if anything, returns it.')
  };
}

/**
 * The universal backstop for every other tool on this server.
 *
 * WHAT IT IS NOT: the fitter above. It has no ladder, because it knows nothing
 * about the shape it is given — so it gives up whole fields, largest first,
 * which is the only reduction that is safe on an unknown object and still
 * leaves valid JSON.
 *
 * WITH ONE EXCEPTION, AND IT IS THE ONE SHAPE THIS FUNCTION *DOES* KNOW
 * SOMETHING ABOUT (KAN-522): a **list** is trimmed to the largest non-empty
 * prefix that fits, rather than replaced. Nothing about the entries has to be
 * understood to know that n of them beat none of them, and `ClipRecord` already
 * carries `returned`/`total`/`omitted`, so the disclosure costs the same either
 * way. Zero still gets the stub — an empty array reads as a search that found
 * nothing, which is the defect at the top of this file rather than a smaller
 * answer.
 *
 * WHY IT EXISTS AT ALL. `butchr_list_agents` is the tool that was measured over
 * the cap, and it is the one this ticket names. But the property worth having
 * is *no tool on this server hands the client more than it will carry*, and a
 * fix scoped to the one tool that has already failed is a fix that waits for
 * the next tool to grow. The other tools measure well under the budget today;
 * this is what makes that a fact about their size rather than about luck.
 */
export function fitGenericResponse(
  response: unknown,
  options: {
    budgetChars?: number;
    tool: string;
    /**
     * What this tool can offer a caller for a field it had to give up.
     *
     * KAN-501. Defaulted rather than required, and the default is `none` —
     * which is the whole point. A tool that says nothing about its recovery
     * gets an honest "there is none" instead of the invented `section` recipe
     * this parameter replaced. Supplying a recipe is now the deliberate act;
     * omitting one is safe.
     *
     * The path is dotted for a member — `body.comments` — so a tool that pages
     * can name the call that returns the next page of exactly that list.
     */
    recoveryFor?: (path: string) => Recovery;
  }
): Fitted {
  const budgetChars = Math.max(options.budgetChars ?? budgetFromEnv(), MIN_BUDGET_CHARS);
  const unclippedChars = sizeOf(response);

  if (!isPlainObject(response) || unclippedChars <= budgetChars) {
    const payload = isPlainObject(response)
      ? withCompleteness(response, completeVerdict(unclippedChars, budgetChars))
      : ({ completeness: completeVerdict(unclippedChars, budgetChars), value: response } as Record<
          string,
          unknown
        >);
    // An over-budget NON-object cannot be reduced by dropping fields, and
    // truncating it would produce the silent short answer this file forbids.
    // Saying so is the honest move.
    if (!isPlainObject(response) && unclippedChars > budgetChars) {
      const record: ClipRecord = {
        field: 'value',
        reduction: 'section-omitted',
        returned: null,
        total: null,
        omitted: null,
        readTheRest: 'not reducible: this tool answered with a non-object over budget'
      };
      const completeness = clippedVerdict(0, budgetChars, unclippedChars, [record]);
      const clippedPayload = { completeness, value: null };
      return {
        payload: clippedPayload,
        text: JSON.stringify(clippedPayload, null, 2),
        completeness
      };
    }
    return {
      payload,
      text: JSON.stringify(payload, null, 2),
      completeness: completeVerdict(unclippedChars, budgetChars)
    };
  }

  const recoveryFor =
    options.recoveryFor ??
    ((path: string): Recovery => ({
      kind: 'none',
      why:
        `${options.tool} takes no parameter that returns "${path}" on its own. ` +
        'Narrowing the request is the only lever, and on some calls there is no narrower one.'
    }));

  const clips: ClipRecord[] = [];
  let working: Record<string, unknown> = { ...response };

  /**
   * What may be given up, smallest unit first.
   *
   * ONE LEVEL OF RECURSION, AND KAN-501 IS WHY. Giving up whole top-level
   * fields is the only reduction that is safe on a shape this function knows
   * nothing about — but on the shape it actually meets most, the proxy
   * envelope, the whole answer lives in ONE field called `body`, so
   * "largest-first" and "all of it" were the same move. The clip that took a
   * ticket's comments took `total`, `startAt` and `maxResults` with them, and
   * those are what the tool's own description tells a caller to page by:
   * `epic/KAN-203` was told to walk `startAt` until it reached a `total` the
   * same response had just deleted.
   *
   * So a plain object is descended into once and its members are the units.
   * Scalars are not candidates at all — they are a few dozen characters each
   * and they are the half a reader steers by. What this does NOT do is recurse
   * further: two levels down, a field name stops being something a caller can
   * act on, and the safety argument for dropping whole fields stops holding.
   */
  const candidates: Array<{ path: string; owner: string | null; key: string; size: number }> = [];
  for (const field of Object.keys(response)) {
    const value = (response as Record<string, unknown>)[field];
    if (exemptionHolds(field, value)) continue;
    // KAN-525. A DEMOTED FIELD GOES STRAIGHT TO WHOLE-FIELD CANDIDACY, and the
    // member rung is skipped for it deliberately. What put it here is that the
    // field AS A WHOLE outgrew the ceiling declared for it, and descending
    // would look for large object members — where `via`, the measured instance,
    // is 5,335 characters of which the only object member is a two-string
    // `products`. Descending would clip that, save four characters, record a
    // `members-omitted` against the wrong half, and leave the caller's own
    // 5,300-character query sitting in `path`.
    //
    // WHOLE-FIELD CANDIDACY IS NOT THE SAME AS A WHOLE-FIELD OUTCOME, and the
    // distinction matters since KAN-522. Being a candidate is what makes the
    // field reducible at all; what happens to it there depends on its shape. An
    // object — `via` — is given up whole. A LIST is trimmed to the largest
    // prefix that fits, because n entries beat none for every n > 0, so
    // `available: [...]` comes back short rather than absent. Both carry
    // `exemptionRevoked`, which is the half a reader needs either way.
    if (field in NEVER_CLIPPED_FIELDS) {
      candidates.push({ path: field, owner: null, key: field, size: sizeOf(value) });
      continue;
    }
    if (isPlainObject(value)) {
      const members = Object.keys(value).filter(
        (k) => isPlainObject(value[k]) || Array.isArray(value[k])
      );
      // WHAT DESCENDING IS FOR, AND THE CONDITION IS THE WHOLE OF IT: keeping
      // the small members while the large ones go. An object with no small
      // members has nothing to keep, so descending into it buys nothing — and
      // costs something real, which is why this is a condition rather than a
      // preference. Fragmenting a big object into many small candidates hides
      // it from a largest-first ordering: measured while writing this ticket's
      // proof, a 15,000-character `report` of 32 sub-objects was passed over
      // and a 1,200-character `toolsAdvertised` list dropped in its place,
      // because the report had no single candidate as large as the list. The
      // reduction was correct and the field it chose was the wrong one.
      const keepsSomething = Object.keys(value).some(
        (k) => !isPlainObject(value[k]) && !Array.isArray(value[k])
      );
      if (members.length > 0 && keepsSomething) {
        for (const member of members) {
          candidates.push({
            path: `${field}.${member}`,
            owner: field,
            key: member,
            size: sizeOf(value[member])
          });
        }
        continue;
      }
    }
    candidates.push({ path: field, owner: null, key: field, size: sizeOf(value) });
  }
  candidates.sort((a, b) => b.size - a.size);

  const measure = (payload: Record<string, unknown>, against: ClipRecord[]): number => {
    const provisional =
      against.length === 0
        ? completeVerdict(0, budgetChars)
        : clippedVerdict(0, budgetChars, unclippedChars, against as [ClipRecord, ...ClipRecord[]]);
    return sizeOf(withCompleteness(payload, provisional));
  };

  const stillOver = (): boolean => measure(working, clips) > budgetChars;

  for (const candidate of candidates) {
    if (!stillOver()) break;
    const recovery = recoveryFor(candidate.path);

    /** `working` with `value` written at this candidate's path. */
    const place = (value: unknown): Record<string, unknown> | null => {
      if (candidate.owner === null) return { ...working, [candidate.key]: value };
      const owner = working[candidate.owner];
      if (!isPlainObject(owner)) return null;
      return { ...working, [candidate.owner]: { ...owner, [candidate.key]: value } };
    };

    const raw = candidate.owner === null
      ? (response as Record<string, unknown>)[candidate.key]
      : ((response as Record<string, unknown>)[candidate.owner] as Record<string, unknown>)[candidate.key];

    // ---- an array is TRIMMED, never deleted (KAN-522) ---------------------
    //
    // WHY THIS RUNG EXISTS AT ALL. Giving up whole fields is the only reduction
    // that is safe on a shape this function knows nothing about — but a list is
    // the one shape it *does* know something about, and on a list the two moves
    // are not comparable: a prefix of n entries strictly dominates zero of them
    // for every n > 0, and costs the same disclosure either way, because
    // `ClipRecord` already models `returned`/`total`/`omitted` exactly.
    //
    // MEASURED, WHICH IS WHY IT IS HERE RATHER THAN IN A LATER TICKET.
    // `atlassian_search_issues` condenses its rows (KAN-522) and a 50-row page
    // of this board's summaries still exceeds the budget — so without this rung
    // the fix one file over would have moved the ceiling from three issues to
    // about forty and left the same cliff at the end of it, where the answer
    // goes from forty rows to none.
    //
    // ⚠ **THE PREFIX MUST BE NON-EMPTY, AND THE STUB IS WHAT ZERO GETS.** An
    // empty array is not a small answer, it is a WRONG one: `issues: []` reads
    // as a search that found nothing, which is KAN-423's defect exactly — a
    // short list and a clipped list being the same bytes. The stub says
    // `omitted: 'for-budget'` and cannot be read that way, so the two arms are
    // split on `keep > 0` rather than on tidiness.
    if (Array.isArray(raw) && raw.length > 0) {
      const total = raw.length;
      const recordFor = (keep: number): ClipRecord => ({
        field: candidate.path,
        reduction: 'entries-omitted',
        returned: keep,
        total,
        omitted: total - keep,
        readTheRest: recovery.kind === 'call' ? recovery.call : recovery.why,
        // KAN-525. A DEMOTED EXEMPT FIELD REACHES THIS RUNG TOO, AND THE
        // REVOCATION HAS TO SURVIVE THE BETTER OUTCOME. `available: [...]` —
        // this ticket's own example — is a list, so KAN-522's trimming rung
        // takes it before the stub below ever runs, and a reader gets 181 of
        // 300 entries rather than none. That is strictly better and it is why
        // the spread is added here rather than the rung being excluded: what
        // must not happen is the answer losing WHY a field documented as never
        // clipped was clipped at all. Without this the record reads as an
        // ordinary trim and the exemption looks like it simply did not work.
        ...(candidate.owner === null ? revocationSpread(candidate.key, raw) : {})
      });

      // The largest prefix that fits, by binary search rather than by halving.
      // Halving is what the two older rungs in this file do and it overshoots by
      // up to half the list every time — the restore pass in
      // `fitListAgentsResponse` exists to undo exactly that. A search is
      // measured in entries a reader wanted, so the overshoot is the cost worth
      // not paying, and the size of a prefix is monotone in its length.
      let lo = 0;
      let hi = total;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        const trial = place(raw.slice(0, mid));
        if (trial && measure(trial, [...clips, recordFor(mid)]) <= budgetChars) lo = mid;
        else hi = mid - 1;
      }

      if (lo > 0) {
        const trimmed = place(raw.slice(0, lo));
        if (trimmed) {
          working = trimmed;
          clips.push(recordFor(lo));
          continue;
        }
      }
    }

    const stubbed = place(sectionStub(candidate.key, raw, recovery));
    if (!stubbed) continue;
    working = stubbed;

    clips.push({
      field: candidate.path,
      reduction: candidate.owner === null ? 'section-omitted' : 'members-omitted',
      returned: Array.isArray(raw) ? 0 : null,
      total: Array.isArray(raw) ? raw.length : null,
      omitted: Array.isArray(raw) ? raw.length : null,
      // NO LONGER A SENTENCE ABOUT PAGINATION THIS FUNCTION CANNOT KNOW. It
      // used to read "not paginated on <tool>; narrow the request instead" for
      // every tool — printed, among others, on `atlassian_get_issue_comments`,
      // which is paginated, and to a caller already at `maxResults: 1`.
      readTheRest: recovery.kind === 'call' ? recovery.call : recovery.why,
      ...(candidate.owner === null ? revocationSpread(candidate.key, raw) : {})
    });
  }

  // The backstop to the backstop: an object whose scalars alone will not fit.
  // Reached only when member-level reduction has run out, and it is the old
  // whole-field behaviour, unchanged except that its recipe is now honest.
  if (stillOver()) {
    const wholeFields = Object.keys(response)
      .filter((k) => !exemptionHolds(k, (response as Record<string, unknown>)[k]))
      .map((k) => [k, sizeOf((response as Record<string, unknown>)[k])] as const)
      .sort((a, b) => b[1] - a[1]);
    for (const [field] of wholeFields) {
      if (!stillOver()) break;
      const value = working[field];
      if (isPlainObject(value) && value.omitted === 'for-budget') continue;
      const recovery = recoveryFor(field);
      working = { ...working, [field]: sectionStub(field, value, recovery) };
      const raw = (response as Record<string, unknown>)[field];
      const at = clips.findIndex((c) => c.field === field || c.field.startsWith(`${field}.`));
      const record: ClipRecord = {
        field,
        reduction: 'section-omitted',
        returned: Array.isArray(raw) ? 0 : null,
        total: Array.isArray(raw) ? raw.length : null,
        omitted: Array.isArray(raw) ? raw.length : null,
        readTheRest: recovery.kind === 'call' ? recovery.call : recovery.why,
        ...revocationSpread(field, raw)
      };
      // The whole field subsumes any member record already taken from it — a
      // reader wants the end state, not the route the fitter walked to it.
      if (at === -1) clips.push(record);
      else {
        clips.splice(
          0,
          clips.length,
          ...clips.filter((c) => c.field !== field && !c.field.startsWith(`${field}.`)),
          record
        );
      }
    }
  }

  // KAN-525. Same last lever as the fleet fitter's, for the same reason: what
  // is still over budget after the backstop is exempt, and a disclosure list is
  // the part of it that can give up entries without giving up its count.
  if (stillOver()) {
    working = windowDisclosureLists(working, clips, (candidate, withClips) => {
      const verdict =
        withClips.length === 0
          ? completeVerdict(0, budgetChars)
          : clippedVerdict(0, budgetChars, unclippedChars, withClips as [ClipRecord, ...ClipRecord[]]);
      return sizeOf(withCompleteness(candidate, verdict)) <= budgetChars;
    });
  }

  let chars = sizeOf(
    withCompleteness(
      working,
      clips.length === 0
        ? completeVerdict(0, budgetChars)
        : clippedVerdict(0, budgetChars, unclippedChars, clips as [ClipRecord, ...ClipRecord[]])
    )
  );
  if (chars > budgetChars) {
    const provisionalVerdict =
      clips.length === 0
        ? completeVerdict(chars, budgetChars)
        : clippedVerdict(chars, budgetChars, unclippedChars, clips as [ClipRecord, ...ClipRecord[]]);
    clips.push(irreducibleRecord(withCompleteness(working, provisionalVerdict), budgetChars));
    chars = sizeOf(
      withCompleteness(
        working,
        clippedVerdict(0, budgetChars, unclippedChars, clips as [ClipRecord, ...ClipRecord[]])
      )
    );
  }
  const completeness: Completeness =
    clips.length === 0
      ? completeVerdict(chars, budgetChars)
      : clippedVerdict(chars, budgetChars, unclippedChars, clips as [ClipRecord, ...ClipRecord[]]);
  return serialiseWithExactChars(working, completeness);
}
