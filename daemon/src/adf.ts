/**
 * Markdown → Atlassian Document Format, for the proxy's content writes
 * (KAN-293).
 *
 * ## WHY THIS FILE EXISTS AT ALL, MEASURED RATHER THAN ASSUMED
 *
 * Every write in KAN-293's slice carries a body — a comment, a description, a
 * page, a worklog note — and Atlassian's v3 Jira and v2 Confluence APIs want
 * that body as **ADF**, a JSON document tree. Something has to turn what an
 * agent writes into that tree. The official Atlassian MCP server will do it for
 * you if you pass `contentFormat: "markdown"`, and **that converter loses
 * content silently**, which is the single worst failure shape on this board.
 *
 * It is not a rumour and it is not inherited from a ticket. Measured against
 * this very site on 2026-08-12, before a line of this file was written:
 *
 * ```
 * sent (contentFormat: markdown)        stored (body.storage)
 * ─────────────────────────────────     ────────────────────────────────────
 * - ITEM-MARKER-CHARLIE                 <ul><li><p>SECOND-ITEM-ECHO</p></li></ul>
 *   > QUOTE-MARKER-DELTA
 * - SECOND-ITEM-ECHO
 * ```
 *
 * Two of the three markers are gone. **The whole first list item was dropped**,
 * not just the blockquote inside it, and the call returned success with a page
 * that reads as though it worked. That is Confluence page `5079041`, and it is
 * KAN-183's incident and KAN-266's incident reproduced on demand.
 *
 * The same nesting sent as **ADF** — `tableCell > bulletList > listItem >
 * blockquote` — round-tripped with every marker intact (page `5046273`). So the
 * loss is in the markdown converter and **not** in ADF: the target format can
 * represent the structure perfectly well. That is the whole argument for this
 * file. The proxy builds the tree itself and never asks the lossy path to do it.
 *
 * ## THE INVARIANT, AND WHY IT IS ENFORCED HERE RATHER THAN TESTED ELSEWHERE
 *
 * **No source text is ever dropped.** {@link markdownToAdf} extracts the word
 * tokens of its input, extracts the word tokens of the document it produced,
 * and throws if the second does not cover the first. A converter bug therefore
 * surfaces as a loud refusal at the moment of conversion rather than as a page
 * that is missing a paragraph nobody will notice for a week.
 *
 * It lives *inside* the converter deliberately. A check in a verify script only
 * covers the inputs that script thought of; this one covers every input any
 * agent ever sends, including the one nobody predicted — which, given the
 * defect above was found by nesting two ordinary markdown constructs, is the
 * case that matters. The verify script asserts the check itself works, which is
 * a different and smaller job.
 *
 * **This is a completeness guarantee, not a fidelity one.** It says every word
 * you wrote is in the document. It does not say the document is shaped the way
 * you imagined — a coercion (below) keeps the words and changes the container,
 * and that is a deliberate, reported outcome rather than a silent one.
 *
 * ## NESTING, AND THE THREE THINGS THAT CAN HAPPEN TO A NODE
 *
 * ADF constrains what may contain what, and the constraint is real: a document
 * violating it is rejected, or worse, accepted with the offending subtree
 * removed. {@link ALLOWED_CHILDREN} is this file's copy of the rules it needs,
 * every entry of which was either confirmed by the probe above or is a
 * restriction the official server's own tool description states.
 *
 * When a block lands somewhere it may not go, exactly one of three things
 * happens, and never a fourth:
 *
 *  1. **It is legal** — it is emitted as itself.
 *  2. **It is coerced** — a documented, content-preserving substitution, and a
 *     line is added to {@link AdfConversion.coercions} naming what changed.
 *     A heading inside a list item becomes a bold paragraph; its words survive.
 *  3. **There is no coercion** — {@link markdownToAdf} throws. It does not drop.
 *
 * Silence is not on that list, which is the entire point of the list.
 */

/** A node of an ADF document. Loose by design: this file builds them, and the shape is Atlassian's. */
export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

/** A whole ADF document, which is what every content write here sends. */
export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

/**
 * What a conversion produced, and what it had to change to produce it.
 *
 * `coercions` is empty for almost every real input. It is non-empty exactly
 * when case 2 above happened, and it is returned rather than logged so that the
 * caller can put it in front of the agent — an agent that wrote a heading in a
 * list item should be told its heading became bold text, at the time, rather
 * than discovering it on the page later.
 */
export interface AdfConversion {
  doc: AdfDoc;
  coercions: string[];
}

/**
 * Which product's validator this document has to satisfy.
 *
 * ## "ADF" IS NOT ONE FORMAT, AND THAT WAS MEASURED THE HARD WAY
 *
 * Jira and Confluence accept **different** ADF, and the difference is exactly
 * the nesting this ticket is about. Measured 2026-08-12, both against this site
 * with a real call:
 *
 * ```
 * blockquote inside a listItem  →  Confluence: stored intact
 *                               →  Jira:       400 {"comment":"INVALID_INPUT"}
 * ```
 *
 * Everything else that was in doubt is accepted by both: a top-level
 * blockquote, a list nested in a list item, a codeBlock in a list item, and a
 * blockquote in a *table cell*. So the divergence is one cell of one table, and
 * a converter that assumed "ADF is ADF" would work perfectly against Confluence
 * and fail every Jira comment carrying a quoted bullet.
 *
 * **It was found by making the call.** Nothing in Atlassian's documentation,
 * and nothing in the official MCP server's own nesting guidance, distinguishes
 * the two — that guidance says list items cannot contain
 * "headings/tables/panels/expands" and does not mention blockquote at all,
 * which is right for Confluence and wrong for Jira.
 */
export type AdfTarget = 'jira' | 'confluence';

/**
 * Which block types may appear inside which container, per product.
 *
 * Sources, in order of authority: **real calls** against both products for
 * `listItem > blockquote` (see {@link AdfTarget}), and the official Atlassian
 * MCP server's own stated nesting rules for the rest — *"list items cannot
 * contain headings/tables/panels/expands; table cells can contain headings,
 * panels, lists, media, blockquote … but not nested tables"*.
 *
 * The two tables differ in **one entry**, and it is written out in full rather
 * than expressed as a diff from a shared base: a reader asking "what may go in
 * a Jira list item" should get the answer from one line, not from one line
 * minus another line somewhere else.
 */
const ALLOWED_CHILDREN: Record<AdfTarget, Record<string, readonly string[]>> = {
  confluence: {
    doc: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'table', 'rule'],
    listItem: ['paragraph', 'bulletList', 'orderedList', 'blockquote', 'codeBlock'],
    blockquote: ['paragraph', 'bulletList', 'orderedList', 'codeBlock'],
    tableCell: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule'],
    tableHeader: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule']
  },
  jira: {
    doc: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'table', 'rule'],
    // No `blockquote`. This is the measured difference, and the whole reason
    // this table is keyed by product.
    listItem: ['paragraph', 'bulletList', 'orderedList', 'codeBlock'],
    blockquote: ['paragraph', 'bulletList', 'orderedList', 'codeBlock'],
    tableCell: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule'],
    tableHeader: ['paragraph', 'heading', 'bulletList', 'orderedList', 'blockquote', 'codeBlock', 'rule']
  }
};

/**
 * How an illegal placement is repaired without losing a word.
 *
 * Keyed `parent>child`. A placement with no entry here is not repairable by
 * this file, and {@link markdownToAdf} throws rather than guess — see case 3 in
 * the module header.
 *
 * Each entry is content-preserving by construction: it changes the container
 * and re-parents the children, never discards them.
 */
const COERCIONS: Record<string, { to: string; why: string }> = {
  // Jira only — Confluence's table above permits this nesting, so this entry is
  // never reached for a Confluence document. `unwrap` keeps the blockquote's
  // own blocks and drops only the quote wrapper, so every word survives and the
  // bullet still reads as a bullet with a second paragraph under it.
  'listItem>blockquote': {
    to: 'unwrap',
    why:
      "Jira's ADF validator rejects a blockquote inside a list item (400 INVALID_INPUT), " +
      'unlike Confluence which accepts it; the quoted text is kept as ordinary blocks in the ' +
      'same list item'
  },
  'listItem>heading': {
    to: 'paragraph',
    why: 'ADF list items cannot contain headings; emitted as a bold paragraph with the same text'
  },
  'blockquote>heading': {
    to: 'paragraph',
    why: 'ADF blockquotes cannot contain headings; emitted as a bold paragraph with the same text'
  },
  'tableCell>table': {
    to: 'blockquote',
    why: 'ADF table cells cannot contain a nested table; its cells are emitted as quoted paragraphs'
  },
  'tableHeader>table': {
    to: 'blockquote',
    why: 'ADF table cells cannot contain a nested table; its cells are emitted as quoted paragraphs'
  }
};

/**
 * Which marks may sit on the same text node as another, per product.
 *
 * ## THE SECOND HALF OF KAN-502, AND WHY IT IS KEYED BY PRODUCT
 *
 * A code span inside bold — `` **bold wrapping `inline_code` here.** `` — is
 * ordinary house style in this project and appears dozens of times in
 * `prompts/task.md` alone. It produces one text node carrying **both** `code`
 * and `strong`, and Jira's ADF validator refuses that document:
 *
 * ```
 * RED    "**bold wrapping `inline_code` here.**"   -> 400 INVALID_INPUT, nothing written
 * GREEN  "**bold** and `inline_code` side by side" -> 201, comment 12767
 * ```
 *
 * **Confluence stores the identical document, HTTP 201.** That was measured on
 * the same day through the same daemon, and it is why this is a table keyed by
 * {@link AdfTarget} rather than a rule: a fix that stripped the mark for both
 * products would degrade every Confluence page to satisfy a constraint only
 * Jira has. This is the same shape as {@link ALLOWED_CHILDREN} and was found
 * the same way — by making the call.
 *
 * The entry reads *"on Jira, a `code` mark may keep only `link` for company"*.
 * That is broader than the two combinations measured (`code+strong`,
 * `code+em`), deliberately: Jira's schema excludes every mark but `link` from
 * `code`, so narrowing this to the two spellings that happened to be observed
 * would leave `code+strike` and `code+underline` to be rediscovered later as
 * the same defect wearing a different costume.
 *
 * **`code` is what survives, and the decoration is what goes.** The code span
 * is what the author *meant* — it says "this is an identifier" — while the bold
 * is emphasis around it. Dropping the other way would keep the decoration and
 * throw away the meaning. Either way no text moves: a mark is not content, so
 * the completeness check in {@link markdownToAdf} is unaffected, and the change
 * is reported as a coercion rather than made silently.
 */
const MARK_COMPANIONS: Record<AdfTarget, Record<string, readonly string[]>> = {
  // Measured accepting `code+strong` and `code+em` at HTTP 201. Nothing is
  // stripped for Confluence, and an empty table here is a finding rather than
  // an omission.
  confluence: {},
  jira: {
    code: ['link']
  }
};

/**
 * The mark combinations a product refuses, named the way an agent reading an
 * error can act on.
 *
 * Exported because the same knowledge answers two questions in two files: this
 * one uses it to *avoid* emitting a rejected document, and `jira.ts` uses it to
 * explain a 400 that got past — see {@link jiraAdfViolations}. Written once so
 * the two cannot drift.
 */
function conflictingMarks(target: AdfTarget, marks: AdfNode['marks']): string[] {
  if (!marks || marks.length < 2) return [];
  const companions = MARK_COMPANIONS[target];
  const present = marks.map((mark) => mark.type);
  const out: string[] = [];
  for (const [owner, allowed] of Object.entries(companions)) {
    if (!present.includes(owner)) continue;
    for (const other of present) {
      if (other === owner || allowed.includes(other)) continue;
      out.push(`${owner}+${other}`);
    }
  }
  return out;
}

/**
 * Strip mark combinations `target` will not accept, recording each one.
 *
 * Runs over the finished document rather than at the point each mark is
 * applied, and that placement is the argument: marks are added in four separate
 * places — the emphasis loop, the link branch, the `listItem>heading` coercion
 * which bolts `strong` onto whatever the heading already carried, and
 * `blockquote>heading` doing the same. A rule enforced at each of them is a
 * rule with four chances to be forgotten by the fifth. Here there is one gate
 * and everything goes through it.
 *
 * It runs **before** the completeness check, so what that check measures is the
 * document that will actually be sent.
 */
function normaliseMarks(node: AdfNode, target: AdfTarget): void {
  const conflicts = conflictingMarks(target, node.marks);
  if (conflicts.length && node.marks) {
    const companions = MARK_COMPANIONS[target];
    const owners = Object.keys(companions).filter((owner) =>
      node.marks!.some((mark) => mark.type === owner)
    );
    const dropped = node.marks
      .filter((mark) => !owners.includes(mark.type) && !owners.some((owner) => companions[owner].includes(mark.type)))
      .map((mark) => mark.type);
    node.marks = node.marks.filter((mark) => !dropped.includes(mark.type));
    pendingCoercions.push(
      `${dropped.join(' and ')} dropped from a code span: Jira's ADF validator rejects a text ` +
        `node marked ${conflicts.join(' or ')} with a bare 400 INVALID_INPUT naming nothing ` +
        '(KAN-502), unlike Confluence which stores it; the code span and its text are kept and ' +
        'only the surrounding emphasis is lost'
    );
  }
  for (const child of node.content ?? []) normaliseMarks(child, target);
}

/**
 * Every construct in an ADF document that Jira is known to refuse, named.
 *
 * ## WHY THIS IS EXPORTED RATHER THAN PRIVATE
 *
 * `normaliseMarks` above means this converter no longer *emits* the mark
 * combination, and {@link contain} means it no longer emits the nesting. Both
 * are prevention, and prevention answers the question "did we send a bad
 * document" only for the badness we already know about. When Jira answers 400
 * INVALID_INPUT anyway — the code names no node, no mark and no field, and on
 * the issue-creation endpoint it is not even accompanied by the code — the
 * caller has a document and a verdict and nothing joining them.
 *
 * This joins them. `jira.ts` calls it on the body it just sent and appends
 * whatever it finds to the refusal, so an agent reads *"the document contained
 * X, which Jira refuses"* rather than `malformed (400)`. It returns an empty
 * array when it recognises nothing, and **that is a real answer**: it means the
 * document is clean by every rule this file knows, and the cause is something
 * neither this converter nor this project has met yet — which is worth saying
 * plainly rather than dressing up as a guess.
 */
export function jiraAdfViolations(payload: unknown): string[] {
  const found: string[] = [];
  const seen = new Set<unknown>();

  // The whole REQUEST body is walked, not a document handed in already located,
  // and that is deliberate: a comment carries its document at `body`, an edit
  // at `fields.description`, a worklog at `comment`, and a create at
  // `fields.description` beside a summary and a project. A caller that had to
  // know which key held the document would need updating every time an
  // operation was added, and the one it forgot would be the one that failed.
  // So every object value is descended and an ADF node is recognised by shape.
  const walk = (node: any, parent: string | null): void => {
    if (!node || typeof node !== 'object') return;
    // A payload is JSON and therefore acyclic; this guards against a caller
    // that handed us something else, since a diagnostic that hangs is worse
    // than one that says nothing.
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const child of node) walk(child, parent);
      return;
    }

    const type = typeof node.type === 'string' ? node.type : null;

    if (type === 'text' && Array.isArray(node.marks)) {
      for (const combination of conflictingMarks('jira', node.marks)) {
        const quoted = typeof node.text === 'string' ? ` — ${JSON.stringify(node.text.slice(0, 40))}` : '';
        found.push(
          `a text node marked ${combination}${quoted}. Jira's ADF schema lets a code span carry ` +
            'a link and nothing else, so a backticked identifier inside bold or italics is ' +
            'refused; Confluence accepts the same node'
        );
      }
    }

    if (type && parent) {
      const allowed = ALLOWED_CHILDREN.jira[parent];
      // Named only where Confluence permits it, because that is the difference
      // this diagnosis is competent to report. A nesting *neither* product
      // allows is a converter bug rather than a product divergence, and
      // `contain` refuses it before anything is sent.
      if (allowed && !allowed.includes(type) && ALLOWED_CHILDREN.confluence[parent]?.includes(type)) {
        found.push(`a ${type} inside a ${parent}, which Jira refuses and Confluence accepts`);
      }
    }

    // `content` carries the ADF parentage; every other key is a container on
    // the way to a document and passes `null` through, so a `description` key
    // is never mistaken for a node type.
    for (const [key, value] of Object.entries(node)) {
      if (key === 'marks' || key === 'attrs') continue;
      walk(value, key === 'content' ? type : null);
    }
  };

  walk(payload, null);
  return [...new Set(found)];
}

const text = (value: string, marks?: AdfNode['marks']): AdfNode =>
  marks && marks.length ? { type: 'text', text: value, marks } : { type: 'text', text: value };

const paragraph = (content: AdfNode[]): AdfNode => ({
  type: 'paragraph',
  content: content.length ? content : []
});

/**
 * Inline markdown → ADF inline nodes.
 *
 * Code spans are matched first and their contents are never re-scanned, which
 * is what stops `` `**not bold**` `` from acquiring a mark. Everything else is
 * one ordered pass of the same shape.
 *
 * Unmatched markup characters are **kept as literal text** rather than
 * swallowed. A lone `*` in prose is a lone `*`, and the completeness check in
 * {@link markdownToAdf} is what makes that a rule rather than an intention.
 */
export function inlineToAdf(source: string): AdfNode[] {
  const out: AdfNode[] = [];
  let buffer = '';

  const flush = (marks?: AdfNode['marks']) => {
    if (buffer) {
      out.push(text(buffer, marks));
      buffer = '';
    }
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    // Backslash escape: the next character is literal, whatever it is.
    if (rest[0] === '\\' && rest.length > 1) {
      buffer += rest[1];
      i += 2;
      continue;
    }

    // Code span. Matched before every other construct so its body is opaque.
    const code = /^(`+)([\s\S]*?)\1/.exec(rest);
    if (code) {
      flush();
      out.push(text(code[2], [{ type: 'code' }]));
      i += code[0].length;
      continue;
    }

    // [label](href)
    const link = /^\[([^\]]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      // The label carries its own inline markup, and the link mark is added to
      // whatever that produced rather than replacing it.
      for (const node of inlineToAdf(link[1])) {
        out.push({
          ...node,
          marks: [...(node.marks ?? []), { type: 'link', attrs: { href: link[2] } }]
        });
      }
      i += link[0].length;
      continue;
    }

    // Bare URL, so that a pasted link is a link.
    const auto = /^https?:\/\/[^\s<>()]+/.exec(rest);
    if (auto) {
      flush();
      out.push(text(auto[0], [{ type: 'link', attrs: { href: auto[0] } }]));
      i += auto[0].length;
      continue;
    }

    for (const { pattern, mark, wordBoundary } of INLINE_MARKS) {
      // An underscore glued to the end of a word is part of the word, not an
      // emphasis opener. See INLINE_MARKS for why this rule exists and what it
      // cost before it did.
      if (wordBoundary && i > 0 && WORD_CHAR.test(source[i - 1])) continue;
      const match = pattern.exec(rest);
      if (!match) continue;
      flush();
      for (const node of inlineToAdf(match[1])) {
        out.push({ ...node, marks: [...(node.marks ?? []), { type: mark }] });
      }
      i += match[0].length;
      break;
    }
    // `break` above leaves `i` advanced; detect that by re-reading.
    if (source.slice(i) !== rest) continue;

    buffer += rest[0];
    i += 1;
  }
  flush();
  return out;
}

/** An alphanumeric, which is what "inside a word" means for {@link INLINE_MARKS}. */
const WORD_CHAR = /[A-Za-z0-9]/;

/**
 * Emphasis patterns, longest delimiter first.
 *
 * `**` must be tried before `*` or `**bold**` parses as an empty emphasis
 * followed by the word — the ordering is the whole correctness argument, so the
 * list is ordered rather than a map.
 *
 * ## `_` DOES NOT MARK INSIDE A WORD, AND THAT IS NOT A STYLE CHOICE (KAN-502)
 *
 * Underscore is an *identifier* character everywhere this fleet writes, and it
 * was an emphasis delimiter here unconditionally until 2026-08-18. So
 * `atlassian_update_confluence_page` in ordinary prose had its second and third
 * underscores paired as emphasis, the run was consumed, and the identifier no
 * longer appeared in the output text. The completeness check in
 * {@link markdownToAdf} then did exactly its job and **refused the write**:
 *
 * ```
 * AdfConversionError: The markdown→ADF conversion would have lost 1 token(s) from
 * your content — "atlassian_update_confluence_page". NOTHING WAS WRITTEN.
 * ```
 *
 * **The guard was never the bug.** Without it the identifier would have stored
 * mangled and silently, which is the failure this whole file exists to prevent.
 * The bug was here, one layer up, and its blast radius was every tool name this
 * fleet has: `atlassian_get_issue`, `butchr_send_to_agent`, `butchr_list_agents`
 * — every one of them snake_case with two or more underscores, and every one of
 * them unwritable in prose. One underscore was safe only because it had no
 * partner to pair with, which is why the defect read as context-dependent and
 * was first diagnosed as something else entirely.
 *
 * `wordBoundary` is CommonMark's own intra-word rule, applied to the two `_`
 * patterns and to neither `*` pattern: `*` is not an identifier character, and
 * narrowing it would change how ordinary prose parses for no measured gain.
 * Both ends are guarded, and they are guarded in different places because the
 * scanner sees them differently — the **opener** by the character before it
 * (checked at the call site in {@link inlineToAdf}, which is the only place
 * that character is in scope), the **closer** by the negative lookahead in the
 * pattern itself. Either one alone leaves the defect reachable from the other
 * side: `_atlassian_update_` would still eat its own tail.
 */
const INLINE_MARKS: readonly { pattern: RegExp; mark: string; wordBoundary: boolean }[] = [
  { pattern: /^\*\*([^*]+)\*\*/, mark: 'strong', wordBoundary: false },
  { pattern: /^__([^_]+)__(?![A-Za-z0-9])/, mark: 'strong', wordBoundary: true },
  { pattern: /^~~([^~]+)~~/, mark: 'strike', wordBoundary: false },
  { pattern: /^\*([^*]+)\*/, mark: 'em', wordBoundary: false },
  { pattern: /^_([^_]+)_(?![A-Za-z0-9])/, mark: 'em', wordBoundary: true }
];

/** How deep one level of list indentation is, in spaces. Two or four both work. */
const INDENT = 2;

interface Line {
  raw: string;
  indent: number;
  body: string;
}

const scan = (source: string): Line[] =>
  source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => {
      const expanded = raw.replace(/\t/g, '    ');
      const indent = expanded.length - expanded.trimStart().length;
      return { raw: expanded, indent, body: expanded.trim() };
    });

const BULLET = /^[-*+]\s+(.*)$/;
const ORDERED = /^(\d+)[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^```\s*([A-Za-z0-9_+-]*)\s*$/;
const RULE = /^(-{3,}|\*{3,}|_{3,})$/;
const QUOTE = /^>\s?(.*)$/;

/**
 * Block-level markdown → ADF blocks.
 *
 * Recursive by container rather than by line: a list item's continuation lines
 * are gathered, dedented, and handed back to this same function, which is why
 * a blockquote inside a list item inside a table cell is built by the same
 * three lines of code as a blockquote at the top level. **The nesting the
 * official converter loses is not a special case here; it is the ordinary
 * path.**
 */
function blocksToAdf(lines: Line[]): AdfNode[] {
  const out: AdfNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.body) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line.body);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i].body)) {
        body.push(lines[i].raw.slice(Math.min(line.indent, lines[i].indent)));
        i += 1;
      }
      i += 1; // closing fence
      out.push({
        type: 'codeBlock',
        ...(fence[1] ? { attrs: { language: fence[1] } } : {}),
        content: body.length ? [text(body.join('\n'))] : []
      });
      continue;
    }

    if (RULE.test(line.body)) {
      out.push({ type: 'rule' });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line.body);
    if (heading) {
      out.push({
        type: 'heading',
        attrs: { level: heading[1].length },
        content: inlineToAdf(heading[2])
      });
      i += 1;
      continue;
    }

    if (QUOTE.test(line.body)) {
      const inner: Line[] = [];
      while (i < lines.length && QUOTE.test(lines[i].body)) {
        inner.push({ raw: QUOTE.exec(lines[i].body)![1], indent: 0, body: QUOTE.exec(lines[i].body)![1].trim() });
        i += 1;
      }
      out.push({ type: 'blockquote', content: blocksToAdf(inner) });
      continue;
    }

    // A table is a pipe row followed by a delimiter row. Both are required —
    // a line with a pipe in it is usually prose.
    if (line.body.includes('|') && i + 1 < lines.length && isDelimiterRow(lines[i + 1].body)) {
      const rows: string[][] = [splitRow(line.body)];
      i += 2;
      while (i < lines.length && lines[i].body.includes('|')) {
        rows.push(splitRow(lines[i].body));
        i += 1;
      }
      out.push(buildTable(rows));
      continue;
    }

    if (BULLET.test(line.body) || ORDERED.test(line.body)) {
      const ordered = ORDERED.test(line.body);
      const items: AdfNode[] = [];
      const at = line.indent;

      while (i < lines.length) {
        const head = lines[i];
        if (!head.body) {
          // A blank line inside a list is only a break if the list has ended.
          const next = lines[i + 1];
          if (!next || !next.body || next.indent < at) break;
          i += 1;
          continue;
        }
        if (head.indent < at) break;
        const match = ordered ? ORDERED.exec(head.body) : BULLET.exec(head.body);
        if (head.indent === at && !match) break;
        if (!match && head.indent <= at) break;

        // The item's own first line, plus every following line indented past
        // the marker. Those continuation lines are dedented and recursed on,
        // which is where nested lists and nested blockquotes come from.
        const own: Line[] = [{ raw: match ? (ordered ? match[2] : match[1]) : head.body, indent: 0, body: (match ? (ordered ? match[2] : match[1]) : head.body).trim() }];
        i += 1;
        while (i < lines.length) {
          const cont = lines[i];
          if (!cont.body) {
            const next = lines[i + 1];
            if (!next || next.indent <= at) break;
            own.push({ raw: '', indent: 0, body: '' });
            i += 1;
            continue;
          }
          if (cont.indent <= at) break;
          own.push({ raw: cont.raw.slice(at + INDENT), indent: Math.max(0, cont.indent - at - INDENT), body: cont.body });
          i += 1;
        }

        items.push({ type: 'listItem', content: contain('listItem', blocksToAdf(own)) });
      }

      out.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }

    // A paragraph runs to the next blank line or the next block opener.
    const body: string[] = [];
    while (i < lines.length && lines[i].body && !opensBlock(lines[i], lines[i + 1])) {
      body.push(lines[i].body);
      i += 1;
    }
    if (!body.length) {
      // `opensBlock` was true for the very first line, which can only happen
      // for a construct handled above; consume it as prose rather than spin.
      body.push(lines[i].body);
      i += 1;
    }
    out.push(paragraph(inlineToAdf(body.join(' '))));
  }

  return out;
}

function opensBlock(line: Line, next: Line | undefined): boolean {
  return (
    BULLET.test(line.body) ||
    ORDERED.test(line.body) ||
    HEADING.test(line.body) ||
    FENCE.test(line.body) ||
    RULE.test(line.body) ||
    QUOTE.test(line.body) ||
    (line.body.includes('|') && !!next && isDelimiterRow(next.body))
  );
}

const isDelimiterRow = (body: string): boolean =>
  /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(body) && body.includes('-');

const splitRow = (body: string): string[] =>
  body
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

/**
 * A GFM pipe table → an ADF table.
 *
 * The first row becomes `tableHeader` cells, which is what makes it render as a
 * header rather than as an ordinary row, and every cell's text is run through
 * the full block converter — so a cell containing a list gets a list, and a
 * cell containing a quoted list gets exactly the structure the module header's
 * probe proved survives.
 */
function buildTable(rows: string[][]): AdfNode {
  const width = Math.max(...rows.map((row) => row.length));
  return {
    type: 'table',
    attrs: { layout: 'default' },
    content: rows.map((row, index) => ({
      type: 'tableRow',
      content: Array.from({ length: width }, (_, column) => {
        const cellType = index === 0 ? 'tableHeader' : 'tableCell';
        // A cell's markdown cannot contain a newline, so `<br>` and an escaped
        // pipe are the only multi-block spellings GFM offers. Both are honoured.
        const source = (row[column] ?? '').replace(/<br\s*\/?>/gi, '\n');
        const blocks = contain(cellType, blocksToAdf(scan(source)));
        return {
          type: cellType,
          content: blocks.length ? blocks : [paragraph([])]
        };
      })
    }))
  };
}

/**
 * Force a list of blocks to be legal children of `parent`, or throw.
 *
 * The three outcomes of the module header, in code. Recorded coercions are
 * collected in {@link pendingCoercions} rather than returned, because this runs
 * deep inside a recursion whose intermediate results are lists of nodes; the
 * alternative is threading a log through every frame of a converter, which is
 * how a log stops being written.
 */
let pendingCoercions: string[] = [];
let currentTarget: AdfTarget = 'confluence';

function contain(parent: string, blocks: AdfNode[]): AdfNode[] {
  const allowed = ALLOWED_CHILDREN[currentTarget][parent];
  if (!allowed) return blocks;
  return blocks.flatMap((block) => {
    if (allowed.includes(block.type)) return [block];

    const coercion = COERCIONS[`${parent}>${block.type}`];
    if (!coercion) {
      throw new AdfConversionError(
        `A ${block.type} cannot go inside a ${parent} in ADF, and this converter has no ` +
          'content-preserving substitution for that pairing. Nothing was written. Rewrite the ' +
          'content so the block sits somewhere ADF allows it — this is refused rather than ' +
          'silently dropped, which is what the official markdown converter does with the same ' +
          'input (see KAN-183, KAN-266).'
      );
    }

    pendingCoercions.push(`${block.type} inside ${parent}: ${coercion.why}`);

    if (coercion.to === 'unwrap') {
      // Splice the offending wrapper's children in where it stood, and run them
      // through the same containment so an unwrapped child that is *itself*
      // illegal here is handled rather than smuggled in behind its parent.
      return contain(parent, block.content ?? []);
    }

    if (coercion.to === 'paragraph') {
      // A heading's text survives with a bold mark, so the emphasis it was
      // carrying is not lost either.
      return [
        paragraph(
          (block.content ?? []).map((node) => ({
            ...node,
            marks: [...(node.marks ?? []), { type: 'strong' }]
          }))
        )
      ];
    }

    // A nested table flattens to quoted paragraphs, one per row.
    return [
      {
        type: 'blockquote',
        content: (block.content ?? []).map((row) =>
          paragraph([text((row.content ?? []).map(plainText).join(' | '))])
        )
      }
    ];
  });
}

/**
 * Every word-shaped token in a string. The unit the completeness check counts.
 *
 * A token **starts and ends on an alphanumeric**, so an emphasis delimiter
 * glued to a word by the source text is not part of the word: `_underscore_`
 * tokenises as `underscore` on the source side, which is what the document
 * side will hold once the mark has been applied. Internal punctuation is kept,
 * so `customfield_10001`, `well-known` and `don't` each stay one token on both
 * sides.
 *
 * This shape was not the first one tried. `[A-Za-z0-9][A-Za-z0-9_'-]*` let a
 * trailing `_` into the source token and the completeness check duly reported
 * `underscore_` as content the converter had lost — a **false** report, since
 * the word itself was present and only the markup differed. That is the failure
 * direction this check is allowed to have: it cried wolf, it did not stay
 * quiet. The fix is symmetric — both sides tokenise with this one regex — so it
 * narrows what counts as a word rather than narrowing what counts as a loss.
 */
const WORDS = /[A-Za-z0-9](?:[A-Za-z0-9_'-]*[A-Za-z0-9])?/g;

const tokensOf = (value: string): string[] => value.match(WORDS) ?? [];

/**
 * The tokens of the *content* of a markdown source, with structural markup
 * removed.
 *
 * The completeness check compares source against output, and it has to compare
 * like with like: a list marker, a heading's hashes and a `<br>` are
 * instructions to the parser rather than words on the page, so the parser is
 * *right* to consume them and counting them as lost content would make the
 * check cry wolf on ordinary input. `1.` is the sharp one — the `1` is a token
 * by any regex, and it is markup.
 *
 * **Everything stripped here is stripped because the parser consumes it, and
 * nothing is stripped because it was inconvenient.** That distinction is the
 * whole integrity of the check: widen this function to quiet a real shortfall
 * and the guard is gone, which is precisely how a guard like this dies. If a
 * token shows up missing, the question is what the converter did with it, not
 * what this function could be taught to ignore.
 */
function contentTokens(markdown: string): string[] {
  const stripped = markdown
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !isDelimiterRow(line.trim()))
    .map((line) =>
      line
        // Blockquote markers, however deeply stacked.
        .replace(/^\s*(>\s?)+/, '')
        // Bullet and ordered list markers.
        .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
        // Heading hashes.
        .replace(/^\s*#{1,6}\s+/, '')
        // Fence delimiters, keeping any language: it survives into attrs.
        .replace(/^\s*```/, '')
        // An explicit line break inside a table cell.
        .replace(/<br\s*\/?>/gi, ' ')
    )
    .join('\n');
  return tokensOf(stripped);
}

/** All text an ADF subtree carries, including the places that are not `text` nodes. */
function plainText(node: AdfNode): string {
  const own = node.text ?? '';
  const language = typeof node.attrs?.language === 'string' ? ` ${node.attrs.language}` : '';
  const href = node.marks?.find((mark) => mark.type === 'link')?.attrs?.href;
  const link = typeof href === 'string' ? ` ${href}` : '';
  const children = (node.content ?? []).map(plainText).join(' ');
  return `${own}${language}${link} ${children}`;
}

export class AdfConversionError extends Error {}

/**
 * Markdown → an ADF document, with nothing dropped.
 *
 * Throws {@link AdfConversionError} when the input cannot be represented
 * without losing content — which is the honest answer, and the one the official
 * converter does not give.
 *
 * ## THE COMPLETENESS CHECK IS THE POINT OF THIS FUNCTION
 *
 * Every word token of the source must appear in the produced document. It is
 * checked here, on every call, for every agent, because the defect it guards
 * against was found by nesting two ordinary constructs and would never have
 * been on a list of cases to test. A converter that quietly drops a subtree
 * produces a document that looks entirely reasonable — that is *why* KAN-183
 * went unnoticed — and the only thing that can tell is a count.
 *
 * A shortfall throws rather than warns. There is no safe way to continue: the
 * caller is about to POST this document, and a partial write to a page is
 * indistinguishable afterwards from a page somebody edited.
 */
export function markdownToAdf(markdown: string, target: AdfTarget = 'confluence'): AdfConversion {
  const outer = pendingCoercions;
  const outerTarget = currentTarget;
  pendingCoercions = [];
  currentTarget = target;
  try {
    const blocks = contain('doc', blocksToAdf(scan(markdown)));
    const doc: AdfDoc = {
      type: 'doc',
      version: 1,
      content: blocks.length ? blocks : [paragraph([])]
    };

    // Before the completeness check, never after: what that check measures has
    // to be the document that will actually be sent. See `normaliseMarks`.
    for (const block of doc.content) normaliseMarks(block, target);

    const produced = new Set(tokensOf(doc.content.map(plainText).join(' ')));
    const missing = [...new Set(contentTokens(markdown))].filter((token) => !produced.has(token));
    if (missing.length) {
      throw new AdfConversionError(
        `The markdown→ADF conversion would have lost ${missing.length} token(s) from your ` +
          `content — ${missing.slice(0, 8).map((t) => JSON.stringify(t)).join(', ')}` +
          `${missing.length > 8 ? ', …' : ''}. NOTHING WAS WRITTEN. This is a bug in Butchr's ` +
          'converter rather than in your content, and it is refused instead of written because ' +
          'a silently incomplete page is the failure this converter exists to prevent ' +
          '(KAN-183, KAN-266). Please report it on your ticket with the content that caused it.'
      );
    }

    return { doc, coercions: [...pendingCoercions] };
  } finally {
    pendingCoercions = outer;
    currentTarget = outerTarget;
  }
}

/**
 * The same document, as Confluence's v2 API wants a body.
 *
 * `atlas_doc_format` takes the document **as a JSON string**, not as an object,
 * which is an easy thing to get wrong in a way that fails loudly at least.
 */
export function confluenceBody(doc: AdfDoc): { representation: 'atlas_doc_format'; value: string } {
  return { representation: 'atlas_doc_format', value: JSON.stringify(doc) };
}

// ───────────────────────────────────────────────────────────────────────────
// KAN-501: the other direction. ADF in, plain text out.
// ───────────────────────────────────────────────────────────────────────────

/**
 * What an ADF document says, as text, and what rendering it cost.
 *
 * `unrendered` is the half that matters and it is why this returns a record
 * rather than a string. Every other converter in this file is written against
 * a grammar it also *builds*, so it knows every node it can meet. This one is
 * given documents Atlassian wrote, from a schema that grows without asking us
 * — an `expand`, a `taskList`, a macro nobody here has seen. A renderer that
 * met one of those and returned the text it could find would produce a clean,
 * complete-looking paragraph with a section missing from the middle, which is
 * KAN-183's dropped list item wearing this module's clothes.
 *
 * So an unrecognised node is **named in the output** — `[adf:expand]` — and
 * named again here, where a caller can put the list in front of the reader.
 * An empty `unrendered` is the claim that every node was understood.
 */
export interface AdfText {
  text: string;
  /** Node types met that this renderer has no rule for, deduplicated. */
  unrendered: string[];
}

/** Text-level marks, in the order they wrap. */
function applyMarks(text: string, marks: AdfNode['marks']): string {
  if (!marks?.length) return text;
  let out = text;
  for (const mark of marks) {
    switch (mark.type) {
      case 'code':
        out = `\`${out}\``;
        break;
      case 'strong':
        out = `**${out}**`;
        break;
      case 'em':
        out = `*${out}*`;
        break;
      case 'strike':
        out = `~~${out}~~`;
        break;
      case 'link': {
        const href = mark.attrs?.href;
        out = typeof href === 'string' && href ? `[${out}](${href})` : out;
        break;
      }
      // `underline`, `textColor`, `subsup` and anything newer carry no text of
      // their own, so dropping the decoration loses nothing a reader needs.
      // This is the one place silence is correct, and it is correct because
      // the characters survive: a mark is a property of text that is present.
      default:
        break;
    }
  }
  return out;
}

/**
 * Render one ADF document to text.
 *
 * WHAT THIS IS FOR (KAN-501). A Jira comment reaches an agent as ADF, and ADF
 * is roughly five times the size of the words in it — measured on this site on
 * 2026-08-18, KAN-501's own oldest comment is 1,930 characters of prose inside
 * a 10,682-character response. The proxy's comment read was therefore over its
 * response budget on every real ticket and returned **no comment body at all**,
 * which made the one tool that reaches a long history the one tool that could
 * not answer. The words are what an agent came for; the node tree is not.
 *
 * It is Markdown-flavoured rather than bare prose because the input is prose
 * somebody wrote in Markdown, converted to ADF by {@link markdownToAdf} on the
 * way in. Round-tripping it back to the notation it was written in is what
 * makes a quoted heading still read as a heading.
 */
export function adfToText(doc: unknown): AdfText {
  const unrendered = new Set<string>();

  // AN INPUT THAT IS NOT A NODE IS NOT AN EMPTY DOCUMENT, and the two must not
  // render the same. Walking a `null` body returns '' — which reads as a comment
  // somebody left blank, with an empty `unrendered` still claiming every node
  // was understood. That is a silent loss inside the function whose whole
  // contract is that it does not have any, so it is named here instead.
  if (!doc || typeof doc !== 'object' || typeof (doc as AdfNode).type !== 'string') {
    return {
      text: '',
      unrendered: [`not-adf:${doc === null ? 'null' : typeof doc}`]
    };
  }

  const renderInline = (nodes: AdfNode[] | undefined): string =>
    (nodes ?? []).map((n) => renderNode(n, '')).join('');

  function renderNode(node: AdfNode | undefined, indent: string): string {
    if (!node || typeof node !== 'object') return '';
    switch (node.type) {
      case 'doc':
        return (node.content ?? [])
          .map((n) => renderNode(n, indent))
          .filter((s) => s.length > 0)
          .join('\n\n');

      case 'text':
        return applyMarks(node.text ?? '', node.marks);

      case 'hardBreak':
        return '\n';

      case 'paragraph':
        return renderInline(node.content);

      case 'heading': {
        const level = Number(node.attrs?.level ?? 1);
        const hashes = '#'.repeat(Math.min(6, Math.max(1, Number.isFinite(level) ? level : 1)));
        return `${hashes} ${renderInline(node.content)}`;
      }

      case 'blockquote':
        return (node.content ?? [])
          .map((n) => renderNode(n, indent))
          .join('\n\n')
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');

      case 'bulletList':
      case 'orderedList': {
        const ordered = node.type === 'orderedList';
        const start = Number(node.attrs?.order ?? 1);
        return (node.content ?? [])
          .map((item, i) => {
            const bullet = ordered ? `${(Number.isFinite(start) ? start : 1) + i}. ` : '- ';
            const body = renderNode(item, `${indent}${' '.repeat(bullet.length)}`);
            // The bullet replaces the first line's indent; continuation lines
            // keep it, so a nested list stays nested when it is read back.
            const [first, ...rest] = body.split('\n');
            return [`${indent}${bullet}${first}`, ...rest].join('\n');
          })
          .join('\n');
      }

      case 'listItem':
        return (node.content ?? [])
          .map((n) => renderNode(n, indent))
          .filter((s) => s.length > 0)
          .join('\n');

      case 'codeBlock': {
        const lang = node.attrs?.language;
        const fence = typeof lang === 'string' && lang ? `\`\`\`${lang}` : '```';
        return `${fence}\n${renderInline(node.content)}\n\`\`\``;
      }

      case 'rule':
        return '---';

      case 'panel': {
        const kind = node.attrs?.panelType;
        const label = typeof kind === 'string' && kind ? kind.toUpperCase() : 'PANEL';
        const body = (node.content ?? []).map((n) => renderNode(n, indent)).join('\n\n');
        return `> [${label}] ${body.split('\n').join('\n> ')}`;
      }

      case 'table':
        return (node.content ?? []).map((n) => renderNode(n, indent)).join('\n');

      case 'tableRow':
        return `| ${(node.content ?? []).map((n) => renderNode(n, '')).join(' | ')} |`;

      case 'tableCell':
      case 'tableHeader':
        // Cell contents joined with a space rather than a newline: a newline
        // inside a pipe row would break the row it is part of.
        return (node.content ?? [])
          .map((n) => renderNode(n, ''))
          .filter((s) => s.length > 0)
          .join(' ')
          .replace(/\n+/g, ' ');

      case 'mention': {
        const t = node.attrs?.text;
        return typeof t === 'string' && t ? t : '@unknown';
      }

      case 'emoji': {
        const t = node.attrs?.text ?? node.attrs?.shortName;
        return typeof t === 'string' ? t : '';
      }

      case 'date': {
        const ts = node.attrs?.timestamp;
        return typeof ts === 'string' ? ts : '';
      }

      case 'status': {
        const t = node.attrs?.text;
        return typeof t === 'string' && t ? `[${t}]` : '';
      }

      case 'inlineCard':
      case 'blockCard':
      case 'embedCard': {
        const url = node.attrs?.url;
        return typeof url === 'string' && url ? url : '';
      }

      case 'mediaSingle':
      case 'mediaGroup':
        return (node.content ?? []).map((n) => renderNode(n, indent)).join('\n');

      case 'media': {
        const alt = node.attrs?.alt;
        const id = node.attrs?.id;
        const name = typeof alt === 'string' && alt ? alt : typeof id === 'string' ? id : 'attachment';
        return `[media: ${name}]`;
      }

      default: {
        // NAMED, NEVER DROPPED — see {@link AdfText}. If the node carries
        // children they are still rendered, so an unknown *container* costs its
        // label and not its contents; an unknown *leaf* costs nothing but is
        // still visible as having been there.
        unrendered.add(node.type);
        const inner = (node.content ?? [])
          .map((n) => renderNode(n, indent))
          .filter((s) => s.length > 0)
          .join('\n');
        return inner ? `[adf:${node.type}] ${inner}` : `[adf:${node.type}]`;
      }
    }
  }

  const text = renderNode(doc as AdfNode, '').replace(/\n{3,}/g, '\n\n').trim();
  return { text, unrendered: [...unrendered].sort() };
}
