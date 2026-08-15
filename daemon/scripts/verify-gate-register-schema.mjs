#!/usr/bin/env node
// KAN-457: the gate register's container, checked rather than asserted.
//
// WHAT FAILURE THIS WOULD CATCH: a gate register that has silently run out of
// room, that states a total nobody derived, or that records a CLOSED gate whose
// basis is somebody else's versioned artefact without saying the citation is
// also an expiry. All three had already happened when this was written:
//
//   * KAN-457 was filed because the eighth update to KAN-348's description was
//     REFUSED — `{"errors":{"description":"CONTENT_LIMIT_EXCEEDED"}}` — with
//     nothing in the document, and nothing anywhere, saying it was near the cap.
//     Measured on the day: 32,377 of 32,767 characters used, 390 left, and a
//     growth rate of 1,879 chars/hour across the preceding four updates. That is
//     twelve minutes of headroom, discoverable only by being refused.
//
//   * KAN-348's summary read `10 gates, 9 closed`. It enumerates nine gates
//     (1,2,3,4,5,6,7,9,10 — there is no gate 8; 8 is the flip STEP) of which
//     eight are closed. BOTH numbers were wrong, and the enumeration beside them
//     was right the whole time. `epic/KAN-39` then "corrected" `10 gates, 8
//     closed` to `10 gates, 9 closed` — fixing the closed-count while
//     propagating the wrong total, in the same edit, while explicitly
//     correcting a count. Two independent authors made the identical off-by-one
//     on the same document. A total stated in prose beside an enumeration is a
//     second source of truth, and the two drift the moment anybody edits one.
//
//   * Gate 7 is CLOSED on `resumeCause` being a closed enumeration, read at the
//     served CrabCast peer's `contractVersion: 8` / build `9d4d999cbac6`. The
//     row recorded that as PROVENANCE. Nothing said the closure DEPENDS on it —
//     that a new enum member changes the gate's answer the moment somebody
//     deploys. CrabCast has 9, 10 and 11 written and undeployed.
//
// SO THE CHECK IS ON THE CONTAINER, NOT ON ANY GATE'S STATUS. It never asks
// whether a gate should be open; it asks whether the document can still say so.
//
// ── WHAT THIS DOES NOT COVER, AND WHO DOES ────────────────────────────────────
//
// THIS SCRIPT READS A FILE. THE LIVE REGISTER INDEX IS A JIRA DESCRIPTION, AND
// CI CANNOT READ JIRA — there is no Atlassian credential in CI and the daemon's
// proxy is off by default. So drift between what this file says and what
// KAN-348 actually holds is covered by NOTHING here, and I am not going to let
// this script's existence imply otherwise. What closes that gap is a human or
// agent running the pre-flight below against the extracted description before
// posting it; that is a convention, not a mechanism.
//
// The pre-flight is the mode this script exists for:
//
//     node daemon/scripts/verify-gate-register-schema.mjs \
//          --as-description /path/to/extracted-description.md
//
// which measures the WHOLE file against Jira's cap and prints the headroom
// BEFORE the write instead of after the refusal.
//
// Extracting the description is itself the awkward step, and the route is worth
// recording because it is not obvious: a direct REST read is refused for this
// account (`epic/KAN-39`'s own probe stored
// `"Issue does not exist or you do not have permission to see it."`), but an
// Atlassian MCP read whose response exceeds the client's token budget is spilled
// to a file on disk, and the description can be lifted out of that JSON. That is
// how the register was extracted losslessly for KAN-457.
//
// ── RUNNING IT ────────────────────────────────────────────────────────────────
//
//   node daemon/scripts/verify-gate-register-schema.mjs [--verbose]
//   node daemon/scripts/verify-gate-register-schema.mjs <file> [--verbose]
//   node daemon/scripts/verify-gate-register-schema.mjs --as-description <file>
//   node daemon/scripts/verify-gate-register-schema.mjs --cap 32767 --budget 6000
//
// CI-RUNNABLE: yes — reads Markdown off the checkout and matches on it. No
// build, no `npm install`, no daemon, no herdr, no PTY, no network, no
// credential, no peer, no wall clock. It imports only node builtins.
//
// ── HOW TO WATCH IT GO RED ────────────────────────────────────────────────────
//
// Each of these is a one-line mutation of `docs/crabcast-gate-register.md`, and
// each fires a different section. Do them one at a time and put the output back.
//
//   §1  add `--budget 200` to the invocation                  -> over budget
//   §2  change `CLOSED 2026-08-15` on the gate 7 row to `OPEN`
//       without touching the `derived:` comment, or write a
//       total into the index block that disagrees              -> total drift
//   §3  delete the `PINNED-AT` line from the gate 7 example    -> expiry missing
//   §3b replace its `build.commit <sha>` with `contractVersion 8` alone
//                                                              -> version-only
//   §4  change `ON-MOVE  re-measure` to `ON-MOVE  panic`       -> bad vocabulary
//   §5  change `BASIS  external` to `BASIS  sideways`          -> bad basis
//
// §3b is the one worth doing by hand at least once, because it is the failure
// that a reasonable author would not think of: `epic/KAN-59` measured that
// `pty_input`/`pty_resize` behaviour changed between CrabCast's deployed build
// and their `main` while NONE of contract versions 9, 10 or 11 mentions it —
// correctly, because that surface is deliberately uncontracted. A consumer
// tracking the version alone reads 8 -> 11, concludes "three additive
// additions", and is exactly wrong about the change most likely to affect them.
// So a PINNED-AT naming only a version is not a weaker pin; it is a pin on the
// wrong thing, and §3b refuses it.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');
const DEFAULT_DOC = path.join(REPO_ROOT, 'docs', 'crabcast-gate-register.md');

// Jira's description/comment cap. Named here rather than inlined so a red says
// which limit it hit. KAN-457 measured the refusal at 33,766 characters against
// a live 31,743, which brackets it exactly where Atlassian documents it.
const JIRA_CONTENT_CAP = 32767;

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const AS_DESCRIPTION = argv.includes('--as-description');
const numArg = (flag, fallback) => {
  const i = argv.indexOf(flag);
  if (i === -1) return fallback;
  const n = Number(argv[i + 1]);
  if (!Number.isFinite(n)) {
    console.error(`${flag} needs a number, got ${JSON.stringify(argv[i + 1])}`);
    process.exit(2);
  }
  return n;
};
const CAP = numArg('--cap', JIRA_CONTENT_CAP);
const BUDGET = numArg('--budget', null);

const positional = argv.filter((a, i) => {
  if (a.startsWith('--')) return false;
  const prev = argv[i - 1];
  return prev !== '--cap' && prev !== '--budget';
});
const target = positional[0]
  ? path.resolve(process.cwd(), positional[0])
  : DEFAULT_DOC;

let source;
try {
  source = readFileSync(target, 'utf8');
} catch (err) {
  // A setup guard, NOT a verdict: the file we were pointed at is not there.
  console.error(`cannot read ${target}: ${err.message}`);
  process.exit(2);
}

// A path outside the repo renders as a wall of `../`, which is noise in the one
// line a reader of a failure actually looks at.
const show = (p) => {
  const rel = path.relative(REPO_ROOT, p);
  return rel.startsWith('..') ? p : rel;
};

let failures = 0;
const fail = (section, msg, detail) => {
  failures += 1;
  console.error(`FAIL  §${section}  ${msg}`);
  if (detail) console.error(`        ${detail}`);
};
const pass = (section, msg) => {
  if (VERBOSE) console.log(`pass  §${section}  ${msg}`);
};

// ── the index block ───────────────────────────────────────────────────────────
// Delimited by HTML comments so the markers survive the markdown -> ADF -> markdown
// round trip that KAN-333 records, and so a reader pasting the block into Jira
// carries its own boundaries with it.
const BEGIN = '<!-- GATE-INDEX-BEGIN -->';
const END = '<!-- GATE-INDEX-END -->';

function sliceIndex(text) {
  const b = text.indexOf(BEGIN);
  const e = text.indexOf(END);
  if (b === -1 || e === -1 || e < b) return null;
  return text.slice(b + BEGIN.length, e);
}

const indexBlock = sliceIndex(source);

// In --as-description mode we are measuring a Jira description that has not
// been converted to the schema yet — which is the ordinary case and the whole
// point of a pre-flight. Demanding an index block there made the pre-flight exit
// 1 on every well-formed description, and A CHECK THAT ALWAYS FAILS IS A CHECK
// PEOPLE SWITCH OFF. Missing rows are a failure only where rows are promised:
// in the repo document this script defaults to.
if (indexBlock === null) {
  if (AS_DESCRIPTION) {
    console.log('NOTE  no gate-index block in this file — size checked, row schema not applicable');
  } else {
    fail(
      0,
      'no gate-index block found',
      `expected ${BEGIN} ... ${END} in ${show(target)}. ` +
        'Pass --as-description to measure a whole extracted Jira description instead.',
    );
  }
}

const measured = AS_DESCRIPTION ? source : indexBlock;

// ── §1 BUDGET — the number nobody could see ───────────────────────────────────
{
  const label = AS_DESCRIPTION ? 'description' : 'gate-index block';
  const size = measured === null ? source.length : measured.length;
  const ceiling = BUDGET ?? CAP;
  const headroom = ceiling - size;
  const pct = ((size / ceiling) * 100).toFixed(1);
  const line = `${label}: ${size.toLocaleString()} / ${ceiling.toLocaleString()} chars (${pct}%), headroom ${headroom.toLocaleString()}`;
  if (headroom < 0) {
    fail(1, `${label} is OVER its ceiling by ${(-headroom).toLocaleString()} chars`, line);
  } else {
    // Printed unconditionally, not only under --verbose. The whole defect this
    // script exists for is a size nobody looked at, and a size you have to ask
    // for is a size nobody looks at.
    console.log(`SIZE  ${line}`);
    pass(1, `${label} within its ceiling`);
  }
}

// ── row parsing ───────────────────────────────────────────────────────────────
// GATE <n> · <STATUS> [date] · <ticket>
const ROW_RE = /^GATE\s+(\d+)\s+·\s+([A-Z-]+)\b([^\n]*)$/gm;
const FIELD_RE = /^\s{2,}([A-Z][A-Z-]*)\s{2,}(.+?)\s*$/;
const ON_MOVE_VOCAB = ['re-open', 're-measure', 'no-longer-applies'];
const BASIS_VOCAB = ['internal', 'external'];

const rows = [];
if (indexBlock !== null) {
  const lines = indexBlock.split('\n');
  let current = null;
  for (const raw of lines) {
    const head = /^GATE\s+(\d+)\s+·\s+([A-Z-]+)\b(.*)$/.exec(raw);
    if (head) {
      current = { gate: Number(head[1]), status: head[2], rest: head[3], fields: {} };
      rows.push(current);
      continue;
    }
    if (!current) continue;
    const f = FIELD_RE.exec(raw);
    if (f) current.fields[f[1]] = f[2];
    else if (raw.trim() === '') current = null;
  }
}
ROW_RE.lastIndex = 0;

if (indexBlock !== null) {
  if (rows.length === 0) {
    fail(2, 'the gate-index block contains no GATE rows', 'expected lines like `GATE 7 · CLOSED 2026-08-15 · KAN-396`');
  } else {
    pass(2, `${rows.length} gate row(s) parsed`);
  }
}

// ── §2 NO UNDERIVED TOTALS ────────────────────────────────────────────────────
// The enumeration is the source of truth. A total is allowed to appear only if
// it agrees with what is actually enumerated beside it.
if (indexBlock !== null && rows.length > 0) {
  const derivedGates = rows.length;
  const derivedClosed = rows.filter((r) => r.status === 'CLOSED').length;
  const derivedOpen = rows.filter((r) => r.status === 'OPEN').length;

  // `[^\S\n]` — horizontal whitespace only. `\s+` here spans a newline, and on
  // the first run of this script it read the `380` of `KAN-380` followed by the
  // next row's `GATE` as the claim "380 gates". A ticket key is not a total, so
  // the lookbehind refuses a digit that is part of one.
  const claimRe = (word) => new RegExp(String.raw`(?<![\w-])(\d+)[^\S\n]+${word}\b`, 'gi');
  const totalClaims = [
    ...indexBlock.matchAll(claimRe('gates?')),
  ].map((m) => ({ kind: 'gates', claimed: Number(m[1]), derived: derivedGates, text: m[0] }));
  const closedClaims = [
    ...indexBlock.matchAll(claimRe('closed')),
  ].map((m) => ({ kind: 'closed', claimed: Number(m[1]), derived: derivedClosed, text: m[0] }));
  const openClaims = [
    ...indexBlock.matchAll(claimRe('open')),
  ].map((m) => ({ kind: 'open', claimed: Number(m[1]), derived: derivedOpen, text: m[0] }));

  const claims = [...totalClaims, ...closedClaims, ...openClaims];
  let drift = 0;
  for (const c of claims) {
    if (c.claimed !== c.derived) {
      drift += 1;
      fail(
        2,
        `stated total disagrees with the enumeration beside it`,
        `"${c.text}" but ${c.derived} ${c.kind} row(s) are actually enumerated. ` +
          'Derive the total or do not state one.',
      );
    }
  }
  if (drift === 0) {
    pass(2, `no stated total drifts (derived: ${derivedGates} gates, ${derivedClosed} closed, ${derivedOpen} open)`);
  }
  if (VERBOSE) {
    console.log(`      derived from the enumeration: ${derivedGates} gates, ${derivedClosed} closed, ${derivedOpen} open`);
  }
}

// ── §3 THE EXPIRY FIELDS ──────────────────────────────────────────────────────
// A closure resting on somebody else's versioned artefact must say so as a
// CONDITION, and must pin the BUILD rather than only the version.
const BUILD_PIN_RE = /\b(build\.commit|commit)\s+[0-9a-f]{7,40}\b/i;

for (const r of rows) {
  const basis = (r.fields.BASIS || '').trim();
  const basisWord = basis.split(/[\s—-]/)[0].toLowerCase();

  if (!basis) {
    fail(5, `gate ${r.gate}: no BASIS field`, 'every row must declare `internal` or `external`');
    continue;
  }
  if (!BASIS_VOCAB.includes(basisWord)) {
    fail(5, `gate ${r.gate}: BASIS is "${basisWord}"`, `expected one of ${BASIS_VOCAB.join(' | ')}`);
    continue;
  }

  if (basisWord !== 'external') {
    pass(3, `gate ${r.gate}: basis internal, no expiry required`);
    continue;
  }

  const pinned = (r.fields['PINNED-AT'] || '').trim();
  const onMove = (r.fields['ON-MOVE'] || '').trim();

  if (r.status === 'CLOSED' && !pinned) {
    fail(3, `gate ${r.gate}: CLOSED on an external basis with no PINNED-AT`, 'the citation is also an expiry — say so');
  } else if (pinned && !BUILD_PIN_RE.test(pinned)) {
    fail(
      3,
      `gate ${r.gate}: PINNED-AT names no build commit`,
      `got "${pinned}". A version alone is a pin on the wrong thing — an ` +
        'uncontracted surface moves without a version bump. Record build.commit.',
    );
  } else if (pinned) {
    pass(3, `gate ${r.gate}: pinned at a build commit`);
  }

  if (r.status === 'CLOSED' && !onMove) {
    fail(3, `gate ${r.gate}: CLOSED on an external basis with no ON-MOVE`, 'say what happens when the basis moves');
  } else if (onMove) {
    const verb = onMove.split(/[\s—-]/).filter(Boolean)[0];
    const normalised = ON_MOVE_VOCAB.find((v) => onMove.toLowerCase().startsWith(v));
    if (!normalised) {
      fail(
        4,
        `gate ${r.gate}: ON-MOVE is "${verb}"`,
        `expected one of ${ON_MOVE_VOCAB.join(' | ')} — a closed vocabulary, so a reader ` +
          'can act on it without interpreting prose',
      );
    } else {
      pass(4, `gate ${r.gate}: ON-MOVE ${normalised}`);
    }
  }
}

// ── verdict ───────────────────────────────────────────────────────────────────
if (failures === 0) {
  console.log(`OK    ${show(target)}: ${rows.length} row(s), schema intact`);
} else {
  console.error(`\n${failures} failure(s) in ${show(target)}`);
}
process.exit(failures ? 1 : 0);
