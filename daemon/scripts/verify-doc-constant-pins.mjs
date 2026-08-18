// Live proof for KAN-347 part 1: a document that names a constant cannot drift
// from it silently.
//
// WHAT FAILURE THIS WOULD CATCH: a constant moving while the prose that quotes
// its value stays behind, with every required check green. Measured on
// ourselves — KAN-324 moved `CRABCAST_CONTRACT_VERSION` 3 → 4 to consume
// `unreadableRecordsTotal` and did not move `docs/crabcast-runtime.md`, so the
// document described an older version of itself for days. `daemon-typecheck`,
// `verify-script-sweep`, `ci-partition` and `operative-rule-carriage` were all
// green throughout. It was caught by a person (`task/KAN-283`) going to read
// the constant instead of quoting the sentence, and by then the stale `3` had
// been relayed to another project as a statement about what Butchr consumes.
//
// CI-RUNNABLE: yes — reads `docs/*.md` and `daemon/src/*.ts` off the checkout
// as text and asserts on their contents; node builtins only, no build, no
// daemon, no herdr, no credential, no peer, no terminal, no network.
//
// ## The mechanism, in one sentence
//
// The document carries a digest of the declaration it describes, and this check
// recomputes it. The shape was offered in prose by `epic/KAN-59`, who tested
// KAN-347's generalisation against their own tree rather than agreeing with it
// and reported it false for their read-path contract. **No CrabCast source was
// read to build this** — invariant 10 is permanent, and the sentence above is
// the whole of what was taken.
//
// A pin is an HTML comment, so it is invisible in the rendered page:
//
//   <!-- constant-pin: CRABCAST_CONTRACT_VERSION
//        src: daemon/src/crabcast-link.ts
//        sha256: <first 12 hex of sha256 over the normalised declaration>
//        says: **CrabCast read-path contract version:** **`4`** -->
//
// ## Why it takes three legs and not one, which is the whole of the design
//
// A digest alone catches the constant moving and nothing else: bump the prose
// and leave the code, and the digest still matches. A quoted sentence alone
// catches the prose being rewritten and nothing else. Neither alone stops the
// marker itself from lying. The three legs close on each other:
//
//   §2 digest      — the declaration hashes to what the pin says it does.
//                    Constant moves, prose does not → RED here.
//   §3 says-present— the pin's `says:` string appears verbatim in the document.
//                    Prose rewritten away from the pin → RED here.
//   §4 says-honest — the declaration's own literal value appears inside that
//                    `says:` string. Digest refreshed without touching the
//                    prose → RED here, which is the loophole the other two
//                    leave open and the reason this leg exists.
//
// So there is no single-file edit that moves the constant and leaves this
// green. Refreshing the digest without correcting the sentence fails §4;
// correcting the sentence in the marker but not in the page fails §3.
//
// ## THE SCOPE OF THIS GUARD, STATED BECAUSE A GUARD THAT READS WIDER THAN IT
// ## IS, IS THE DEFECT IT WAS BUILT TO PREVENT
//
// It covers **exactly the constants in `GUARDED` below, in `docs/**​/*.md`**,
// and it covers them at the sentences their pins quote. It does not cover:
//
//   - **Any constant not in `GUARDED`.** There is no discovery here. A new
//     constant described in prose is unguarded until somebody adds a row.
//   - **`prompts/*.md`, `README.md`, source docblocks, Confluence, Jira.**
//     `docs/` only. The guardian-poke cadence used to be the known live
//     instance outside that boundary — `DEFAULT_POKE_INTERVAL_MS` in
//     `guardian.ts` against "pokes you every 30 minutes" in all three prompts.
//     KAN-351 resolved that pair by DELETING IT rather than pinning it: the
//     prompts no longer name an interval, so there is no prose left for the
//     constant to drift from and nothing here to guard. Note which way that
//     cuts — it removed one instance and did not widen this script's scope, so
//     `prompts/` is still unguarded ground for the NEXT constant somebody
//     quotes there. See `docs/doc-constant-drift.md`, F-1.
//     **The source docblocks in `guardian.ts` and `daemon.ts` still say
//     "thirty minutes", and `mcp.ts` still says "defaults to 30 minutes".**
//     Those are unguarded by construction and were left alone deliberately:
//     they sit beside the declaration, where a reader moving the constant has
//     them on screen, and none of them is asserted by a required check — so
//     neither half of the F-1 shape applies. That is a judgement, not a
//     measurement.
//   - **Abbreviations and prefixes.** §5 finds a mention by the constant's
//     *name* or its *full* literal value. `docs/crabcast-runtime.md` says
//     "`CRABCAST_PIN` still reads `8d7348f`" — a seven-character prefix — and
//     nothing here reads that as a claim about the value. It is caught only
//     because that line also names the constant.
//   - **Whether the prose is *right*.** §3 and §4 establish that the sentence
//     quotes the current value. A sentence that quotes the right number and
//     describes it wrongly passes every leg here.
//   - **Unpinned sentences in a pinned file.** §5 is file-level: it requires a
//     file that mentions a guarded constant to carry a pin for it, never that
//     every mention in that file is itself pinned.
//   - **A file that declares itself exempt.** A page can name a guarded constant
//     without quoting its value, and `<!-- constant-pin-exempt: NAME — reason -->`
//     is how it says so. The reason is required and is checked for length, which
//     stops the marker becoming a silent switch; what it cannot check is whether
//     the reason is *true*. That one is a reviewer's job, and it is on the face
//     of the document rather than in this script.
//
// ## THIS SCRIPT DOES NOT WRITE THE RECORD IT ASSERTS ON, WHICH IS THE POINT
//
// Every leg reads the real `docs/` and the real `daemon/src` off the checkout.
// There is no fixture and no constructed input, so a green run is a statement
// about this tree rather than about a record the script made for itself
// (KAN-145's defect). The cost of that choice is that the legs cannot be shown
// firing without damaging the tree, so the red drive is a recipe rather than a
// section — see below, and see the PR body for its real output.
//
// WHAT THAT LEAVES UNCOVERED, and who covers it:
//
//   - That `GUARDED` names every pair worth guarding. Nothing mechanical can
//     know that. `docs/doc-constant-drift.md` is the written audit of what was
//     searched and what was found; it is a dated statement, not a standing one.
//   - The part-2 shape — a check that asserts a document keeps saying something
//     that has stopped being true. This script is itself part-2-shaped by
//     construction, and §4 is what keeps it honest: it can only demand a
//     sentence that quotes the value the code actually holds today, so it
//     cannot outlive the truth of what it pins. That argument is written out
//     in `docs/doc-constant-drift.md` rather than left to inference.
//
// ## Made to go red — the recipe, because the legs read the real tree
//
//   # §2, the measured case: constant moves, prose does not
//   perl -pi -e 's/CRABCAST_CONTRACT_VERSION = 4;/CRABCAST_CONTRACT_VERSION = 5;/' daemon/src/crabcast-link.ts
//   node daemon/scripts/verify-doc-constant-pins.mjs   # exit 1
//   git checkout -- daemon/src/crabcast-link.ts
//
//   # §3, the reverse: prose moves, constant does not
//   perl -pi -e 's/\*\*`4`\*\*/**`5`**/' docs/crabcast-runtime.md
//   node daemon/scripts/verify-doc-constant-pins.mjs   # exit 1
//   git checkout -- docs/crabcast-runtime.md
//
//   # §4, the loophole: digest refreshed, sentence not
//   #   bump the constant, run with --digests, paste the new digest into the
//   #   pin, leave the prose alone. §2 goes green and §4 goes red.
//
//   # §5, coverage: a guarded constant loses its last pin
//   perl -0pi -e 's/<!-- constant-pin: CRABCAST_PIN.*?-->//s' docs/crabcast-runtime.md
//   node daemon/scripts/verify-doc-constant-pins.mjs   # exit 1
//   git checkout -- docs/crabcast-runtime.md
//
//   # KAN-536's arms, run on VERIFIED_CLIENT_VERSIONS when its row was added.
//   # COMMIT FIRST: both arms are restored with `git checkout --`, which throws
//   # away any uncommitted edit to the same file — it ate the new pin once.
//
//   # §2 and §4 across BOTH pinned documents at once: append a version
//   perl -pi -e "s/\['2\.1\.224', '2\.1\.226'\];/['2.1.224', '2.1.226', '2.1.230'];/" daemon/src/channel-selfcheck.ts
//   node daemon/scripts/verify-doc-constant-pins.mjs   # exit 1, 4 failures
//   git checkout -- daemon/src/channel-selfcheck.ts
//
//   # §5 across both documents: delete both pins for it
//   perl -0pi -e 's/<!-- constant-pin: VERIFIED_CLIENT_VERSIONS.*?-->\n\n//s' docs/channel-selfcheck.md
//   perl -0pi -e 's/<!-- constant-pin: VERIFIED_CLIENT_VERSIONS.*?-->\n//s'   docs/SETUP.md
//   node daemon/scripts/verify-doc-constant-pins.mjs   # exit 1, 3 failures
//
//   # …and the control that says the row is what caused it: with those same two
//   # pins still deleted, take the VERIFIED_CLIENT_VERSIONS row back out of
//   # GUARDED and re-run — exit 0, zero failures. A red that appears without a
//   # green beside it under the one changed variable has not been attributed.
//   git checkout -- docs/channel-selfcheck.md docs/SETUP.md
//
// A NOTE ON WHAT KIND OF PROOF THIS IS, because the fleet rule turns on it:
// nothing here imports from `dist`. Every leg `readFileSync`s `docs/*.md` and
// `daemon/src/*.ts` as text, so a failed build does not invalidate a verdict
// from this script — it read what you wrote, not what was last compiled.
//
// Sections:
//
//   1. every pin is well-formed and resolves to a real declaration
//   2. the declaration digests to what the pin claims
//   3. the pin's `says:` appears verbatim in the document
//   4. the declaration's literal value appears inside that `says:`
//   5. coverage — every guarded constant is pinned, and every doc that mentions
//      one carries a pin for it
//
// Usage: node daemon/scripts/verify-doc-constant-pins.mjs [--verbose] [--digests]

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const verbose = process.argv.includes('--verbose');
const digestsOnly = process.argv.includes('--digests');

/**
 * The constants this guard covers. Adding a row here without adding a pin to a
 * document is a §5 failure, which is deliberate: the alternative is deriving
 * the set from the pins themselves, and then deleting a document's last pin
 * would delete the assertion that would have noticed it was deleted. Same
 * two-file shape `rule-inventory.md` uses, for the same reason.
 */
const GUARDED = [
  { name: 'CRABCAST_CONTRACT_VERSION', src: 'daemon/src/crabcast-link.ts' },
  { name: 'CRABCAST_PIN', src: 'daemon/src/crabcast-link.ts' },
  // KAN-378 added the three below. `docs/crabcast-cutover-sequence.md` is an
  // operational sequence whose steps turn on these values — which variable is
  // set at the flip, what refills a drained fleet, and how long "it came back
  // on its own" is — so a move in any of them makes a step wrong rather than
  // merely out of date. That is the same argument the two rows above were
  // added on, applied to a document somebody reads during an incident.
  { name: 'RUNTIME_ENV_VAR', src: 'daemon/src/runtime-switch.ts' },
  { name: 'BOARD_JQL', src: 'daemon/src/board-reconcile.ts' },
  { name: 'BOARD_CYCLE_MS', src: 'daemon/src/board-reconcile.ts' },
  // KAN-536 added this one and DELIBERATELY LEFT `DEV_CHANNELS_FLAG` OUT. Both
  // were pinned in `docs/SETUP.md` by KAN-532 and neither was guarded; this is
  // the ticket that decided them, and it decided them apart. The argument turns
  // on a property of §5 that is easy to assume the other way round, so it was
  // measured rather than reasoned:
  //
  //   §5 FINDS A MENTION BY THE CONSTANT'S NAME OR ITS *CURRENT* FULL LITERAL
  //   VALUE. So when a value moves, every document that mentioned it only by
  //   that value STOPS BEING SEEN — §5 goes SILENT on it, not red. Coverage is
  //   a statement about the tree now, never a tripwire for the move itself.
  //
  // `VERIFIED_CLIENT_VERSIONS` is in because that silence does not reach the
  // document that matters. `docs/channel-selfcheck.md` names the constant, so
  // it is NAME-detected and stays watched across a value change — and it is the
  // page carrying the per-version table that IS the prose form of the list. The
  // list grows by hand every time somebody measures a new client, which makes
  // it the most movable constant of the pair, and until this row existed that
  // table had nothing watching it at all.
  //
  // `DEV_CHANNELS_FLAG` is out. Measured on this tree (fences and markers
  // stripped, exactly as §5 reads them): 9 documents mention it, 8 of them by
  // the flag string alone. Rename the flag upstream — the one event guarding it
  // is for — and §5 sees 1 of the 9. So a row here would not watch the eight
  // stale pages through the rename; it would only require, today, that all
  // eight carry a pin. What those eight pins would add is eight §2 legs hanging
  // off ONE declaration, all firing on the same edit that already turns
  // SETUP.md's existing pin red — pins are checked in §1–§4 whether or not the
  // constant is in `GUARDED`, so that tripwire is already armed. Against that,
  // each pin freezes a sentence of ordinary prose under §3. Eight copies of one
  // signal, bought with eight editorial constraints, is the wrong trade, and
  // eight readings that share an upstream cause are one reading regardless.
  // The reasoning and its measurement are in `docs/doc-constant-drift.md`.
  { name: 'VERIFIED_CLIENT_VERSIONS', src: 'daemon/src/channel-selfcheck.ts' },
];

const DOCS_DIR = path.join(repoRoot, 'docs');

let failures = 0;

function rule(title) {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

/**
 * `whyFailed` is printed only on failure and `whyPassed` only under --verbose,
 * and they are separate arguments deliberately: a single `detail` shared by
 * both paths prints a failure explanation next to the word PASS, which is a
 * small instance of exactly what this script is about — an artifact whose
 * wording claims something its mechanism is not doing.
 */
function check(label, ok, whyFailed, whyPassed) {
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    failures++;
    if (whyFailed) console.log(`         ${String(whyFailed).split('\n').slice(0, 4).join('\n         ')}`);
  } else if (verbose && whyPassed) {
    console.log(`         ${String(whyPassed).split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------- setup --
//
// Exit 2, never 1: a missing `docs/` is this script being run from the wrong
// place, and reporting it as a verdict would say the tree is broken when the
// invocation is.
if (!fs.existsSync(DOCS_DIR)) {
  console.error(`setup: ${DOCS_DIR} does not exist — run this from a Butchr checkout.`);
  process.exit(2);
}

/**
 * The canonical declaration of `name` in `source`: from the line declaring it
 * to the first line that closes the statement. Multi-line declarations are
 * supported; the digest is over the whole statement, whitespace-normalised, so
 * reflowing it does not churn every digest in the tree but changing what it
 * declares does.
 */
function declarationOf(source, name) {
  const lines = source.split('\n');
  const opensAt = lines.findIndex((l) => new RegExp(`^\\s*export const ${name}\\b`).test(l));
  if (opensAt === -1) return null;
  for (let i = opensAt; i < lines.length && i < opensAt + 40; i++) {
    if (/;\s*$/.test(lines[i])) {
      return { text: lines.slice(opensAt, i + 1).join('\n'), line: opensAt + 1 };
    }
  }
  return null;
}

/** Whitespace-normalised, so a reflow is not a change and a retyping is. */
const normalise = (s) => s.replace(/\s+/g, ' ').trim();

const digestOf = (declText) =>
  crypto.createHash('sha256').update(normalise(declText), 'utf8').digest('hex').slice(0, 12);

/**
 * The literal on the right of `=`, with surrounding quotes stripped. This is
 * what §4 requires the prose to quote — `4`, or the 40-character commit sha.
 */
function literalValueOf(declText) {
  const m = normalise(declText).match(/=\s*(.+?);?$/);
  if (!m) return null;
  return m[1].trim().replace(/^['"`](.*)['"`]$/, '$1');
}

/**
 * Blank out fenced code blocks, keeping line numbering intact.
 *
 * A MARKER SHOWN IS NOT A MARKER ASSERTED, and this is KAN-321's defect in
 * miniature. `task/KAN-317` asked for an approval on #139 by pasting the exact
 * `BUTCHR-APPROVAL:` line it wanted inside a code fence, and `approval-recorded`
 * went green fifteen seconds later describing an approval nobody had given. The
 * same thing happened here on the first run: `docs/doc-constant-drift.md`
 * documents the marker format by showing one in a ``` block, and this script
 * read the illustration as a real pin and then failed §3 because the
 * illustration's sentence is not in the page.
 *
 * So a pin only counts at the top level of a document, exactly as an approval
 * marker only counts unfenced. The parallel is not decorative: both are markers
 * that make a machine believe something, and a document that explains the
 * format will always contain an example of it.
 */
function stripFences(text) {
  let fenced = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced;
        return '';
      }
      return fenced ? '' : line;
    })
    .join('\n');
}

/** Every `<!-- constant-pin: NAME  key: value … -->` block in a document. */
function pinsIn(text, file) {
  const out = [];
  const re = /<!--\s*constant-pin:\s*([A-Z0-9_]+)\s*([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const fields = {};
    for (const line of m[2].split('\n')) {
      const kv = line.match(/^\s*([a-z0-9]+):\s*(.*?)\s*$/i);
      if (kv) fields[kv[1].toLowerCase()] = kv[2];
    }
    out.push({ name: m[1], fields, file, raw: m[0] });
  }
  return out;
}

/**
 * `<!-- constant-pin-exempt: NAME — reason -->`.
 *
 * A page can name a guarded constant without quoting its value — this audit's
 * own `doc-constant-drift.md` discusses both of them at length and states
 * neither. §5 would otherwise demand a pin there, and the two ways out of that
 * are both worse than an exemption: narrowing §5 to full literal values would
 * blind it to `CRABCAST_CONTRACT_VERSION` entirely, whose value is `4` and far
 * too short to search for, and dropping §5 gives up the leg. So the file says
 * so, out loud, with a reason a reviewer can disagree with.
 *
 * A REASON IS REQUIRED, and a bare exemption is a §5 failure. The point is not
 * the marker — it is that switching the guard off has to be a sentence somebody
 * signed rather than an absence nobody notices.
 */
function exemptionsIn(text, file) {
  const out = [];
  const re = /<!--\s*constant-pin-exempt:\s*([A-Z0-9_]+)\s*[—-]\s*([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({ name: m[1], reason: m[2].trim(), file });
  }
  return out;
}

/** Both marker kinds, so neither can satisfy a search by containing its own subject. */
const stripMarkers = (text) => text.replace(/<!--\s*constant-pin(-exempt)?:[\s\S]*?-->/g, '');

const docFiles = fs
  .readdirSync(DOCS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => ({ rel: path.posix.join('docs', f), text: fs.readFileSync(path.join(DOCS_DIR, f), 'utf8') }));

// Fences stripped first, everywhere: a pin, an exemption and a pinned sentence
// all only count at the top level of the page.
for (const d of docFiles) d.body = stripFences(d.text);

const allPins = docFiles.flatMap((d) => pinsIn(d.body, d.rel));
const allExemptions = docFiles.flatMap((d) => exemptionsIn(d.body, d.rel));

// `--digests` exists so that whoever bumps a constant can read the value this
// script will demand, rather than computing a sha by hand. It reports and
// changes nothing; there is deliberately no --fix, because a guard that can
// silence itself is not a guard.
if (digestsOnly) {
  for (const g of GUARDED) {
    const src = fs.readFileSync(path.join(repoRoot, g.src), 'utf8');
    const decl = declarationOf(src, g.name);
    if (!decl) {
      console.log(`${g.name}: NOT FOUND in ${g.src}`);
      continue;
    }
    console.log(`${g.name}\n  src:    ${g.src}:${decl.line}\n  sha256: ${digestOf(decl.text)}\n  value:  ${literalValueOf(decl.text)}`);
  }
  process.exit(0);
}

console.log(`docs/ files read: ${docFiles.length} · pins found: ${allPins.length} · guarded constants: ${GUARDED.length}`);

// ------------------------------- 1. every pin is well-formed and resolves --

rule('1. Every pin is well-formed and names a declaration that exists');

const resolved = [];

for (const pin of allPins) {
  const where = `${pin.file} · ${pin.name}`;
  const missing = ['src', 'sha256', 'says'].filter((k) => !pin.fields[k]);
  check(
    `${where}: carries src, sha256 and says`,
    missing.length === 0,
    `missing: ${missing.join(', ')}`,
    'src, sha256 and says all present'
  );
  if (missing.length) continue;

  const srcPath = path.join(repoRoot, pin.fields.src);
  const exists = fs.existsSync(srcPath);
  check(`${where}: ${pin.fields.src} exists`, exists);
  if (!exists) continue;

  const decl = declarationOf(fs.readFileSync(srcPath, 'utf8'), pin.name);
  check(`${where}: declares \`export const ${pin.name}\``, decl !== null);
  if (!decl) continue;

  resolved.push({ ...pin, decl });
}

// A pin naming a constant nobody guards is not an error — the mechanism is
// general — but it is worth saying out loud, because §5's coverage leg will
// not be watching it.
for (const pin of allPins) {
  if (!GUARDED.some((g) => g.name === pin.name)) {
    console.log(`   NOTE  ${pin.file} pins ${pin.name}, which is not in GUARDED — §5 does not watch it`);
  }
}

// --------------------------------------------------- 2. the digest matches --

rule('2. The declaration digests to what the pin claims (constant moved, prose did not)');

for (const pin of resolved) {
  const actual = digestOf(pin.decl.text);
  check(
    `${pin.file} · ${pin.name}: sha256 ${pin.fields.sha256}`,
    actual === pin.fields.sha256,
    `pin says ${pin.fields.sha256}, ${pin.fields.src}:${pin.decl.line} hashes to ${actual}\n` +
      `the declaration is now: ${normalise(pin.decl.text)}\n` +
      `if the new value is correct, update the prose AND run --digests for the new sha`,
    `${pin.fields.src}:${pin.decl.line} — ${normalise(pin.decl.text)}`
  );
}

// ------------------------------- 3. the pinned sentence is still in the page --

rule('3. The pin\'s `says:` appears verbatim in the document (prose rewritten away from the pin)');

for (const pin of resolved) {
  const doc = docFiles.find((d) => d.rel === pin.file);
  // The marker itself contains `says:`, so strip every pin block before
  // searching — otherwise a pin would satisfy itself.
  const body = stripMarkers(doc.body);
  check(
    `${pin.file} · ${pin.name}: page still says "${pin.fields.says}"`,
    body.includes(pin.fields.says),
    `not found outside the marker — the sentence was rewritten, or the marker was updated and the page was not`
  );
}

// ---------------------------- 4. the pinned sentence quotes the real value --

rule('4. The declaration\'s literal value appears inside that `says:` (digest refreshed, sentence not)');

for (const pin of resolved) {
  const value = literalValueOf(pin.decl.text);
  check(
    `${pin.file} · ${pin.name}: "${pin.fields.says}" quotes ${value}`,
    value !== null && pin.fields.says.includes(value),
    `the declaration holds ${value}; the pinned sentence does not contain it. ` +
      `Refreshing the sha without correcting the prose is exactly what this leg is for.`
  );
}

// ------------------------------------------------------------ 5. coverage --

rule('5. Coverage — every guarded constant is pinned, and every doc mentioning one carries a pin');

for (const g of GUARDED) {
  const pinsForIt = allPins.filter((p) => p.name === g.name);
  check(
    `${g.name}: pinned by at least one document`,
    pinsForIt.length > 0,
    `no <!-- constant-pin: ${g.name} … --> anywhere under docs/. Either pin it, or remove the row from GUARDED and say why.`
  );

  const src = fs.existsSync(path.join(repoRoot, g.src))
    ? fs.readFileSync(path.join(repoRoot, g.src), 'utf8')
    : '';
  const decl = declarationOf(src, g.name);
  const value = decl ? literalValueOf(decl.text) : null;

  for (const doc of docFiles) {
    const body = stripMarkers(doc.body);
    // A mention is the constant's NAME or its FULL literal value. Prefixes and
    // abbreviations are not mentions here — see the scope note in the header.
    const mentions =
      body.includes(g.name) || (value !== null && value.length >= 8 && body.includes(value));
    if (!mentions) continue;

    const exemption = allExemptions.find((e) => e.file === doc.rel && e.name === g.name);
    if (exemption) {
      check(
        `${doc.rel} is exempt from pinning ${g.name}, with a reason`,
        exemption.reason.length >= 20,
        `the exemption gives no reason worth reading: "${exemption.reason}"`,
        exemption.reason
      );
      continue;
    }

    check(
      `${doc.rel} mentions ${g.name} and carries a pin for it`,
      pinsForIt.some((p) => p.file === doc.rel),
      `${doc.rel} describes ${g.name} with no pin and no <!-- constant-pin-exempt: ${g.name} — reason --> ` +
        `— that document can drift silently`,
      `pinned here`
    );
  }
}

// -------------------------------------------------------------- verdict --

rule('Verdict');
console.log(
  failures === 0
    ? `   ${allPins.length} pins over ${GUARDED.length} guarded constants — every one matches its declaration.`
    : `   ${failures} failure(s). A document and the constant it describes disagree inside the same commit.`
);

process.exit(failures ? 1 : 0);
