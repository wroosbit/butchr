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
  readonly reduction: 'rows-summarised' | 'entries-omitted' | 'section-omitted';
  /** How many entries came back. `null` where the field is not a list. */
  readonly returned: number | null;
  /** How many exist. `null` where the field is not a list. */
  readonly total: number | null;
  /** How many did not come back. `null` where the field is not a list. */
  readonly omitted: number | null;
  /** The exact call that returns this field unreduced. */
  readonly readTheRest: string;
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
 * Fields that are never given up, at any budget.
 *
 * Each one answers "is the list above whole?" — the question this ticket is
 * about. Clipping the disclosure to make room for the thing it qualifies would
 * be the defect rebuilt with extra steps.
 */
export const NEVER_CLIPPED: readonly string[] = [
  'action',
  'success',
  'completeness',
  'agentsTotal',
  'standbyTotal',
  'censusUnreadableRecordsTotal',
  'censusUnreadableRecords',
  'missingAgents',
  'preemptedAgents'
];

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
 * The stub a dropped section leaves behind.
 *
 * A stub rather than a deletion, because a deleted key and a key this daemon
 * does not carry are the same absence — and this codebase already draws that
 * distinction everywhere else (`boardControl` is omitted when no reconciler is
 * wired, precisely so it cannot be read as "the reconciler says nothing").
 * Deleting for budget would collide with that meaning. The stub keeps them
 * apart: `omitted: 'for-budget'` is a field that exists and was not sent.
 */
function sectionStub(field: string, value: unknown, tool: string): Record<string, unknown> {
  const total = Array.isArray(value) ? value.length : null;
  return {
    omitted: 'for-budget',
    ...(total === null ? {} : { total }),
    chars: sizeOf(value),
    readWith: callRecipe(tool, `{ section: '${field}' }`)
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

  if (options.view === 'summary') {
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
      if (NEVER_CLIPPED.includes(field)) continue;
      const value = working[field];
      // A stub already stands here — the summary view emptied this field, or
      // the ladder has been walked twice by the re-fit backstop.
      if (isPlainObject(value) && value.omitted === 'for-budget') continue;
      takenBack.set(field, value);
      working = { ...working, [field]: sectionStub(field, value, tool) };
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
    clips.push({
      field: 'agents',
      reduction: 'rows-summarised',
      returned: rows.length,
      total: agentsTotal,
      // Zero, and that is the point of this rung: detail went, no agent did.
      omitted: 0,
      readTheRest: callRecipe(tool, `{ section: 'agents' }`)
    });
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
    working = { ...base, [section]: sectionStub(section, value, ctx.tool) };
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
    detail:
      `NOT WHOLE: ${unclippedChars} chars reduced to fit ${budgetChars}. ` +
      (lost > 0
        ? `${lost} list entr(ies) are absent — \`clipped\` names the field and the call that returns them.`
        : 'No entry was dropped; every agent is named, with less said about some.')
  };
}

/**
 * The universal backstop for every other tool on this server.
 *
 * WHAT IT IS NOT: the fitter above. It has no ladder, because it knows nothing
 * about the shape it is given — so it gives up whole top-level fields, largest
 * first, which is the only reduction that is safe on an unknown object and
 * still leaves valid JSON.
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
  options: { budgetChars?: number; tool: string }
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

  const clips: ClipRecord[] = [];
  let working: Record<string, unknown> = { ...response };
  const bySize = Object.keys(response)
    .filter((k) => !NEVER_CLIPPED.includes(k))
    .map((k) => [k, sizeOf((response as Record<string, unknown>)[k])] as const)
    .sort((a, b) => b[1] - a[1]);

  for (const [field] of bySize) {
    const provisional =
      clips.length === 0
        ? completeVerdict(0, budgetChars)
        : clippedVerdict(0, budgetChars, unclippedChars, clips as [ClipRecord, ...ClipRecord[]]);
    if (sizeOf(withCompleteness(working, provisional)) <= budgetChars) break;
    const value = working[field];
    working = { ...working, [field]: sectionStub(field, value, options.tool) };
    clips.push({
      field,
      reduction: 'section-omitted',
      returned: Array.isArray(value) ? 0 : null,
      total: Array.isArray(value) ? value.length : null,
      omitted: Array.isArray(value) ? value.length : null,
      readTheRest: `not paginated on ${options.tool}; narrow the request instead`
    });
  }

  const chars = sizeOf(
    withCompleteness(
      working,
      clips.length === 0
        ? completeVerdict(0, budgetChars)
        : clippedVerdict(0, budgetChars, unclippedChars, clips as [ClipRecord, ...ClipRecord[]])
    )
  );
  const completeness: Completeness =
    clips.length === 0
      ? completeVerdict(chars, budgetChars)
      : clippedVerdict(chars, budgetChars, unclippedChars, clips as [ClipRecord, ...ClipRecord[]]);
  return serialiseWithExactChars(working, completeness);
}
