import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
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

export function spawnDaemon(): void {
  ensureButchrDir();
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
