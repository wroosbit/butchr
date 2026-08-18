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

// Kept in step with SUPPORTED_HERDR_MAJOR_MINOR in daemon/src/herdr-health.ts.
// Not imported from it: this script must run against a clone that has not been
// built, and dist/ is where that constant would have to come from.
const SUPPORTED_HERDR = '0.6';
const HERDR_PIN_URL =
  'https://github.com/herdrdev/herdr/releases/download/v0.6.4/herdr-linux-x86_64';

const herdrVersion = tryExec('herdr', ['--version']);
if (!herdrVersion) {
  fail('herdr binary', `not on PATH. See docs/SETUP.md — and note that herdr.dev/install.sh installs the latest, which is not the ${SUPPORTED_HERDR}.x line Butchr needs.`);
} else {
  const m = /(\d+)\.(\d+)/.exec(herdrVersion);
  const line = m ? `${m[1]}.${m[2]}` : null;
  if (line === SUPPORTED_HERDR) {
    pass('herdr binary', herdrVersion);
  } else if (line === null) {
    warn('herdr binary', `${herdrVersion} — could not read a version number from that.`);
  } else {
    fail(
      'herdr binary',
      `${herdrVersion}. Butchr's spawn path is written against the ${SUPPORTED_HERDR}.x line.\n` +
      `herdr 0.7 redesigned 'agent start' (--kind/--pane, no --cwd), so activation fails\n` +
      `with "unknown option: --cwd". Install the pinned build:\n` +
      `  curl -fsSL -o ~/.local/bin/herdr ${HERDR_PIN_URL} && chmod +x ~/.local/bin/herdr`
    );
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

// --- 7. can anything actually reach the daemon? -------------------------

await new Promise((resolve) => {
  const socket = net.connect(SOCKET_PATH);
  const done = (fn, ...args) => { socket.destroy(); fn(...args); resolve(); };
  socket.setTimeout(3000);
  socket.once('connect', () => done(pass, 'daemon socket', `${SOCKET_PATH} is accepting connections`));
  socket.once('timeout', () => done(fail, 'daemon socket', `${SOCKET_PATH} accepted no connection within 3s`));
  socket.once('error', (err) =>
    done(
      fail,
      'daemon socket',
      `cannot connect to ${SOCKET_PATH}: ${err.code ?? err.message}\n` +
      `The daemon is not running. Start it: systemctl --user start butchr-daemon.service\n` +
      `(or node ${path.join(REPO, 'daemon/dist/daemon.js')}), then check ~/.local/share/butchr/daemon.log`
    ));
});

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
