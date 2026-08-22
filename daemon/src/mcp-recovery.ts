/**
 * KAN-501: what a clipped answer can honestly tell its caller to do next.
 *
 * THE DEFECT THIS EXISTS TO END. `mcp-response-budget.ts` replaced an
 * over-budget field with a stub carrying a recovery recipe, and the recipe was
 * built from the calling tool's **name**:
 *
 *     readWith: "atlassian_get_issue_comments({ section: 'body' })"
 *
 * There is no `section` parameter on that tool, or on any of the other
 * forty-odd this server carries. Exactly one — `butchr_list_agents` — advertises
 * one and honours it, and the recipe was written for that tool and then emitted
 * for every tool. Measured on the fleet's daemon by `task/KAN-420` (2026-08-16),
 * `epic/KAN-39` (2026-08-17) and `epic/KAN-203` (2026-08-18): the printed call
 * cannot be typed, and calling it with `section` anyway returns the identical
 * clipped answer, because the parameter is not in the schema to be refused.
 *
 * WHY IT IS ITS OWN MODULE RATHER THAN A FUNCTION IN `mcp.ts`. Because a check
 * has to be able to import it. `mcp.ts` starts an MCP server on import, so
 * anything living there can only be tested by a copy of itself living in the
 * test — which is the KAN-145 hole exactly: two artifacts that agree with each
 * other and neither of which is what runs. `verify-clip-recipes-are-executable.mjs`
 * imports THIS file and checks what it emits against the schemas the tools
 * actually advertise.
 *
 * WHAT THIS RETURNED NOTHING OF UNTIL KAN-656: a `call` recovery. The reason
 * was true when it was written — no proxied operation had a parameter that
 * returned one field of a response on its own, so there was no call to print,
 * and printing one anyway is the whole of KAN-501.
 *
 * ⚠ THAT IS NOW TRUE OF EVERY FIELD BUT ONE. `atlassian_get_issue_description`
 * (KAN-656) is the first operation on the table whose entire job is to return
 * one field — a description — a window at a time, by character offset. So a
 * clipped description is the one case where this module can print a call, and
 * it must: the alternative is the `noWayBack` that left an agent unable to read
 * the ticket it was staffed for.
 *
 * The bar has not moved, only the fact it was applied to. A `call` is emitted
 * here **only where the named operation is on the table and advertises every
 * parameter the recipe types** — checked below rather than trusted, and checked
 * again by `verify-clip-recipes-are-executable.mjs` against the schemas the
 * client is actually sent. A recipe that cannot be typed is still the defect.
 */

import { operationByTool } from './atlassian-proxy.js';
import { ldOperationByTool } from './launchdarkly-proxy.js';
import { Recovery } from './mcp-response-budget.js';

/**
 * The parameters a tool actually advertises, or `null` where this process
 * cannot say (KAN-501).
 *
 * READ OFF THE SAME OBJECT THE CLIENT IS ADVERTISED, which is the whole
 * argument for this function existing rather than a list of parameter names
 * kept beside it. The defect this file is fixing was a recipe *derived from a
 * tool's name* — `<tool>({ section: '<field>' })` — which was true of one tool
 * and false of the forty-odd proxied ones. A second hand-maintained list would
 * have been the same mistake with an extra step: correct on the day it was
 * written and silently wrong the first time an operation's schema moved.
 *
 * `null` for the daemon-native tools, whose schemas are literals inside the
 * listing handler below rather than a table this can index. That is not a gap
 * that matters: `null` means *say nothing about parameters*, and a stub that
 * names no parameter cannot name a wrong one.
 */
export function advertisedParams(tool: string): string[] | null {
  const op = operationByTool(tool) ?? ldOperationByTool(tool);
  if (!op) return null;
  const props = (op.inputSchema as any)?.properties;
  return props && typeof props === 'object' ? Object.keys(props) : null;
}

/**
 * Parameters that make a response *smaller* when a caller reaches for them.
 *
 * A FILTER OVER REAL PARAMETERS, NEVER A SOURCE OF THEM. Every name here is
 * intersected with what {@link advertisedParams} read off the tool's own
 * schema, so a name that is wrong, renamed or removed drops out rather than
 * being printed at somebody. That property is what makes a hand-written set
 * safe here and is why it must stay a filter: the moment it is used to *emit* a
 * name, this is the original defect again.
 */
export const NARROWING_PARAMS = new Set(['maxResults', 'limit', 'startAt', 'cursor', 'fields', 'bodyFormat']);

/**
 * The operation that returns a description one window at a time (KAN-656).
 *
 * Named once, here, so that the recipe below and the guard that checks it
 * cannot drift apart into two spellings of one tool name.
 */
const DESCRIPTION_PAGER = 'atlassian_get_issue_description';

/**
 * The parameters {@link descriptionRecovery} types into its recipe.
 *
 * A recipe is only printed when the pager advertises all of these, so a
 * renamed or removed parameter turns the recovery back into an honest `none`
 * rather than into an instruction that cannot be typed. That is the same
 * property {@link NARROWING_PARAMS} has and it is here for the same reason:
 * this file's whole subject is a recipe that was true of the tool it was
 * written for and false of the tools it was emitted for.
 */
const DESCRIPTION_PAGER_PARAMS = ['issueKey', 'startAt', 'maxResults'] as const;

/**
 * The smallest window a narrowing recipe will ask for (KAN-656).
 *
 * A recipe that halves the window each time has to stop somewhere, and it must
 * stop at a size that can still carry text rather than at 1: a floor of one
 * character would produce a recipe technically executable and practically a
 * walk of ten thousand calls. 256 is below the smallest window measured to fit
 * at `MIN_BUDGET_CHARS` and far above useless.
 */
const DESCRIPTION_MIN_WINDOW = 256;

/**
 * The shape an issue key has to have before it is printed into a recipe.
 *
 * ⚠ THE KEY REACHING THIS MODULE IS THE CALLER'S RAW ARGUMENT, NOT A VALIDATED
 * ONE. `atlassian-proxy.ts` validates `issueKey` inside each operation's
 * `build`, and this runs off the arguments the tool was CALLED with — so a
 * value that never survived `build` still arrives here. Interpolating one
 * unchecked would put a quote or a brace into the middle of a printed call and
 * produce a recipe that cannot be typed, which is the precise defect this file
 * exists to end, reintroduced by the code fixing it.
 *
 * Anything that is not a key gets NO recipe rather than a broken one, which is
 * the same direction every other unestablished fact takes here.
 */
const JIRA_KEY_SHAPE = /^[A-Z][A-Z0-9]*-\d+$/;

/**
 * Whether this clipped path is a description, and therefore recoverable.
 *
 * MATCHED ON THE FIELD NAME AT THE END OF THE PATH, because that is the only
 * thing the fitter knows about it. The paths this actually meets are
 * `body.fields` (the issue read, where `description` is one of several fields
 * inside), `body.issues` (the search) and `body.text` (the pager's own answer
 * clipped further at a lowered budget). ⚠ THE FIRST TWO ARE NOT DESCRIPTIONS —
 * they are containers a description was inside — which is why this is not
 * enough on its own and {@link descriptionRecovery} also requires an issue key
 * it can actually name. A recipe naming no issue is not typeable.
 */
/**
 * What the call being clipped asked for, so far as a recipe needs it (KAN-656).
 *
 * Only the three the pager takes. It is deliberately NOT the whole argument
 * object: a recovery recipe is printed into a response that other agents read,
 * so what reaches this function should be the fields it will actually type and
 * nothing it might accidentally echo.
 */
export type DescriptionCall = {
  readonly issueKey?: string | null;
  readonly startAt?: number | null;
  readonly maxResults?: number | null;
};

function looksLikeDescription(path: string): boolean {
  const leaf = path.split('.').pop() ?? path;
  return leaf === 'description' || leaf === 'text' || leaf === 'fields' || leaf === 'issues';
}

/**
 * Whether a clip on THIS tool is recoverable by asking for a smaller window.
 *
 * ⚠ ON THE PAGER ITSELF, THE PATH DOES NOT MATTER AND MUST NOT BE CONSULTED.
 * Everything `atlassian_get_issue_description` returns is one description, so
 * whatever the fitter gave up, a narrower `maxResults` is the answer. Keying off
 * the path there is a bug that only shows at a low budget: the fitter stubs
 * `body.text` first, is STILL over, and the backstop then replaces the whole
 * `body` — whose path is `body`, matching no description-shaped name, so the
 * recipe vanished at exactly the budget where the reader needed it most.
 * Measured at `MIN_BUDGET_CHARS`: the walk stranded on a stub carrying
 * `noWayBack`, which is this ticket rebuilt one turn deeper.
 *
 * Off the pager, the path IS the only signal there is — a clipped
 * `atlassian_get_issue` names a description only through `body.fields` — so the
 * two arms genuinely differ rather than one being a relaxation of the other.
 */
function clipIsRecoverableHere(tool: string, path: string): boolean {
  return tool === DESCRIPTION_PAGER || looksLikeDescription(path);
}

/**
 * The one real recovery this module can offer, or `null` where it cannot.
 *
 * ⚠ RETURNS `null` RATHER THAN A RECIPE WHENEVER ANYTHING IS UNESTABLISHED —
 * the pager missing from the table, a parameter missing from its schema, or no
 * issue key to name. Every one of those would produce a recipe that reads
 * correctly and cannot be executed, which is precisely the failure this file
 * exists to end, and "no recipe" degrades to the honest sentence below rather
 * than to a wrong one.
 */
function descriptionRecovery(
  tool: string,
  path: string,
  call: DescriptionCall | null
): Recovery | null {
  if (!call?.issueKey || !clipIsRecoverableHere(tool, path)) return null;
  const key = call.issueKey.trim().toUpperCase();
  if (!JIRA_KEY_SHAPE.test(key)) return null;
  const pagerParams = advertisedParams(DESCRIPTION_PAGER);
  if (pagerParams === null) return null;
  if (!DESCRIPTION_PAGER_PARAMS.every((p) => pagerParams.includes(p))) return null;

  // ⚠ THE READER'S PLACE IS KEPT, AND THIS IS THE HALF THAT IS EASY TO GET
  // WRONG. A recipe that always said `startAt: 0` would be executable, would
  // look correct, and would send a caller who is 6,000 characters into a
  // description back to the beginning — where the same window would fail the
  // same way, forever. So the offset carried here is the one that was ASKED
  // for, and only the window narrows.
  const startAt = Number.isFinite(call.startAt) && (call.startAt as number) > 0
    ? Math.floor(call.startAt as number)
    : 0;

  // Half of what was asked for, floored — the same halving a caller would do by
  // hand, printed so they do not have to guess how much smaller is small enough.
  const asked = Number.isFinite(call.maxResults) && (call.maxResults as number) > 0
    ? Math.floor(call.maxResults as number)
    : null;
  const narrowed = asked === null
    ? DESCRIPTION_MIN_WINDOW
    : Math.max(DESCRIPTION_MIN_WINDOW, Math.floor(asked / 2));

  return {
    kind: 'call',
    call:
      `${DESCRIPTION_PAGER}({ issueKey: '${key}', startAt: ${startAt}, ` +
      `maxResults: ${narrowed} })`
  };
}

/**
 * What a clipped answer can honestly offer a caller of this tool.
 *
 * WHAT IT RETURNS A `call` FOR, AND ONLY THIS: a description, where an issue
 * key is known and `atlassian_get_issue_description` is on the table with the
 * parameters the recipe types (KAN-656). Everywhere else the answer is still a
 * sentence naming the levers that exist — and, where the answer is genuinely
 * "none", saying that rather than implying otherwise.
 *
 * `issueKey` is optional and defaults to nothing on purpose: a caller that
 * cannot say which issue was being read gets the honest sentence, never a
 * recipe with a hole where the key should be.
 */
export function genericRecovery(
  tool: string,
  path: string,
  call?: DescriptionCall | string | null
): Recovery {
  // A bare string is accepted as the issue key so that the common call site
  // stays one argument, and so that the shape this took before the narrowing
  // recipe existed keeps working rather than silently passing `undefined`.
  const context: DescriptionCall | null =
    typeof call === 'string' ? { issueKey: call } : (call ?? null);
  const real = descriptionRecovery(tool, path, context);
  if (real) return real;

  // NO KEY TO NAME, BUT A ROUTE THAT EXISTS — the search case (KAN-656).
  // `atlassian_search_issues` is called with a JQL and not an issue key, so
  // nothing here can build a typeable recipe; what it must NOT do is go on
  // saying "no value of any of them returns it here", which was true until this
  // ticket and is now false. So the route is NAMED and the caller is told what
  // it has to supply. That is a `none` and not a `call` deliberately: a recipe
  // with a placeholder where an argument goes is not executable as printed,
  // which is the one property this module exists to keep.
  const routeForDescription =
    clipIsRecoverableHere(tool, path) && advertisedParams(DESCRIPTION_PAGER) !== null
      ? ` A description larger than the budget is reachable a window at a time through ` +
        `${DESCRIPTION_PAGER}, which needs the issue key — this call did not name one.`
      : '';

  const params = advertisedParams(tool);
  const levers = (params ?? []).filter((p) => NARROWING_PARAMS.has(p));
  if (levers.length === 0) {
    return {
      kind: 'none',
      why:
        `${tool} takes no parameter that returns "${path}" on its own, and none that ` +
        'narrows this answer. What is here is what this call can say.' +
        routeForDescription
    };
  }
  return {
    kind: 'none',
    why:
      `${tool} has no parameter that returns "${path}" on its own. Ask for less with ` +
      `${levers.map((p) => `\`${p}\``).join(' or ')} — and note that a single entry can ` +
      'exceed the budget by itself, in which case no value of any of them returns it here.' +
      routeForDescription
  };
}

