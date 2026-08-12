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

    for (const [pattern, mark] of INLINE_MARKS) {
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

/**
 * Emphasis patterns, longest delimiter first.
 *
 * `**` must be tried before `*` or `**bold**` parses as an empty emphasis
 * followed by the word — the ordering is the whole correctness argument, so the
 * list is ordered rather than a map.
 */
const INLINE_MARKS: readonly [RegExp, string][] = [
  [/^\*\*([^*]+)\*\*/, 'strong'],
  [/^__([^_]+)__/, 'strong'],
  [/^~~([^~]+)~~/, 'strike'],
  [/^\*([^*]+)\*/, 'em'],
  [/^_([^_]+)_/, 'em']
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
