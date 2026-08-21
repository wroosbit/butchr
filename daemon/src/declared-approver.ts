/**
 * ---------------------------------------------------------------------------
 * WHO A PULL REQUEST SAYS APPROVES IT (KAN-600)
 * ---------------------------------------------------------------------------
 *
 * `prompts/task.md` requires every pull request to carry, on a line of its own
 * in its body:
 *
 *     BUTCHR-APPROVER: epic/KAN-39
 *
 * That line is the fleet's *declaration* of who may approve, and it is what the
 * required `approval-recorded` gate checks a marker against. It is **declared,
 * not derived**: nothing on the Jira board produces it, so it does not have to
 * agree with the board, and measured across the four pull requests open on
 * 2026-08-21 it did not — one named the epic its ticket sits under, one named a
 * story that is the *supervisor* of the agent that opened it, and one named an
 * epic in a different project from the repository it was raised against.
 *
 * WHY THE DAEMON NEEDS TO READ IT. `pr-watch.ts` routes its notices by an
 * agent's **board relation** to the ticket — `own` / `supervisor` / `parent` /
 * `linked`. Two of those three declared shapes are muted for `green-idle`, the
 * one event kind that exists to say *"this is green and nobody is merging it"*.
 * So the event reached everybody except the one agent who could act on it. See
 * the KAN-600 block in `pr-watch.ts` for the measured instance.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE SECOND SPELLING OF A GRAMMAR THE GATE ALREADY OWNS
 * ---------------------------------------------------------------------------
 *
 * `daemon/scripts/lib/approval-marker.mjs` has parsed this line since KAN-306,
 * and has known since KAN-321 that a body which *shows* the line — inside a
 * fenced code block, a blockquote, an indented block or an HTML comment — has
 * not *said* it. A gate that read a demonstration as a declaration went green on
 * #139 fifteen seconds after somebody pasted an example of the convention.
 *
 * That library cannot be imported here: it is a `.mjs` with no declarations,
 * under `daemon/scripts` rather than `daemon/src`, and it is loaded by CI from a
 * checkout that has no `dist`. So this is a deliberate second implementation,
 * and **the drift it invites is closed by a check rather than by a comment**:
 * `daemon/scripts/verify-declared-approver-parity.mjs` drives both this module
 * and that library over one corpus and fails if any body gets two answers.
 * Adding a case to one and not the other is a red check, not a surprise later.
 *
 * IT FAILS CLOSED IN BOTH DIRECTIONS, AND THE TWO ARE DIFFERENT FAILURES.
 * Reading a shown line as a declaration would route a notice at whoever the
 * example named. Reading a real declaration as shown returns `null`, and the
 * caller then falls back to the board relation it used before this existed —
 * which is the behaviour of the day before yesterday rather than a silence.
 */

/** The contexts in which a Markdown body displays or hides a line. */
export const QUOTED_AS = {
  FENCED_CODE: 'a fenced code block',
  INDENTED_CODE: 'an indented block',
  BLOCKQUOTE: 'a blockquote',
  HTML_COMMENT: 'an HTML comment'
} as const;

/**
 * How a body carried a line it did not assert, or `null` for a line spoken in
 * the body's own voice.
 *
 * A union of the four literals rather than `string`, so a caller cannot invent
 * a fifth context and a `switch` over them is exhaustive — the type carrying
 * what an assertion elsewhere would have to check. `prompts/task.md`: prefer
 * the type where the invariant is about what the code is able to say.
 */
export type QuotedAs = (typeof QUOTED_AS)[keyof typeof QUOTED_AS] | null;

/** An opening fence may carry an info string; a closing one may not. */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const BLOCKQUOTE = /^ {0,3}>/;
const INDENTED = /^(?: {4,}|\t)/;

/**
 * The declaration, as the gate spells it.
 *
 * Not global, and case-insensitive, exactly as `approval-marker.mjs` has it —
 * the parity check is what holds the two identical, so a "harmless" tightening
 * here goes red rather than quietly disagreeing with the gate about who may
 * approve a pull request.
 */
const DECLARED = /^[ \t]*BUTCHR-APPROVER:[ \t]+(\S+)[ \t]*$/im;

/**
 * Label every line of `body` with the context that displays or hides it.
 *
 * A line-for-line port of `scanQuoted` in `approval-marker.mjs`, including its
 * stated bluntness about indentation: a four-space-indented line under a list
 * item renders inline rather than as code, and this calls it quoted anyway.
 * That is fail-closed and is noted so nobody reads the labels as a claim about
 * how GitHub renders the body.
 */
export function scanQuoted(body: string | null | undefined): QuotedAs[] {
  const lines = String(body ?? '').split(/\r?\n/);
  const out: QuotedAs[] = new Array(lines.length).fill(null);
  let fence: { char: string; len: number } | null = null;
  let html = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Inside a fence nothing else can start: a `>` or a `<!--` in there is
    // being shown. An unclosed fence runs to the end of the body, which is
    // CommonMark's rule and also the fail-closed direction.
    if (fence) {
      out[i] = QUOTED_AS.FENCED_CODE;
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }

    if (html) {
      out[i] = QUOTED_AS.HTML_COMMENT;
      if (line.includes('-->')) html = false;
      continue;
    }

    // A fence closes only on the SAME character at the SAME length or longer,
    // which is what makes a ``` inside a ```` block content rather than a
    // terminator — the shape a worked example of this convention is written in.
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      out[i] = QUOTED_AS.FENCED_CODE;
      continue;
    }

    if (BLOCKQUOTE.test(line)) {
      out[i] = QUOTED_AS.BLOCKQUOTE;
      continue;
    }

    if (INDENTED.test(line)) {
      out[i] = QUOTED_AS.INDENTED_CODE;
      continue;
    }

    // A complete `<!-- … -->` on one line opens nothing. Anything left after
    // removing those pairs runs on to a later line — and a declaration nobody
    // can see is the same defect as one that is merely shown.
    if (line.replace(/<!--[\s\S]*?-->/g, '').includes('<!--')) {
      out[i] = QUOTED_AS.HTML_COMMENT;
      html = true;
    }
  }

  return out;
}

/**
 * `body` with every displayed or hidden line blanked, keeping the line count so
 * that "a line of its own" still means the same lines it does to a reader.
 */
export function assertedText(body: string | null | undefined): string {
  const lines = String(body ?? '').split(/\r?\n/);
  const quoted = scanQuoted(body);
  return lines.map((line, i) => (quoted[i] ? '' : line)).join('\n');
}

/**
 * The approver a pull request body ASSERTS, as the `<type>/<KEY>` string it
 * wrote, or `null` where it declares nobody.
 *
 * Returned verbatim rather than normalised, because this value is quoted into a
 * log line and into a notice: `epic/KAN-39` and `Epic/kan-39` are the same
 * agent to {@link declaresApprover} and two different things a body might have
 * been trying to say, and the reader of a red line needs the second.
 */
export function declaredApproverOf(body: string | null | undefined): string | null {
  const m = DECLARED.exec(assertedText(body));
  return m ? m[1] : null;
}

/**
 * Whether a declaration names this agent.
 *
 * Case-insensitive on both halves, because the fleet writes an agent's address
 * both ways and both are the same agent: `butchr_list_agents` answered
 * `task/KAN-552` and `task/kan-519` in one census on 2026-08-21, and a
 * case-sensitive comparison here would have routed one of them and not the
 * other for a reason nobody would ever have guessed from the log.
 */
export function declaresApprover(
  declared: string | null | undefined,
  agent: { type?: string; key?: string }
): boolean {
  if (!declared) return false;
  const slash = declared.indexOf('/');
  if (slash <= 0 || slash === declared.length - 1) return false;
  return (
    declared.slice(0, slash).toLowerCase() === String(agent.type ?? '').toLowerCase() &&
    declared.slice(slash + 1).toUpperCase() === String(agent.key ?? '').toUpperCase()
  );
}
