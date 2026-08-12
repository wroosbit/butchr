/**
 * Whether a URL is a Jira **board** page — the surface the guardian is shown on.
 *
 * WHY THIS IS ITS OWN MODULE, AND WHY THE EXTENSION HAS NO COPY OF IT (KAN-284)
 *
 * The human asked for the guardian to be visible on the board: *"on
 * https://wroosbit.atlassian.net/jirKAN/boards/2?filter=&groupBy=none it should
 * show whatever the guardian agent is."*
 *
 * The obvious shape is a matcher in the extension, next to the thing that
 * renders. That shape is wrong here, and the reason is KAN-145's defect rather
 * than taste: **one fact with two implementations, where the copy nobody routes
 * on is the one that stays wrong.** The daemon already decides what a URL is —
 * `WorkspaceRegistry.resolve` is the only thing entitled to an opinion, and
 * `board-control.ts` records in its own header why the extension deliberately
 * does not re-derive jurisdiction locally: *"Those four lines would be a second
 * copy of the daemon's rule, and it would drift."*
 *
 * So the daemon answers *"this is a board page, and here is the guardian"* on
 * `status_response`, and **the extension holds no pattern at all** — it renders
 * what it is told. There is exactly one board matcher in this repository and it
 * is below.
 *
 * ---------------------------------------------------------------------------
 * THE PATH, CONFIRMED AGAINST A LIVE BOARD RATHER THAN INFERRED
 * ---------------------------------------------------------------------------
 *
 * The link arrived mangled — `.../jirKAN/boards/2?filter=&groupBy=none` — and
 * KAN-284 is explicit that a matcher must not be written against it. The
 * canonical form was resolved on 2026-08-11 by asking the site itself:
 *
 *   GET https://wroosbit.atlassian.net/secure/RapidBoard.jspa?rapidView=2
 *   → 302 https://wroosbit.atlassian.net/jira/software/projects/KAN/boards/2
 *
 * That also explains the mangling exactly, which is the corroboration worth
 * having: `/jira/software/projects/KAN/` less `a/software/projects/` is
 * `/jirKAN/`. One contiguous span was lost in transit and the rest is intact.
 *
 * ---------------------------------------------------------------------------
 * VIEW STATE IS IGNORED, AND THAT IS THE WHOLE REASON THIS MATCHES A PATH
 * ---------------------------------------------------------------------------
 *
 * `filter`, `groupBy`, `assignee` and friends change as a human *uses* the page.
 * A matcher keyed on the full URL — or on a query string — makes the guardian
 * display vanish the moment somebody groups or filters the board, which is
 * precisely when they are looking hardest at it. So the query string is not
 * consulted at all, and neither is the fragment.
 *
 * ---------------------------------------------------------------------------
 * THIS DOES NOT MAKE A BOARD URL A WORKSPACE — INVARIANT 6
 * ---------------------------------------------------------------------------
 *
 * *"A board URL is not a workspace, and everything that does match degrades to
 * `task` within ~2s."* `MessageRouter.handleStatus` implements it and answers
 * `supported: false` — *"the page is not a workspace right now"*.
 *
 * **Displaying on a board page is rendering, not binding.** Nothing here is
 * consulted by `WorkspaceRegistry.resolve`, this module is never reached from
 * the resolution path, and `handleStatus` attaches the guardian block **inside
 * the branch that has already answered `supported: false`** — after the
 * decision, never before it and never able to change it. A board page must
 * still resolve to *not a workspace* afterwards, and
 * `verify-guardian-board-display.mjs` asserts that rather than assuming it.
 *
 * The hazard KAN-284 names is the one to keep in view: **do not "fix" a display
 * that is not appearing by making the board resolve to something.** That trades
 * an invariant for a UI nicety, and the trade is invisible afterwards.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DELIBERATELY DOES NOT MATCH
 * ---------------------------------------------------------------------------
 *
 * A board URL carrying `selectedIssue=KAN-1` **is** a workspace — the third of
 * `atlassianWorkspaceTypes`'s `task` patterns matches it, and it has done since
 * long before this ticket. That page resolves to a task, `handleStatus` never
 * reaches its unsupported branch, and the guardian block is never attached. That
 * is correct and is not a gap: the sidepanel on that page is a terminal for a
 * real agent, and displacing it with a fleet-wide notice would be worse than
 * showing nothing.
 */
/**
 * The canonical board path, matched with the query string and fragment removed.
 *
 * Both the team-managed form (`/jira/software/projects/KAN/boards/2`) and the
 * company-managed one (`/jira/software/c/projects/KAN/boards/2`) are accepted.
 * This project is team-managed — `simplified: true` — so only the first occurs
 * here today; the second is included because the difference is invisible from a
 * URL a human pastes, and a matcher that silently covers one kind of Jira
 * project is the sort of absence that looks exactly like a bug in the display.
 *
 * `boards/(\d+)` rather than `boards/` so that a trailing path segment cannot
 * drift the match onto something that is not a board.
 */
const BOARD_PATH = /^\/jira\/software\/(?:c\/)?projects\/([A-Z0-9]+)\/boards\/(\d+)\/?$/i;
/**
 * The older board URL, which is still what several links in the wild point at.
 *
 * `/secure/RapidBoard.jspa?rapidView=2` **302s** to the canonical form — that is
 * how the canonical form was established above — so a browser sitting on one has
 * already been moved off it, and this is matched for the sake of the moment
 * before the redirect completes rather than as a supported address.
 */
const RAPID_BOARD_PATH = /^\/secure\/RapidBoard\.jspa$/i;
/**
 * Is this a Jira board page?
 *
 * Returns null for everything else, including a board URL with an issue
 * selected — see the header. Never throws: it is called on whatever string a
 * browser tab happens to hold, and an unparseable URL is simply not a board.
 */
export function boardPageFor(url) {
    if (typeof url !== 'string' || !url)
        return null;
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    // Only the two Atlassian schemes a browser can actually be on. A `file://`
    // path that happened to contain the board path would otherwise match.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        return null;
    // THE PATH ONLY. `parsed.pathname` excludes the query and the fragment, which
    // is what makes `?filter=&groupBy=none` — and every other view state a human
    // produces by using the page — invisible to this decision. See the header.
    const match = parsed.pathname.match(BOARD_PATH);
    if (match) {
        return { projectKey: match[1].toUpperCase(), boardId: match[2] };
    }
    if (RAPID_BOARD_PATH.test(parsed.pathname)) {
        return { projectKey: null, boardId: parsed.searchParams.get('rapidView') };
    }
    return null;
}
