#!/usr/bin/env node
// butchr-doctor — answers "did the setup actually work?" without guessing.
//
// Every step in docs/SETUP.md has a check here, so following the document ends
// in a verdict rather than in a hope. Written against the standard KAN-33 was
// held to: a setup step that cannot be verified is a setup step that quietly
// stops being true, which is how the fd limit, the native-messaging manifest
// and the stale dist/ all became tacit knowledge on one machine.
//
// No dependencies and no build step: it must run against a clone that has not
// been built yet, because "you did not build it" is one of the answers.
//
// Exit codes: 0 = all checks pass (warnings allowed), 1 = at least one FAIL.

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
// KAN-598. A source import, not a built one: this script's contract is that it
// runs against a clone nobody has built yet, and `lib/` is plain .mjs for
// exactly that reason.
import { readJournal, describeJournalReading } from './lib/journal-reading.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BUTCHR_DIR = path.join(os.homedir(), '.local', 'share', 'butchr');
const SOCKET_PATH = path.join(BUTCHR_DIR, 'butchr.sock');
const HOST_NAME = 'com.butchr.daemon';

/** Measured on herdr 0.6.4 — see daemon/src/herdr-health.ts and KAN-24. */
const PTMX_FDS_PER_PANE = 5;
/** The default soft limit, which is also FD_SETSIZE. Setup exists to beat it. */
const FD_SETSIZE = 1024;

const results = [];
const record = (level, name, detail) => {
  results.push({ level, name, detail });
  const tag = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }[level];
  console.log(`${tag}  ${name}`);
  for (const line of String(detail).split('\n')) console.log(`      ${line}`);
};
const pass = (n, d) => record('pass', n, d);
const warn = (n, d) => record('warn', n, d);
const fail = (n, d) => record('fail', n, d);

function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/** Newest mtime under `dir`, skipping node_modules and dist. */
function newestMtime(dir, skip = new Set(['node_modules', 'dist', '.git'])) {
  let newest = 0;
  let newestFile = null;
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        try {
          const m = fs.statSync(full).mtimeMs;
          if (m > newest) { newest = m; newestFile = full; }
        } catch { /* raced with a build */ }
      }
    }
  };
  walk(dir);
  return { mtime: newest, file: newestFile };
}

const ago = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

// --- 1. node -------------------------------------------------------------

{
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) pass('node', `v${process.versions.node} at ${process.execPath}`);
  else fail('node', `v${process.versions.node} is too old; the daemon needs >= 18.`);
}

// --- 2. herdr ------------------------------------------------------------

// Kept in step with MINIMUM_HERDR_MAJOR_MINOR / VERIFIED_HERDR_MAJOR_MINOR in
// daemon/src/herdr-health.ts. Not imported from them: this script must run
// against a clone that has not been built, and dist/ is where those constants
// would have to come from.
//
// A FLOOR AND AN EVIDENCE MARKER, NEVER AN EQUALITY TEST (KAN-533). Doctor used
// to fail on any line but one, so it went red on every herdr release until this
// file was hand-edited — and it was red on 0.7.5 and 0.8.0 alike, which is how a
// working install got reported as broken. Above VERIFIED_HERDR is a warning
// because "we have not tried it" is what we know; it is not evidence of a fault.
const MINIMUM_HERDR = [0, 7];
const VERIFIED_HERDR = [0, 8];
const HERDR_INSTALL = 'curl -fsSL https://herdr.dev/install.sh | sh';

const fmt = ([maj, min]) => `${maj}.${min}`;

const herdrVersion = tryExec('herdr', ['--version']);
if (!herdrVersion) {
  fail('herdr binary', `not on PATH. Install it with the official installer:\n  ${HERDR_INSTALL}\nSee docs/SETUP.md.`);
} else {
  const m = /(\d+)\.(\d+)/.exec(herdrVersion);
  const line = m ? [Number(m[1]), Number(m[2])] : null;
  if (line === null) {
    warn('herdr binary', `${herdrVersion} — could not read a version number from that.`);
  } else if (line[0] < MINIMUM_HERDR[0] || (line[0] === MINIMUM_HERDR[0] && line[1] < MINIMUM_HERDR[1])) {
    fail(
      'herdr binary',
      `${herdrVersion}. Butchr starts agents with 'agent start --kind/--pane', which herdr\n` +
      `gained in ${fmt(MINIMUM_HERDR)}, so on this build every activation fails with\n` +
      `"unknown option: --kind". Upgrade with the official installer:\n` +
      `  ${HERDR_INSTALL}`
    );
  } else if (line[0] > VERIFIED_HERDR[0] || (line[0] === VERIFIED_HERDR[0] && line[1] > VERIFIED_HERDR[1])) {
    warn(
      'herdr binary',
      `${herdrVersion} is newer than the ${fmt(VERIFIED_HERDR)}.x line Butchr has been verified against.\n` +
      `It is expected to work and has not been tried. If activation fails, check whether\n` +
      `'herdr agent start' still takes --kind/--pane.`
    );
  } else {
    pass('herdr binary', herdrVersion);
  }
}

// --- 3. herdr server, and the fd ceiling that is the whole point ---------

function herdrServerPid() {
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return undefined; // not Linux, or no procfs
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let argv;
    try {
      argv = fs.readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
      continue;
    }
    if (argv.length >= 2 && /(^|\/)herdr$/.test(argv[0]) && argv[1] === 'server') return Number(entry);
  }
  return undefined;
}

const pid = herdrServerPid();
if (pid === undefined) {
  warn('herdr server', 'not running. Start it with `herdr` (the TUI starts one) or `systemctl --user start herdr.service`.');
} else {
  const limits = (() => {
    try { return fs.readFileSync(`/proc/${pid}/limits`, 'utf8'); } catch { return ''; }
  })();
  const line = limits.split('\n').find((l) => l.startsWith('Max open files'));
  const soft = Number(line?.trim().split(/\s{2,}/)[1]);
  let open = 0;
  try { open = fs.readdirSync(`/proc/${pid}/fd`).length; } catch { /* not ours */ }

  if (!Number.isFinite(soft) || soft <= 0) {
    warn('herdr fd limit', `herdr server is pid ${pid} but its limits could not be read.`);
  } else if (soft <= FD_SETSIZE) {
    fail(
      'herdr fd limit',
      `soft limit is ${soft} (the FD_SETSIZE default), holding ${open} descriptors.\n` +
      `At ${PTMX_FDS_PER_PANE} fds per pane that caps this server at ~${Math.floor(soft / PTMX_FDS_PER_PANE)} panes,\n` +
      `after which every 'herdr agent start' fails. This is the step setup exists to make\n` +
      `permanent — see docs/SETUP.md, step 6, or run daemon/scripts/install-service.sh.`
    );
  } else {
    pass(
      'herdr fd limit',
      `soft limit ${soft}, ${open} open — headroom ≈ ${Math.floor((soft - open) / PTMX_FDS_PER_PANE)} more panes (pid ${pid})`
    );
  }
}

// --- 4. builds, and whether they are stale ------------------------------

for (const [label, srcDir, artifact] of [
  ['daemon build', path.join(REPO, 'daemon', 'src'), path.join(REPO, 'daemon', 'dist', 'daemon.js')],
  ['extension build', path.join(REPO, 'extension'), path.join(REPO, 'extension', 'dist', 'manifest.json')]
]) {
  if (!fs.existsSync(artifact)) {
    fail(label, `${path.relative(REPO, artifact)} is missing — it has not been built.`);
    continue;
  }
  const built = fs.statSync(artifact).mtimeMs;
  const newest = newestMtime(srcDir);
  if (newest.mtime > built) {
    warn(
      label,
      `built ${ago(built)}, but ${path.relative(REPO, newest.file)} changed ${ago(newest.mtime)}.\n` +
      `Rebuild it — you are running an older version of this code than you have checked out.`
    );
  } else {
    pass(label, `${path.relative(REPO, artifact)}, built ${ago(built)}`);
  }
}

// --- 5. the Chrome native-messaging host --------------------------------

const hostManifests = [
  path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`),
  path.join(os.homedir(), '.config', 'chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`)
].filter((p) => fs.existsSync(p));

if (hostManifests.length === 0) {
  fail(
    'native-messaging host',
    `no ${HOST_NAME}.json under ~/.config/google-chrome or ~/.config/chromium.\n` +
    `Chrome cannot reach the daemon. Run: daemon/scripts/install-native-host.sh <extension-id>`
  );
} else {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(hostManifests[0], 'utf8'));
  } catch (e) {
    manifest = null;
    fail('native-messaging host', `${hostManifests[0]} is not valid JSON: ${e.message}`);
  }
  if (manifest) {
    const hostPath = manifest.path;
    const origins = manifest.allowed_origins ?? [];
    const problems = [];
    if (!hostPath || !fs.existsSync(hostPath)) {
      problems.push(`path points at ${hostPath}, which does not exist — did the clone move?`);
    } else {
      try {
        fs.accessSync(hostPath, fs.constants.X_OK);
      } catch {
        problems.push(`${hostPath} is not executable (chmod +x it)`);
      }
      // The shell wrapper execs dist/native-host.js; registering against an
      // unbuilt clone is a silent dead end that looks like a Chrome problem.
      const built = path.join(REPO, 'daemon', 'dist', 'native-host.js');
      if (path.resolve(hostPath).startsWith(path.resolve(REPO)) && !fs.existsSync(built)) {
        problems.push('daemon/dist/native-host.js is missing — the host would exit immediately');
      }
    }
    if (origins.length === 0) problems.push('allowed_origins is empty — no extension may connect');

    if (problems.length) {
      fail('native-messaging host', `${hostManifests[0]}\n${problems.join('\n')}`);
    } else {
      pass(
        'native-messaging host',
        `${hostManifests.length} manifest(s) registered, allowing ${origins.join(', ')}\n` +
        `An unpacked extension's ID changes with its load path — if Chrome reports\n` +
        `"Specified native messaging host not found", re-run install-native-host.sh\n` +
        `with the ID now shown at chrome://extensions.`
      );
    }
  }
}

// --- 6. the daemon's own autostart --------------------------------------

if (tryExec('systemctl', ['--user', 'show-environment']) !== null) {
  const enabled = tryExec('systemctl', ['--user', 'is-enabled', 'butchr-daemon.service']);
  const active = tryExec('systemctl', ['--user', 'is-active', 'butchr-daemon.service']);
  const linger = tryExec('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger', '--value']);
  if (enabled !== 'enabled') {
    warn(
      'daemon autostart',
      `butchr-daemon.service is ${enabled ?? 'not installed'} — the daemon will not come back after a reboot.\n` +
      `Install it: daemon/scripts/install-service.sh`
    );
  } else if (linger !== 'yes') {
    warn(
      'daemon autostart',
      `unit is enabled but linger is off, so the user manager only starts at login.\n` +
      `Fix: loginctl enable-linger ${os.userInfo().username}`
    );
  } else {
    pass('daemon autostart', `butchr-daemon.service enabled, ${active}, linger on`);
  }
} else {
  warn('daemon autostart', 'no systemd --user manager here; the daemon must be started by hand.');
}

// --- 6b. does journalctl actually carry the daemon's decisions? ----------
//
// KAN-598. `StandardOutput=journal` told every operator that
// `journalctl --user -u butchr-daemon.service` is where this daemon's output
// goes, and until KAN-598 not one line of it went there: `daemon.ts` sent every
// record to a file, so the journal held systemd's own lifecycle entries alone.
//
// ⚠ THAT STATE IS WHY THIS CHECK IS PHRASED THE WAY IT IS. It is not an error
// and not an empty read — the command returns real, timestamped, well-formed
// records, and the honest conclusion from them is "the daemon is running and
// quiet". On 2026-08-21 an operator grepped that output for a stand-down,
// matched nothing, and was one sentence from reporting that none had been
// attempted; the daemon had logged 65, one per minute. So the question asked
// here is whether a DECISION RECORD is present, never whether the unit has
// journal output — the second was true throughout the defect.

if (tryExec('systemctl', ['--user', 'show-environment']) !== null) {
  const loadState = tryExec('systemctl', [
    '--user', 'show', 'butchr-daemon.service', '-p', 'LoadState', '--value'
  ]);
  if (loadState !== 'loaded') {
    // Not a finding. There is no unit here, so there is no journal to judge —
    // and section 6 has already said so.
    pass('daemon journal', 'no butchr-daemon.service on this machine; nothing to read a journal for.');
  } else {
    const journal = tryExec('journalctl', [
      '--user', '-u', 'butchr-daemon.service', '--since', '-6h', '--no-pager'
    ]);
    if (journal === null) {
      warn('daemon journal', 'journalctl did not answer, so what the journal holds is unknown.');
    } else {
      const reading = readJournal(journal);
      if (reading.kind === 'carries-decisions') {
        pass('daemon journal', `last 6h: ${describeJournalReading(reading)}`);
      } else {
        warn(
          'daemon journal',
          `${describeJournalReading(reading)}\n` +
          `The full log is always at ${path.join(BUTCHR_DIR, 'daemon.log')} — start there.\n` +
          'If this daemon predates KAN-598 it has no mirror to run; deploy and\n' +
          'restart it: systemctl --user restart butchr-daemon.service'
        );
      }
    }
  }
}

// --- 7. can anything actually reach the daemon, and WHICH daemon is it? --
//
// KAN-550, AC2. Connecting was the whole of this check until 2026-08-20, when
// a socket that accepted connections perfectly was being served by a daemon
// nobody had configured — a child of Chrome with no BUTCHR_* at all, while
// `systemctl is-active` read `inactive` throughout. Both readings were correct
// and the pair was unresolvable from the tools, because no tool reported the
// process actually holding the socket.
//
// So the socket is asked who it is. `daemon_provenance` is answered by the
// serving process itself, which is why the answer cannot be stale the way a
// pidfile can: whoever replies IS the daemon in question.

const provenance = await new Promise((resolve) => {
  const socket = net.connect(SOCKET_PATH);
  let buffer = '';
  let settled = false;
  // Whether the CONNECTION happened is a different fact from whether the daemon
  // ANSWERED, and collapsing them reports a reachable daemon as an unreachable
  // socket. Caught by running this against the live fleet, whose daemon predates
  // `daemon_provenance` and therefore says nothing back: the first draft printed
  // `FAIL daemon socket — cannot connect`, which was false and would have been
  // false on every machine that had not yet redeployed.
  let connected = false;
  const done = (value) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(3000);
  socket.once('connect', () => {
    connected = true;
    socket.write(JSON.stringify({ action: 'daemon_provenance' }) + '\n');
  });
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg = null;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.action === 'daemon_provenance_response') {
        done({ reached: true, provenance: msg.success === true ? msg.provenance : null });
      }
    }
  });
  socket.once('timeout', () =>
    done(
      connected
        ? { reached: true, provenance: null }
        : { reached: false, error: 'accepted no connection within 3s' }
    )
  );
  socket.once('error', (err) =>
    done(
      connected
        ? { reached: true, provenance: null }
        : { reached: false, error: err.code ?? err.message }
    )
  );
  socket.once('close', () =>
    done(
      connected
        ? { reached: true, provenance: null }
        : { reached: false, error: 'the socket closed before the connection was established' }
    )
  );
});

if (!provenance.reached) {
  fail(
    'daemon socket',
    `cannot connect to ${SOCKET_PATH}: ${provenance.error}\n` +
    `The daemon is not running. Start it: systemctl --user start butchr-daemon.service\n` +
    `(or node ${path.join(REPO, 'daemon/dist/daemon.js')}), then check ~/.local/share/butchr/daemon.log`
  );
} else {
  pass('daemon socket', `${SOCKET_PATH} is accepting connections`);

  const p = provenance.provenance;
  if (!p) {
    // Reached, but it would not say. That is not a pass: an old daemon
    // predating this action and a wedged one look identical from here, and
    // both mean the question KAN-550 asks has no answer on this machine.
    warn(
      'serving daemon',
      `something is serving ${SOCKET_PATH} but it did not answer \`daemon_provenance\`.\n` +
      `That is a daemon built before KAN-550, or one too busy to reply. Which daemon is\n` +
      `serving, and whether it carries this machine's pinned environment, is UNKNOWN --\n` +
      `not fine. Rebuild and restart: npm --prefix daemon run build &&\n` +
      `systemctl --user restart butchr-daemon.service`
    );
  } else {
    const active = tryExec('systemctl', ['--user', 'is-active', 'butchr-daemon.service']);
    const mainPid = tryExec('systemctl', ['--user', 'show', 'butchr-daemon.service', '-p', 'ExecMainPID', '--value']);
    const drift = Array.isArray(p.pinDrift) ? p.pinDrift : [];
    const detail =
      `${p.summary}\n` +
      `pid ${p.pid}, parent ${p.parentComm ?? 'unknown'} (pid ${p.ppid}); ` +
      `is the unit's own main process: ${p.isUnitMainProcess ? 'yes' : 'NO'}\n` +
      `BUTCHR_* it carries: ${p.butchrEnvNames.length ? p.butchrEnvNames.join(', ') : '(none)'}\n` +
      `systemctl is-active says: ${active ?? 'unknown'}; unit ExecMainPID: ${mainPid ?? 'unknown'}`;

    if (drift.length > 0) {
      fail(
        'serving daemon',
        `${detail}\n\n` +
        `THIS IS THE KAN-550 SHAPE. The daemon serving the socket is NOT carrying\n` +
        drift.map((d) => `  ${d.name}: unit declares ${d.declared}, serving daemon has ${d.running ?? '(not set)'}`).join('\n') + `\n` +
        `Fix: kill ${p.pid}, then systemctl --user start butchr-daemon.service`
      );
    } else if (!p.isUnitMainProcess && p.unit.kind === 'loaded') {
      warn(
        'serving daemon',
        `${detail}\n\n` +
        `Nothing is missing from its environment, but this machine HAS a unit and this\n` +
        `process is not its main one. So the unit will not restart it, and \`is-active\`\n` +
        `is describing something other than the process serving the socket.`
      );
    } else if (p.isUnitMainProcess && active !== 'active') {
      // Belt and braces on the contradiction itself: systemd naming this pid as
      // the unit's main process while also reporting the unit is not active is a
      // disagreement between two readings, and quoting either one alone is how
      // the 2026-08-20 reading was lost.
      fail(
        'serving daemon',
        `${detail}\n\n` +
        `CONTRADICTION: systemd names pid ${p.pid} as this unit's ExecMainPID, and also\n` +
        `reports the unit is ${active ?? 'unknown'}. One of these is wrong; do not act on either alone.`
      );
    } else {
      pass('serving daemon', detail);
    }
  }
}

// --- 8. where a Jira token would be stored ------------------------------
// Not a pass/fail — the credential is optional. It is reported because which
// backend you get depends on an invisible property of the machine, and a user
// deciding whether to hand over a token deserves to know before they type it.

{
  const probe = (() => {
    try {
      execFileSync('secret-tool', ['lookup', 'service', 'butchr', 'account', 'jira'], {
        timeout: 5000, stdio: 'ignore'
      });
      return 'keyring';
    } catch (e) {
      // exit 1 = the helper ran and found nothing, which still means a keyring.
      return e?.status === 1 ? 'keyring' : 'file';
    }
  })();
  if (probe === 'keyring') {
    pass('jira credential storage', 'an OS keyring is available; a token would be stored there');
  } else {
    warn(
      'jira credential storage',
      `no working OS keyring (secret-tool absent, or no secret service running).\n` +
      `A token would be written to ${path.join(BUTCHR_DIR, 'jira-credential.json')} with mode 0600.\n` +
      `That is a supported configuration, not a fault. For a keyring instead:\n` +
      `  sudo apt install libsecret-tools gnome-keyring   (Debian/Ubuntu)`
    );
  }
}

// --- 9. whether agent-to-agent channels are on -------------------------
// Not a pass/fail either: off is the shipped default and a supported way to
// run, so failing on it would be reporting a choice as a fault. It is reported
// because the state lives in a file nobody looks at, and because BOTH values
// have a consequence a user meets later and does not connect back to here —
// off means an agent-to-agent message interrupts its recipient, and on means
// the fleet has to be restarted before any agent actually gets a channel.
//
// The malformed case is a WARN rather than a PASS, and that is the whole
// reason this reads the file rather than asking the daemon: `channelEmissionEnabled`
// fails closed, so a file somebody has half-edited reads as OFF with nothing
// to say it was meant to be on. That is the one state here that is a surprise
// rather than a decision.

{
  const switchPath = path.join(BUTCHR_DIR, 'channel.json');
  const composerNote =
    'Agent-to-agent messages fall back to the composer, which types into the\n' +
    'recipient and destroys the tool call it had in flight. See docs/SETUP.md, step 9.';
  if (!fs.existsSync(switchPath)) {
    pass(
      'agent-to-agent channels',
      `off — no ${switchPath}, which is the default.\n${composerNote}`
    );
  } else {
    // Read and parse are reported apart because they fail for different
    // reasons and only one of them is about the file's contents. Collapsing
    // them lets this print "is not valid JSON" about a file it never managed
    // to read, which is the same defect in miniature as everything else here:
    // a sentence claiming more than the mechanism behind it established.
    let unreadable = null;
    let parsed;
    try {
      const raw = fs.readFileSync(switchPath, 'utf8');
      try {
        parsed = JSON.parse(raw);
      } catch {
        unreadable = 'is not valid JSON';
      }
    } catch (e) {
      unreadable = `could not be read (${e?.code || e?.message})`;
    }
    if (unreadable) {
      warn(
        'agent-to-agent channels',
        `${switchPath} ${unreadable}, so the daemon reads it as OFF.\n` +
        `That is the fail-closed default doing its job, but if you wrote that file\n` +
        `meaning to turn channels on, they are not on.\n${composerNote}`
      );
    } else if (parsed?.enabled === true) {
      pass(
        'agent-to-agent channels',
        'on — agents spawned from now on are given a channel.\n' +
        'Agents already running were spawned without one and keep the composer\n' +
        'until they are restarted. Channels are a research preview; see step 9.'
      );
    } else {
      pass(
        'agent-to-agent channels',
        `off — ${switchPath} does not say { "enabled": true }.\n${composerNote}`
      );
    }
  }
}

// --- verdict ------------------------------------------------------------

const failed = results.filter((r) => r.level === 'fail');
const warned = results.filter((r) => r.level === 'warn');
console.log('');
console.log(
  `${results.length - failed.length - warned.length} passed, ${warned.length} warning(s), ${failed.length} failure(s)`
);
if (failed.length) {
  console.log(`Not ready: ${failed.map((r) => r.name).join(', ')}`);
  process.exit(1);
}
console.log(warned.length ? 'Usable, with the warnings above.' : 'Ready.');
