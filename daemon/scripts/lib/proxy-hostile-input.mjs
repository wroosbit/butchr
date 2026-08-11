//
// The hostile-input sweep for the Atlassian proxy's operation table — every
// argument of every operation, fed values that try to leave their parameter.
// KAN-292, at `epic/KAN-39`'s review of #127.
//
// WHY THIS IS A `lib/` AND NOT A THIRD SCRIPT. Two files need this sweep and
// they need the *same* one. `verify-atlassian-proxy-scope.mjs` owns KAN-272's
// containment — "no operation takes a path" is its sentence, and it is the file
// a reviewer opens to check it. `verify-atlassian-proxy-read-surface.mjs` owns
// KAN-292's eighteen new operations, which are where that property was most
// likely to be lost. Both must sweep the whole table, and a second copy of a
// 400-placement corpus is a second thing to drift: the copy that stops covering
// `fetch` is the one nobody re-reads. One implementation, imported twice.
//
// WHAT THIS REPLACED, AND WHY THE REVIEW ASKED FOR IT. Until now the sweep in
// `verify-atlassian-proxy-scope.mjs` special-cased exactly two operations —
// `atlassian_get_issue` and `atlassian_search_issues` — with a regex per
// operation. That was complete when the table had three entries. It has
// twenty-two, and the twenty it did not cover included `atlassian_fetch_resource`
// and `atlassian_search`, the two the ticket names as most likely to open a
// hole. The property held by construction; **nothing kept it holding**, which
// is the difference between a fact and a guard.
//
// THE MEASUREMENT, WHICH IS THE ONLY THING THAT MAKES THE ABOVE MORE THAN A
// STORY: with `atlassian_fetch_resource` altered to forward the tail of an ARI
// as a REST path, the two-operation version of this sweep stays **entirely
// green** and the whole-table version reports failures. That is in the #127
// PR body.
//
// ── WHAT `refused` AND `contained` ARE EACH COUNTED OVER (KAN-311) ──────────
//
// They do not add up to `checked`, and a reader who tries will be short by the
// fan-out. The two tallies are counted over **different units**:
//
//   - `checked` and `refused` are counted **per placement** — one per (operation,
//     argument, hostile value) triple, incremented once where `build` returns an
//     `{error}`.
//   - `contained` and `escapes` are counted **per request** — a cross-product
//     operation (`atlassian_search`, the only one today) builds two requests
//     from one placement, and each is resolved and checked separately.
//
// So on today's table `204 refused + 215 contained = 419` against `396`
// placements: the 23 extra are `atlassian_search`'s second request on each of
// its non-refused placements. Both numbers are right; they are answers to two
// different questions, and this paragraph is here because the arithmetic
// invites exactly one wrong conclusion.
//
// ── WHY THE TALLY IS ALSO PER ARGUMENT, AND WHY PER OPERATION IS NOT ENOUGH ─
//
// KAN-311. The global `refused > 0 && contained > 0` assertion guards the sweep
// against being vacuous **overall** — 215 contained proves it is not simply
// rejecting everything — but it says nothing about any particular interpolation.
// An argument whose validator refuses every hostile value contributes **zero**
// containment evidence, and its path interpolation could be entirely uncontained
// with every assertion still green. "None escaped" means *no hostile value that
// reached a path escaped*, which is weaker than it reads as.
//
// KAN-311's ticket asked for this per **operation**. That granularity is too
// coarse, and measurably so: `atlassian_get_confluence_page` reports 12
// contained placements — every one of them from `bodyFormat` — while `pageId`,
// the argument actually interpolated into the path and the one whose
// `encodeURIComponent` was removed in the mutation that prompted the ticket,
// contributes zero. A per-operation zero list does not name that operation,
// before the mutation or after it. **The unit that matters is the argument**,
// because the argument is what a path interpolates. So `perArgument` is the
// tally, and `zeroContainmentArguments` is the report.
//

/**
 * Values that try to leave the parameter they are put in.
 *
 * Traversal in raw and encoded form, absolute URLs, protocol-relative hosts,
 * fragments, embedded queries, a leading space, and two that are simply invalid
 * so that the corpus exercises refusal as well as containment.
 */
export const HOSTILE = [
  '../../../../rest/api/3/myself',
  'KAN-1/../../admin',
  'KAN-1?expand=changelog&x=/rest/api/3/user',
  'KAN-1#/rest/api/3/anything',
  '../..%2f..%2fadmin',
  'https://evil.example.com/rest/api/3/myself',
  '//evil.example.com/x',
  'KAN 1',
  '',
  'NOT-A-KEY-AT-ALL',
  ' /rest/api/3/myself',
  '163933/../../../admin'
];

/** The origin every built path must still resolve against. */
export const BASE = 'https://site.invalid';

/** Every request an operation builds for these arguments, or `null` if refused. */
export function requestsOf(op, args) {
  const built = op.build(args);
  if ('error' in built) return null;
  if ('requests' in built) return built.requests;
  return [{ product: built.product ?? op.products?.[0] ?? 'jira', path: built.path, body: built.body }];
}

/**
 * A value this field will accept, so the OTHER fields can be exercised.
 *
 * `id` is tested before the `/Id$/` suffix rule: the suffix matches the bare
 * name `id` too, which handed `atlassian_fetch_resource` a plain number where
 * it wanted an ARI. The operation then refused every argument, and the sweep
 * silently measured nothing for the one operation it most needed to measure.
 * Caught by the positive control, which is what a positive control is for.
 */
export function validFor(field) {
  if (field === 'id') return 'ari:cloud:jira:c4c-523:issue/10301';
  if (/issueKey/i.test(field)) return 'KAN-1';
  if (/projectKey/i.test(field)) return 'KAN';
  if (/Id$/i.test(field)) return '163933';
  if (field === 'limit' || field === 'maxResults') return 5;
  if (field === 'cql') return 'type=page';
  if (field === 'jql') return 'project = KAN';
  if (field === 'query') return 'butchr';
  if (field === 'bodyFormat') return 'storage';
  if (field === 'fields') return 'summary';
  if (field === 'transitionId') return '31';
  return 'x';
}

/** Two different, valid values for a field, so a template prefix can be derived. */
function pickBenign(field, which) {
  if (field === 'id') {
    return which ? 'ari:cloud:jira:c:issue/424242' : 'ari:cloud:jira:c:issue/163933';
  }
  if (/issueKey/i.test(field)) return which ? 'ZZZ-9' : 'KAN-1';
  if (/projectKey/i.test(field)) return which ? 'ZZZ' : 'KAN';
  if (/Id$/i.test(field)) return which ? '424242' : '163933';
  if (field === 'limit' || field === 'maxResults') return which ? 4 : 5;
  if (field === 'bodyFormat') return which ? 'view' : 'storage';
  return which ? 'zzz' : 'aaa';
}

/**
 * The literal part of an operation's path — everything before the first place
 * an argument goes — derived by building the same operation twice with two
 * different benign values and taking the common prefix.
 *
 * Derived rather than declared, for two reasons. A new operation is covered the
 * day it is added instead of when somebody remembers to write its shape here;
 * and a `pathShape` string that has drifted from what `build` actually does
 * cannot quietly widen the check, because this never reads `pathShape`.
 */
export function fixedPrefix(op, field, otherArgs) {
  const a = requestsOf(op, { ...otherArgs, [field]: pickBenign(field, 0) });
  const b = requestsOf(op, { ...otherArgs, [field]: pickBenign(field, 1) });
  if (!a || !b || a.length !== b.length) return null;
  return a.map((request, i) => {
    const pa = new URL(request.path, BASE).pathname;
    const pb = new URL(b[i].path, BASE).pathname;
    let n = 0;
    while (n < pa.length && n < pb.length && pa[n] === pb[n]) n++;
    // Back off to the last complete segment, so a prefix never ends mid-id.
    return pa.slice(0, pa.lastIndexOf('/', n) + 1);
  });
}

/**
 * Why this built path is an escape, or `null` if it is contained.
 *
 * A PATH IS SAFE WHEN IT STILL ADDRESSES THE ENDPOINT ITS TEMPLATE NAMES, and
 * the first version of this function measured something else. It grepped for
 * `..`, `http:` and `//` and called any of them an escape — which reports 29
 * failures against a table that is perfectly safe, because
 * `encodeURIComponent` leaves `.` alone (an unreserved character) and encodes
 * `/` as `%2F`. A hostile `../../admin` correctly becomes `..%2F..%2Fadmin`:
 * dots intact, slashes neutralised, going nowhere. Making that version "pass"
 * would have meant deleting it.
 *
 * So resolution is what is measured. The path is resolved against a base
 * exactly as `fetch` would resolve it, and must still land on the same origin
 * under the same fixed prefix its own template produces. A `..` that does
 * nothing survives; a `..` that climbs a segment does not, because resolution
 * normalises it away and the prefix check then fails.
 */
export function pathEscapes(request, expectedPrefix) {
  let url;
  try {
    url = new URL(request.path, BASE);
  } catch {
    return 'the path does not parse as a URL at all';
  }
  if (url.origin !== BASE) return `resolves to a different origin: ${url.origin}`;
  if (url.hash) return `carries a fragment: ${url.hash}`;
  if (expectedPrefix != null && !url.pathname.startsWith(expectedPrefix)) {
    return `resolves outside its template: ${url.pathname} is not under ${expectedPrefix}`;
  }
  return null;
}

/**
 * Sweep every argument of every operation given, with every hostile value.
 *
 * Returns the tally and the escapes. **Both outcomes are reported** because a
 * sweep that only ever refuses proves nothing — an operation whose `build`
 * rejected everything would produce a clean sweep and no coverage — so the
 * caller asserts that refusals and containments both occurred.
 *
 * `perArgument` carries the same tally at the granularity a path actually
 * interpolates at — see the header on why the operation is the wrong unit. Note
 * that `refused` is counted per placement and `contained` per request; the two
 * do not sum to `checked`, and the header says why.
 */
export function sweepHostileInput(operations) {
  let checked = 0;
  let refused = 0;
  let contained = 0;
  const escapes = [];
  const perArgument = [];

  for (const op of operations) {
    const fields = Object.keys(op.inputSchema?.properties ?? {});
    for (const field of fields) {
      // Fill every OTHER field with something valid, so the operation gets far
      // enough to build and the hostile value is the only thing under test.
      const otherArgs = {};
      for (const other of fields) {
        if (other !== field) otherArgs[other] = validFor(other);
      }
      const prefixes = fixedPrefix(op, field, otherArgs);
      const tally = { tool: op.tool, field, checked: 0, refused: 0, contained: 0, escaped: 0 };
      for (const hostile of HOSTILE) {
        const built = op.build({ ...otherArgs, [field]: hostile });
        checked++;
        tally.checked++;
        if ('error' in built) {
          refused++;
          tally.refused++;
          continue; // a refusal is a pass, and the loudest kind
        }
        const requests = 'requests' in built ? built.requests : [built];
        requests.forEach((request, i) => {
          const escape = pathEscapes(request, prefixes?.[i] ?? null);
          if (escape) {
            tally.escaped++;
            escapes.push(
              `${op.tool}.${field}=${JSON.stringify(String(hostile).slice(0, 30))} → ${escape}`
            );
          } else {
            contained++;
            tally.contained++;
          }
        });
      }
      perArgument.push(tally);
    }
  }

  return { checked, refused, contained, escapes, perArgument };
}

/**
 * The arguments that contributed no containment evidence at all.
 *
 * Every hostile value this argument was given was refused before a path was
 * built, so **the sweep measured its validator and never its interpolation**.
 * That is not a defect — a digits-only `pageId` legitimately refuses all twelve
 * — but it means containment for this argument rests on the validator **alone**,
 * and the encoding beside it is unproven by this instrument. What proves that
 * other half is `unencodedPathInterpolations` below, which is why this is a
 * report and that one is an assertion. KAN-311 decided that split deliberately;
 * `verify-atlassian-proxy-read-surface.mjs` records the reasoning.
 */
export function zeroContainmentArguments(sweep) {
  return sweep.perArgument.filter((tally) => tally.contained === 0);
}

// ── THE SECOND MECHANISM: THE ENCODING, READ OFF THE SOURCE ─────────────────
//
// Containment of a path interpolation rests on **two independent mechanisms**,
// and the sweep above can only ever see their composite:
//
//   1. the **validator**, which refuses a hostile value before a path is built;
//   2. the **encoding**, which neutralises one that gets through.
//
// When the validator refuses everything, the sweep's verdict is carried by
// mechanism 1 alone and mechanism 2 is never exercised. Removing
// `encodeURIComponent` from such a path changes nothing observable: `pageId` is
// digits-only, so the value that reaches the interpolation has no character
// encoding would alter, and **the built path is byte-identical either way**.
// That is not a gap in the sweep's corpus that a better hostile value would
// close — it is a property of composing a strict validator with an encoder, and
// no input fed through `build` can distinguish the two builds. Measured, not
// assumed: the mutation is invisible to all 396 placements.
//
// So the encoding is checked where it is visible, which is the source. This is
// static analysis, and it buys a different claim from the sweep's: not "no
// hostile value escaped" but **"every place an argument is interpolated into a
// path either encodes it or is not a string"**. Two instruments, one per
// mechanism, and the KAN-311 mutation turns this one red while leaving the
// sweep green — which is the whole point of adding it.
//
// WHAT THIS DOES NOT COVER, because a static check is not a runtime one: it
// reads the operation table's own path templates in `atlassian-proxy.ts` and
// nothing else. A path assembled somewhere this parser does not look, or built
// by a helper it cannot follow, is outside it. `router.ts` is what actually
// issues the request, and section 6 of the read-surface script is what asserts
// the router consults this table at all.

/**
 * Interpolated expressions that are safe without encoding, matched **exactly**.
 *
 * Every one is a number or a narrowed literal rather than caller text, so there
 * is nothing for `encodeURIComponent` to do:
 *
 *   - `listLimit(args)` clamps to 1..PROXY_LIST_MAX_RESULTS and returns a
 *     `number`;
 *   - `maxResults` and `limit` are the same clamp written inline, held in a
 *     local the builder computed;
 *   - `format` is narrowed by `['storage','atlas_doc_format','view'].includes()`
 *     to one of three literals, with a literal fallback.
 *
 * That these really are bounded is asserted dynamically rather than taken on
 * trust here — the limit-bound checks drive every list operation with `10_000`,
 * `'lots'`, `-5` and `NaN` and require what lands in the path to be in range.
 *
 * **The match is on the exact expression text, and that is the point.** A hole
 * opens by an interpolation becoming caller-controlled, and every way of
 * writing that — `${args.limit}`, `${asked}`, `${args.format}` — is a string
 * this list does not contain, so it is reported rather than silently exempted.
 * Adding an entry here is therefore a deliberate act with a justification owed;
 * the cost of the list is that it is maintained, and the alternative — inferring
 * boundedness from the declaration — is a type-checker, which is not this.
 */
export const BOUNDED_INTERPOLATIONS = ['listLimit(args)', 'maxResults', 'limit', 'format'];

/**
 * Every template literal that forms part of a `path:` expression, with the
 * expressions interpolated into it.
 *
 * Scans forward from each `path:` key and collects the backtick spans of the
 * expression that follows, so that a path concatenated across several fragments
 * — which most of the longer ones are — is read as one path rather than missed
 * after its first line.
 */
export function pathInterpolations(source) {
  const found = [];
  const key = /\bpath\s*:\s*/g;
  let match;
  while ((match = key.exec(source))) {
    let i = match.index + match[0].length;
    let depth = 0;
    const interpolations = [];
    // Walk the expression until the `,`, `;` or closing brace that ends it.
    while (i < source.length) {
      const c = source[i];
      if (c === '`') {
        let j = i + 1;
        while (j < source.length && source[j] !== '`') {
          if (source[j] === '\\') {
            j += 2;
            continue;
          }
          if (source[j] === '$' && source[j + 1] === '{') {
            let k = j + 2;
            let braces = 1;
            let expression = '';
            while (k < source.length && braces > 0) {
              if (source[k] === '{') braces++;
              else if (source[k] === '}') {
                braces--;
                if (!braces) break;
              }
              expression += source[k];
              k++;
            }
            interpolations.push({
              expression: expression.trim(),
              line: source.slice(0, j).split('\n').length
            });
            j = k + 1;
            continue;
          }
          j++;
        }
        i = j + 1;
        continue;
      }
      if (c === '(' || c === '{' || c === '[') depth++;
      else if (c === ')' || c === '}' || c === ']') {
        if (depth === 0) break;
        depth--;
      } else if ((c === ',' || c === ';') && depth === 0) break;
      else if (c === "'" || c === '"') {
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
      }
      i++;
    }
    if (interpolations.length) {
      found.push({ line: source.slice(0, match.index).split('\n').length, interpolations });
    }
  }
  return found;
}

/**
 * Path interpolations that neither encode their argument nor are bounded by
 * construction — the finding this exists to produce.
 *
 * Each is a place a caller-supplied value could reach a URL path unencoded, and
 * whose containment therefore rests on its validator with nothing behind it.
 */
export function unencodedPathInterpolations(source) {
  const bare = [];
  for (const path of pathInterpolations(source)) {
    for (const { expression, line } of path.interpolations) {
      if (/encodeURIComponent\s*\(/.test(expression)) continue;
      if (BOUNDED_INTERPOLATIONS.includes(expression)) continue;
      bare.push({ line, expression });
    }
  }
  return bare;
}
