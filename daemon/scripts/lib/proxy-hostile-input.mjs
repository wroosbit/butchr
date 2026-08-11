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
 */
export function sweepHostileInput(operations) {
  let checked = 0;
  let refused = 0;
  let contained = 0;
  const escapes = [];

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
      for (const hostile of HOSTILE) {
        const built = op.build({ ...otherArgs, [field]: hostile });
        checked++;
        if ('error' in built) {
          refused++;
          continue; // a refusal is a pass, and the loudest kind
        }
        const requests = 'requests' in built ? built.requests : [built];
        requests.forEach((request, i) => {
          const escape = pathEscapes(request, prefixes?.[i] ?? null);
          if (escape) {
            escapes.push(
              `${op.tool}.${field}=${JSON.stringify(String(hostile).slice(0, 30))} → ${escape}`
            );
          } else {
            contained++;
          }
        });
      }
    }
  }

  return { checked, refused, contained, escapes };
}
