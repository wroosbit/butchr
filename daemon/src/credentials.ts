import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';

// Storage for the Atlassian credential the daemon uses to look up an issue's
// type. The secret arrives from the extension's settings page over native
// messaging and stops here: it is never sent back out, never logged, and never
// rendered into any UI.
//
// Two backends, in preference order:
//   1. The OS keyring, via libsecret's `secret-tool`. The secret goes in on
//      stdin — never argv, which is world-readable through `ps`.
//   2. A 0600 file under ~/.local/share/butchr (itself 0700).
//
// Only the *token* moves between backends. The non-secret parts (site URL,
// account email, which backend holds the token) always live in the metadata
// file, so reporting "configured / not configured" never has to unlock a
// keyring.
//
// macOS is a known gap: it falls through to the file backend. The obvious
// helper, `security add-generic-password`, takes the secret as an argv
// parameter (`-w <password>`), which would publish the token to every user on
// the box via `ps` — strictly worse than a 0600 file. Adding macOS support
// means finding a stdin-based path (or a native binding), not passing `-w`.
// The backend seam below is where that goes.

const METADATA_FILE = path.join(BUTCHR_DIR, 'jira-credential.json');

const KEYRING_ATTRS = ['service', 'butchr', 'account', 'jira'];
const KEYRING_LABEL = 'Butchr — Atlassian API token';

export interface JiraCredential {
  /** Site base URL, e.g. https://yoursite.atlassian.net (no trailing slash). */
  siteUrl: string;
  /** Atlassian account email — the username half of Basic auth. */
  email: string;
  /** API token. Never leaves this process. */
  token: string;
}

export type CredentialStorage = 'keyring' | 'file';

/** Everything the settings UI is allowed to know. Deliberately token-free. */
export interface CredentialStatus {
  configured: boolean;
  siteUrl?: string;
  email?: string;
  storage?: CredentialStorage;
}

/**
 * Where a credential submitted right now would land — answered *before* the
 * user types one.
 *
 * The backend is chosen at save time by probing the machine, so it is not
 * knowable from configuration; it has to be asked. Reporting it only in the
 * success message told the user where their secret had gone, which is a
 * different thing from letting them decide whether to send it.
 */
export interface StorageTarget {
  storage: CredentialStorage;
  /** Absolute path, when the file backend would be used. Not a secret. */
  path?: string;
  /** Why this backend and not the other, in the user's terms. */
  reason: string;
}

interface Metadata {
  siteUrl: string;
  email: string;
  storage: CredentialStorage;
  /** Present only when `storage` is 'file'. */
  token?: string;
}

function run(
  cmd: string,
  args: string[],
  stdin?: string
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(cmd, args, { timeout: 5000, encoding: 'utf8' }, (err: any, stdout) => {
        // A non-zero exit is an ordinary answer here ("no such secret"), not a
        // fault. Note the callback's stderr is deliberately dropped: the token
        // can appear in a failing helper's diagnostics.
        resolve({ code: err?.code ?? 0, stdout: stdout ?? '' });
      });
    } catch {
      resolve({ code: -1, stdout: '' });
      return;
    }
    child.on('error', () => resolve({ code: -1, stdout: '' }));
    if (stdin !== undefined) {
      child.stdin?.on('error', () => {});
      child.stdin?.end(stdin);
    }
  });
}

/**
 * Is a usable keyring present?
 *
 * `secret-tool` being on PATH is not enough — it is installed by default on
 * many desktops but fails at runtime when no D-Bus secret service is running
 * (headless boxes, most containers, a daemon started outside a session). The
 * only reliable probe is to actually try the thing, so this does a lookup and
 * treats "the helper ran and answered" as available.
 */
async function keyringAvailable(): Promise<boolean> {
  const { code } = await run('secret-tool', ['lookup', ...KEYRING_ATTRS]);
  // 0 = found, 1 = ran fine but no such secret. Anything else (missing binary,
  // no secret service, D-Bus refusal) means there is no keyring to use.
  return code === 0 || code === 1;
}

async function keyringStore(token: string): Promise<boolean> {
  const { code } = await run(
    'secret-tool',
    ['store', '--label', KEYRING_LABEL, ...KEYRING_ATTRS],
    token
  );
  return code === 0;
}

async function keyringLookup(): Promise<string | null> {
  const { code, stdout } = await run('secret-tool', ['lookup', ...KEYRING_ATTRS]);
  if (code !== 0) return null;
  // secret-tool does not add a trailing newline, but a token never contains
  // surrounding whitespace either way.
  const token = stdout.trim();
  return token || null;
}

async function keyringClear(): Promise<void> {
  await run('secret-tool', ['clear', ...KEYRING_ATTRS]);
}

function readMetadata(): Metadata | null {
  try {
    const raw = fs.readFileSync(METADATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed?.siteUrl === 'string' &&
      typeof parsed?.email === 'string' &&
      (parsed.storage === 'keyring' || parsed.storage === 'file')
    ) {
      return parsed as Metadata;
    }
    return null;
  } catch {
    // Missing or corrupt reads as "not configured" — the caller's job is to
    // degrade, not to repair.
    return null;
  }
}

function writeMetadata(meta: Metadata): void {
  ensureButchrDir();
  // Create with 0600 from the outset. Writing first and chmod-ing after leaves
  // a window where the token is world-readable.
  fs.writeFileSync(METADATA_FILE, JSON.stringify(meta, null, 2) + '\n', { mode: 0o600 });
  // writeFileSync's mode applies only on create; an existing file keeps its
  // old permissions, so re-assert them.
  fs.chmodSync(METADATA_FILE, 0o600);
}

/**
 * The daemon's Atlassian credential, at rest.
 *
 * Read-only by construction: this stores what is needed to *authenticate* a
 * Jira read and nothing more. There is no write path to Jira anywhere in the
 * daemon, by design (KAN-20).
 */
export class CredentialStore {
  /** Non-secret summary — safe to send to the UI and to log. */
  public status(): CredentialStatus {
    const meta = readMetadata();
    if (!meta) return { configured: false };
    return {
      configured: true,
      siteUrl: meta.siteUrl,
      email: meta.email,
      storage: meta.storage
    };
  }

  /**
   * Which backend a `save` would use right now, and why.
   *
   * Runs the same `keyringAvailable` probe `save` does, so the answer is the
   * one the user will actually get rather than an assumption about the
   * platform — `secret-tool` present but no secret service running is a real
   * and common state, and it silently produces the file backend.
   */
  public async storageTarget(): Promise<StorageTarget> {
    if (await keyringAvailable()) {
      return {
        storage: 'keyring',
        reason: 'The OS keyring is available, so the token goes there.'
      };
    }
    return {
      storage: 'file',
      path: METADATA_FILE,
      reason:
        'No OS keyring is available on this machine — either secret-tool (libsecret) is not installed or no secret service is running — so the token is written to a file readable only by you (mode 0600).'
    };
  }

  /** The full credential, or null when nothing is configured. */
  public async load(): Promise<JiraCredential | null> {
    const meta = readMetadata();
    if (!meta) return null;

    if (meta.storage === 'file') {
      return meta.token
        ? { siteUrl: meta.siteUrl, email: meta.email, token: meta.token }
        : null;
    }

    const token = await keyringLookup();
    // Metadata says keyring but the keyring has nothing: the secret was
    // revoked or the service is unreachable. Not configured, as far as
    // callers are concerned — which means resolution falls back to `task`.
    return token ? { siteUrl: meta.siteUrl, email: meta.email, token } : null;
  }

  /** Persist a credential, preferring the keyring. Returns where it landed. */
  public async save(cred: JiraCredential): Promise<CredentialStorage> {
    if (await keyringAvailable()) {
      if (await keyringStore(cred.token)) {
        writeMetadata({ siteUrl: cred.siteUrl, email: cred.email, storage: 'keyring' });
        return 'keyring';
      }
    }

    writeMetadata({
      siteUrl: cred.siteUrl,
      email: cred.email,
      storage: 'file',
      token: cred.token
    });
    return 'file';
  }

  /** Remove the credential from both backends. Idempotent. */
  public async clear(): Promise<void> {
    // Clear the keyring regardless of what the metadata claims — if the
    // metadata file was lost, the secret would otherwise be orphaned there
    // with nothing left pointing at it.
    await keyringClear();
    try {
      fs.unlinkSync(METADATA_FILE);
    } catch {
      // Already gone.
    }
  }
}
