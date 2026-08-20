import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// One fixed path rather than XDG_RUNTIME_DIR: Chrome-launched hosts, terminal
// runs, and herdr-spawned agents must all rendezvous on the same daemon even
// when their environments differ.
export const BUTCHR_DIR = path.join(os.homedir(), '.local', 'share', 'butchr');
export const SOCKET_PATH = path.join(BUTCHR_DIR, 'butchr.sock');

export function ensureButchrDir(): void {
  fs.mkdirSync(BUTCHR_DIR, { recursive: true, mode: 0o700 });
}

// Newline-delimited JSON framing over a stream. Uses a StringDecoder so a
// multi-byte character split across chunks (pty output) doesn't corrupt.
export function onJsonLines(
  stream: NodeJS.ReadableStream,
  onMessage: (msg: any) => void,
  onError?: (err: Error) => void
): void {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  stream.on('data', (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    let idx: number;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        onMessage(JSON.parse(line));
      } catch (err: any) {
        if (onError) onError(err);
      }
    }
  });
}

export function writeJsonLine(socket: net.Socket, msg: any): boolean {
  if (socket.destroyed) return false;
  socket.write(JSON.stringify(msg) + '\n');
  return true;
}

/** The systemd user unit SETUP.md installs. A string, so a grep finds it. */
export const DAEMON_UNIT = 'butchr-daemon.service';

/**
 * Is the daemon a systemd user unit on this machine, and can we reach systemd?
 *
 * Both halves matter. A unit file that exists but a `systemctl` that cannot
 * reach the user manager (no session bus, a container, a CI runner) must read
 * as "no", so the caller falls through to the raw spawn rather than hanging a
 * client on a command that will never answer.
 */
function daemonUnitIsManaged(): boolean {
  try {
    const r = spawnSync('systemctl', ['--user', 'cat', DAEMON_UNIT], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    return r.status === 0 && typeof r.stdout === 'string' && r.stdout.includes('ExecStart=');
  } catch {
    return false;
  }
}

export function spawnDaemon(): void {
  ensureButchrDir();

  // ── KAN-550: a stopped daemon must come back CONFIGURED ──────────────────
  // This function is every client's fallback when the socket is missing —
  // Chrome's native host, the MCP server, the CLI. It used to `spawn()` the
  // daemon directly with no `env`, so the child inherited the CLIENT's
  // environment: for Chrome, one with no BUTCHR_* variables at all. On
  // 2026-08-20, twice, a stopped unit was replaced within seconds by a daemon
  // with the runtime unpinned (a silent flip off crabcast), the cap unpinned
  // (derivation read 12 where the operator had set 6), the proxy off and the
  // reconciler in report mode — while `systemctl is-active` said INACTIVE,
  // because the process serving the socket was not systemd's. Then the real
  // unit could not start: it lost the singleton race and exited 0, and
  // `Restart=on-failure` does not retry a clean exit. Every status instrument
  // said "down" while an unconfigured daemon ran the fleet.
  //
  // The configuration lives in the unit's drop-ins. So when the unit exists,
  // ask systemd to start it — that is the one spawner that carries the env —
  // and only spawn a bare process when there is no unit to ask. `start` on an
  // already-active unit is a no-op, so racing clients converge on systemd's
  // daemon instead of on whichever client's child won.
  if (daemonUnitIsManaged()) {
    const r = spawnSync('systemctl', ['--user', 'start', DAEMON_UNIT], {
      encoding: 'utf8',
      timeout: 10_000,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    if (r.status === 0) return;
    // systemd refused or timed out. Fall through to the raw spawn rather than
    // leave the client with no daemon at all — but say so, because a raw spawn
    // here is exactly the unconfigured daemon this block exists to prevent.
    try {
      fs.appendFileSync(
        path.join(BUTCHR_DIR, 'daemon-spawn.err'),
        `${new Date().toISOString()} systemctl --user start ${DAEMON_UNIT} failed ` +
        `(status ${r.status}): ${(r.stderr ?? '').trim()} — falling back to a RAW spawn, ` +
        `which will NOT carry the unit's BUTCHR_* environment\n`
      );
    } catch {
      // the error file is best-effort
    }
  }

  const daemonPath = path.join(__dirname, 'daemon.js');
  // Capture the child's stderr: a daemon that dies during module load (bad
  // node version, missing dep) crashes before its own logger opens, and with
  // stdio 'ignore' that failure would be completely invisible.
  const errFd = fs.openSync(path.join(BUTCHR_DIR, 'daemon-spawn.err'), 'a');
  try {
    const child = spawn(process.execPath, [daemonPath], {
      detached: true,
      stdio: ['ignore', 'ignore', errFd]
    });
    child.unref();
  } finally {
    fs.closeSync(errFd);
  }
}

// Connect to the daemon socket, optionally spawning the daemon on first
// failure. If two clients race to spawn, the loser daemon detects the
// winner's socket and exits; both clients land on the survivor.
// Callers must attach their own 'error' handler to the resolved socket.
export function connectToDaemon(
  opts: { spawnIfMissing?: boolean; retries?: number; delayMs?: number } = {}
): Promise<net.Socket> {
  const { spawnIfMissing = true, retries = 20, delayMs = 250 } = opts;
  return new Promise((resolve, reject) => {
    let spawned = false;
    const attempt = (remaining: number) => {
      const socket = net.connect(SOCKET_PATH);
      const onConnect = () => {
        socket.removeListener('error', onFail);
        resolve(socket);
      };
      const onFail = (err: Error) => {
        socket.removeListener('connect', onConnect);
        socket.destroy();
        if (remaining <= 0) {
          reject(err);
          return;
        }
        if (spawnIfMissing && !spawned) {
          spawned = true;
          try {
            spawnDaemon();
          } catch {
            // fall through to retries; final failure surfaces the error
          }
        }
        setTimeout(() => attempt(remaining - 1), delayMs);
      };
      socket.once('connect', onConnect);
      socket.once('error', onFail);
    };
    attempt(retries);
  });
}
