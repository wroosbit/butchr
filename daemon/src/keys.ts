/**
 * How a workspace key is spelled where somebody reads it.
 *
 * WHY THIS MODULE EXISTS (KAN-229)
 *
 * `renderedKey` was born in board-reconcile.ts, next to the two surfaces KAN-225
 * was filed for. A third surface then turned up in nudge.ts, and the notifier
 * has no business importing the board reconciliation loop to borrow one regex —
 * board-reconcile.ts pulls in jira.js and the Atlassian integration, none of
 * which the supervision sweep needs or should be made to load. The alternative
 * was to copy the rule, which is what this ticket family exists to stop: KAN-225
 * settled on *one rule, one helper*, and a helper that lives in a consumer is a
 * helper waiting to be copied.
 *
 * So the rule moved down rather than sideways. This module depends on nothing —
 * it is the spelling rule and its regex, and every surface that renders a key
 * reads it from here.
 *
 * NOT EVERY SURFACE YET, AND THE EXCEPTION IS NAMED RATHER THAN LEFT TO BE FOUND
 *
 * `jira-poll.ts` still holds its own copy of the `JIRA_KEY` regex, and prints an
 * unnormalised key in two of its log lines. KAN-229 found that while re-checking
 * the claims it inherited and deliberately did not fix it: widening a PR in
 * review to reach a fourth surface is the churn this ticket family keeps
 * refusing. It is **KAN-232**, and that ticket owns the decision about whether
 * the second regex collapses into this one.
 */

/**
 * What a Jira issue key looks like, so a `shell` or `confluence` workspace is
 * out of scope.
 *
 * Anchored and upper-case-only by construction: it is applied to an
 * already-upper-cased candidate, so a lower-cased key is Jira-shaped to it only
 * after {@link renderedKey} has considered upper-casing it.
 */
export const JIRA_KEY = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * A key spelled the way the board spells it, for anything a reader will read.
 *
 * WHY A RENDERING HELPER AND NOT A CORRECTION AT THE SOURCE (KAN-225)
 *
 * A running agent's `key` is parsed back out of its herdr pane name, and
 * `agentNameFor` lower-cases it — so an agent read off a census is `kan-500`,
 * and a sentence telling somebody to *"move kan-500 out of those statuses"*
 * names nothing that exists on any board.
 *
 * The reflex fix is to correct the key where it is produced, or to drop agents
 * the durable registry cannot spell for us. **Both are wrong, and the second is
 * dangerous.** `inJurisdiction` answers one question — could this query ever
 * have described this agent? — and it deliberately does not ask whether this
 * daemon happens to hold a registry record. If it did, an agent this daemon
 * never started would become invisible to the reconciler's stand-down step:
 * running, Jira-shaped, not on the board, and unstoppable by the loop forever.
 * That is a silent, unbounded hole in *"anything running that is not in that
 * list → off"*, traded for a visible cosmetic one. The `.toUpperCase()` in
 * `inJurisdiction` is doing its job — it makes the loop *see* `kan-500` as the
 * Jira key it is. The source is correct; only the rendering was not, so only the
 * rendering is fixed.
 *
 * WHY THE GUARD, WHEN SOME CALLERS HAVE ALREADY FILTERED
 *
 * board-control.ts calls this on agents that have already passed
 * `inJurisdiction`, so everything it asks about is Jira-shaped by construction
 * and the test below is redundant there. `address()` in board-reconcile.ts and
 * `spelling()` in nudge.ts are the callers that make the guard load-bearing:
 * both render arbitrary agents, **including out-of-jurisdiction ones**, so
 * `confluence/123456789` and `task/scratch` reach them and must come back
 * untouched rather than mangled into looking like tickets. One helper, several
 * callers, only one of them pre-filtered — so it is written to be safe for the
 * unfiltered ones.
 *
 * WHY IT NORMALISES A LOOKUP'S RESULT AND NOT JUST A FALLBACK (KAN-229)
 *
 * Because the registry's own spelling is not trustworthy either, which is the
 * thing KAN-229 was filed believing the opposite of. `handleActivateByKey`
 * records the key its caller passed, verbatim and unnormalised, so a supervisor
 * that staffs `task/kan-500` puts `kan-500` into the durable registry *with* a
 * supervisor of record attached — and `recordedKeyFor` then hands that spelling
 * to a reader with the lookup having succeeded. A helper wrapped around only the
 * `?? key` fallback would not have caught it. Wrap the whole expression.
 *
 * A key that is Jira-shaped is returned upper-cased, which for anything the
 * {@link JIRA_KEY} test accepts is exactly how Jira spells it. Everything else
 * is returned exactly as it arrived.
 */
export function renderedKey(key: string): string {
  const upper = key.trim().toUpperCase();
  return JIRA_KEY.test(upper) ? upper : key;
}
