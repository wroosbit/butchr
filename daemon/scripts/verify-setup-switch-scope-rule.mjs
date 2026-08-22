// KAN-623: `docs/SETUP.md` must not describe the machine correctly for one
// narrow case while leaving the reader a general belief that is false. Two
// places did, and this script is what keeps them shut.
//
// WHAT FAILURE THIS WOULD CATCH: the document as it stood at `origin/main` on
// 2026-08-21 (`ed227bd`), in two independent halves.
//
//   1. THE LAUNCHER. §6 was the first step that mentioned a daemon at all, so
//      the document read as though the daemon began there. It does not: the
//      native-messaging host is a launcher, and `void ensureDaemonLink()` at the
//      foot of `daemon/src/native-host.ts` brings a daemon up as soon as Chrome
//      connects the extension in §4. Two things follow that the document could
//      not tell you — a box CANNOT be staged inert by stopping short of §6, and
//      the daemon Chrome spawns carries Chrome's environment with no `BUTCHR_*`
//      in it. That second one is the KAN-550 incident §7 already describes from
//      the other end: §7 had the remedy and never the cause.
//
//   2. THE SWITCH RULE. §9 warned, correctly and at length, that turning
//      channels on does not reach agents already running — written as a fact
//      about channels. It is an instance of a general rule (a daemon-side switch
//      never changes what an already-connected client negotiated) that is
//      equally true of `BUTCHR_ATLASSIAN_PROXY` and of an integration's Off
//      control. A reader who never turns channels on met the rule nowhere, and
//      a footnote per switch is a list that is wrong the day a switch is added.
//
// Both halves went red here against `ed227bd` before the fix and green after;
// §5 is what shows the detectors can still go red today.
//
// CI-RUNNABLE: yes — reads `docs/SETUP.md` and `daemon/src/native-host.ts` as
// TEXT off the checkout. Node builtins only: no build, no `dist` import, no
// daemon, no herdr, no credential, no network, no wall clock, no git.
//
// READS SOURCE AS TEXT, NOT `dist`. A failed build does not invalidate this
// verdict — it read what you wrote. (See the `dist`-staleness rule in
// `prompts/task.md`, and note that 17 scripts here do both and must be read per
// section. This one does not.)
//
// ── WHAT THIS SUPPLIES ITSELF, AND WHO COVERS THE REST ─────────────────────
//
// §1–§4 SUPPLY NOTHING. They assert over the real `docs/SETUP.md` and the real
// `daemon/src/native-host.ts` in this checkout.
//
// §5 SUPPLIES ITS OWN INPUT and is the only section that does: it takes the
// real document and DELETES the passages §1–§4 look for, then requires each
// detector to go red on it. Per KAN-145 that proves the detectors can fail —
// never that the document is right, which is §1–§4's job over unmutated text.
// It mutates a string in memory and writes nothing.
//
// WHAT NOBODY COVERS. This script checks that the document SAYS these things.
// That what it says is TRUE of the machine is asserted here only for the
// launcher, and only as far as `ensureDaemonLink()` still being called at the
// foot of `native-host.ts` (§1b) — if that call moves, this goes red and the
// prose needs re-reading. Nothing here executes SETUP.md's steps or observes a
// real install; that is the clean-install rehearsal's, KAN-568/KAN-612, and not
// this script's. The proxy and integration rows of the step 0 table are
// asserted as TEXT and by nothing else here; `registry.ts`'s own comment and
// `writeWorkspaceMcpConfig`'s are where that behaviour lives.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SETUP = path.join(repoRoot, 'docs', 'SETUP.md');
const NATIVE_HOST = path.join(repoRoot, 'daemon', 'src', 'native-host.ts');

const verbose = process.argv.includes('--verbose');

let failures = 0;
const fail = (m) => {
  failures += 1;
  console.error(`  FAIL  ${m}`);
};
const ok = (m) => console.log(`  ok    ${m}`);
const note = (m) => {
  if (verbose) console.log(`        ${m}`);
};

/**
 * The lines of one top-level step, from its `## ` heading to the next one.
 * Returns null when no heading matches, so a renumbered document reports "the
 * section is gone" rather than silently asserting over an empty span.
 */
function sectionOf(markdown, headingRe) {
  const lines = markdown.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^## /.test(lines[i]) && headingRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { startLine: start + 1, endLine: end, text: lines.slice(start, end).join('\n') };
}

/** Every `### ` subheading, with the `## ` step it sits under. */
function subheadings(markdown) {
  const lines = markdown.split('\n');
  const out = [];
  let step = '(before any step)';
  for (let i = 0; i < lines.length; i += 1) {
    if (/^## /.test(lines[i])) step = lines[i].replace(/^##\s+/, '');
    else if (/^### /.test(lines[i])) {
      out.push({ line: i + 1, step, title: lines[i].replace(/^###\s+/, '') });
    }
  }
  return out;
}

/**
 * The four document detectors, as one function per claim, so §5 can re-run the
 * identical predicates against mutated text. A detector returns null when the
 * claim holds and a sentence naming what is missing when it does not.
 */
//
// ⚠ SECTIONS ARE LOCATED BY NAME, NEVER BY NUMBER. `task/KAN-621` renumbers
// these steps — it swaps *Load the extension into Chrome* with *Register the
// native-messaging host* — so a detector keyed on `## 4.` would, after that
// merge, assert over whichever section happened to land at 4 and report a
// green about the wrong prose. That is this repository's own convention:
// KAN-621's document says steps are referred to by name "so that a future
// reorder of this document cannot silently invalidate it".
const LOAD_STEP = /^## \d+(\.\d+)?\. .*Load the extension into Chrome/;
const AUTOSTART_STEP = /^## \d+(\.\d+)?\. .*Autostart, and the file-descriptor ceiling/;
const CHECK_STEP = /^## \d+(\.\d+)?\. .*Check that it worked/;
const CHANNELS_STEP = /^## \d+(\.\d+)?\. .*agent-to-agent channels/;

const DETECTORS = {
  'launcher-where-the-extension-is-loaded': (doc) => {
    const s = sectionOf(doc, LOAD_STEP);
    if (!s) return 'no *Load the extension into Chrome* step in the document';
    if (!/starts the daemon/i.test(s.text)) {
      return 'the extension-loading step does not say it *starts the daemon*';
    }
    if (!/native-host\.(ts|sh)/.test(s.text)) {
      return 'it says so but names no source file a reader could check (`native-host.ts` / `native-host.sh`)';
    }
    if (!/launcher/i.test(s.text)) {
      return 'it does not call the native-messaging host a *launcher*';
    }
    return null;
  },

  'autostart-is-not-where-the-daemon-begins': (doc) => {
    const s = sectionOf(doc, AUTOSTART_STEP);
    if (!s) return 'no *Autostart, and the file-descriptor ceiling* step in the document';
    if (!/does not start it|already\s+\n?did|does not start the daemon/i.test(s.text)) {
      return 'the autostart step does not say that it is not what starts the daemon';
    }
    if (!/inert/i.test(s.text)) {
      return 'the autostart step does not answer the staging question — no mention of an *inert* box';
    }
    if (!/Load the extension into Chrome/.test(s.text)) {
      return 'the autostart step does not name the step that DOES start the daemon';
    }
    return null;
  },

  'kan-550-names-its-cause': (doc) => {
    const s = sectionOf(doc, CHECK_STEP);
    if (!s) return 'no *Check that it worked* step in the document';
    if (!/KAN-550/.test(s.text)) return 'the check step no longer mentions KAN-550';
    if (!/Load the extension into Chrome/.test(s.text)) {
      return 'the KAN-550 paragraph does not point at *Load the extension into Chrome*, so the incident still arrives without its cause';
    }
    return null;
  },

  'switch-rule-lives-outside-step-9': (doc) => {
    const subs = subheadings(doc);
    const rule = subs.filter((h) => /switch/i.test(h.title) && /already running/i.test(h.title));
    if (rule.length === 0) return 'no subheading states the switch/already-running rule anywhere';
    const outside = rule.filter((h) => !/agent-to-agent channels/i.test(h.step));
    if (outside.length === 0) {
      return `the rule is stated only inside step 9 (${rule.map((h) => `line ${h.line}`).join(', ')})`;
    }
    const channels = sectionOf(doc, CHANNELS_STEP);
    if (!channels) return 'no agent-to-agent channels step in the document';
    if (!/switch you flip does not reach/i.test(channels.text)) {
      return 'the channels step does not point at the general rule, so its warning still reads as a fact about channels';
    }
    return null;
  }
};

const doc = fs.readFileSync(SETUP, 'utf8');

// ── §1a. The extension-loading step carries the launcher claim, checkably ───
console.log('\n§1a  the launcher claim is where the extension is loaded, and names a file');
{
  const why = DETECTORS['launcher-where-the-extension-is-loaded'](doc);
  if (why) fail(why);
  else {
    const s = sectionOf(doc, LOAD_STEP);
    ok(`lines ${s.startLine}-${s.endLine} say the extension starts the daemon and name the source`);
  }
}

// ── §1b. …and the mechanism it names is still there ─────────────────────────
console.log('\n§1b  the mechanism the prose points at still exists in the source');
{
  const src = fs.readFileSync(NATIVE_HOST, 'utf8');
  const lines = src.split('\n');
  // Unindented, so this is the module-level call Chrome's start reaches — not
  // the one inside `ensureDaemonLink`'s own retry path, which is indented and
  // proves nothing about what runs on startup.
  const call = lines.findIndex((l) => /^void ensureDaemonLink\(\);/.test(l));
  if (call < 0) {
    fail(
      '`void ensureDaemonLink()` is no longer called at top level in daemon/src/native-host.ts — ' +
        'the §4 prose asserts a mechanism this file no longer has'
    );
  } else {
    ok(`daemon/src/native-host.ts:${call + 1} calls ensureDaemonLink() at top level`);
    note(lines[call].trim());
  }
}

// ── §2. §6 says what it adds, and answers the staging question ──────────────
console.log('\n§2   the autostart step does not claim to be where the daemon begins');
{
  const why = DETECTORS['autostart-is-not-where-the-daemon-begins'](doc);
  if (why) fail(why);
  else ok('it disclaims the start, names the step that does it, and answers the inert-box question');
}

// ── §3. §7's KAN-550 paragraph reaches its cause ────────────────────────────
console.log('\n§3   the check step connects the KAN-550 incident to its cause');
{
  const why = DETECTORS['kan-550-names-its-cause'](doc);
  if (why) fail(why);
  else ok('KAN-550 is named alongside *Load the extension into Chrome*');
}

// ── §4. The switch rule is stated outside §9, and §9 points at it ───────────
console.log('\n§4   the switch rule is reachable without reading the channels step');
{
  const why = DETECTORS['switch-rule-lives-outside-step-9'](doc);
  if (why) fail(why);
  else {
    const h = subheadings(doc).find(
      (x) =>
        /switch/i.test(x.title) &&
        /already running/i.test(x.title) &&
        !/agent-to-agent channels/i.test(x.step)
    );
    ok(`the rule is stated at line ${h.line}, under "${h.step}", and the channels step points at it`);
  }
}

// ── §5. The detectors can still go red — mutate the real document ───────────
//
// Each mutation deletes exactly what one detector looks for and requires THAT
// detector to fail. A mutation that no longer changes anything is itself
// reported, because a delete that removes nothing would leave a green that
// proves the detector unfalsifiable rather than satisfied.
console.log('\n§5   each detector goes red when its passage is removed (detector red drive)');
{
  const MUTATIONS = [
    {
      detector: 'launcher-where-the-extension-is-loaded',
      what: 'drop the extension-loading step entirely',
      apply: (d) => {
        const s = sectionOf(d, LOAD_STEP);
        const lines = d.split('\n');
        return [...lines.slice(0, s.startLine - 1), ...lines.slice(s.endLine)].join('\n');
      }
    },
    {
      detector: 'launcher-where-the-extension-is-loaded',
      what: 'keep the step but remove the phrase "starts the daemon" from it',
      apply: (d) => {
        const s = sectionOf(d, LOAD_STEP);
        const lines = d.split('\n');
        const cut = s.text.replace(/starts the daemon/gi, 'does a thing');
        return [...lines.slice(0, s.startLine - 1), ...cut.split('\n'), ...lines.slice(s.endLine)].join('\n');
      }
    },
    {
      detector: 'autostart-is-not-where-the-daemon-begins',
      what: 'remove the word "inert" from the autostart step',
      apply: (d) => {
        const s = sectionOf(d, AUTOSTART_STEP);
        const lines = d.split('\n');
        const cut = s.text.replace(/inert/gi, 'quiet');
        return [...lines.slice(0, s.startLine - 1), ...cut.split('\n'), ...lines.slice(s.endLine)].join('\n');
      }
    },
    {
      detector: 'kan-550-names-its-cause',
      what: 'remove the cause pointer from the check step',
      apply: (d) => {
        const s = sectionOf(d, CHECK_STEP);
        const lines = d.split('\n');
        const cut = s.text.replace(/Load the extension into Chrome/g, 'that step');
        return [...lines.slice(0, s.startLine - 1), ...cut.split('\n'), ...lines.slice(s.endLine)].join('\n');
      }
    },
    {
      detector: 'switch-rule-lives-outside-step-9',
      what: 'delete the rule subheading, leaving the channels step as the only statement',
      apply: (d) =>
        d
          .split('\n')
          .filter((l) => !(/^### /.test(l) && /switch/i.test(l) && /already running/i.test(l)))
          .join('\n')
    }
  ];

  for (const m of MUTATIONS) {
    const before = DETECTORS[m.detector](doc);
    if (before !== null) {
      fail(`cannot run the red drive for ${m.detector}: it is already red on the real document (${before})`);
      continue;
    }
    const mutated = m.apply(doc);
    if (mutated === doc) {
      fail(`mutation "${m.what}" changed nothing, so it tested nothing about ${m.detector}`);
      continue;
    }
    const after = DETECTORS[m.detector](mutated);
    if (after === null) {
      fail(`${m.detector} stayed GREEN after "${m.what}" — the detector cannot fail and is not a gate`);
    } else {
      ok(`${m.detector} goes red on "${m.what}"`);
      note(`reported: ${after}`);
    }
  }
}

console.log('');
if (failures) {
  console.error(`${failures} failure(s).`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);
