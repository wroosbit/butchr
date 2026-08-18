import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BUTCHR_DIR, ensureButchrDir } from './ipc.js';
/** Jira's spec — byte-for-byte the storage this module used before it was
 * per-integration, which is what "no migration" means in practice. */
export const JIRA_CREDENTIAL_SPEC = {
    id: 'jira',
    keyringLabel: 'Butchr — Atlassian API token',
    nonSecretFields: ['siteUrl', 'email']
};
function run(cmd, args, stdin) {
    return new Promise((resolve) => {
        let child;
        try {
            child = execFile(cmd, args, { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
                // A non-zero exit is an ordinary answer here ("no such secret"), not a
                // fault. Note the callback's stderr is deliberately dropped: the token
                // can appear in a failing helper's diagnostics.
                resolve({ code: err?.code ?? 0, stdout: stdout ?? '' });
            });
        }
        catch {
            resolve({ code: -1, stdout: '' });
            return;
        }
        child.on('error', () => resolve({ code: -1, stdout: '' }));
        if (stdin !== undefined) {
            child.stdin?.on('error', () => { });
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
async function keyringAvailable(attrs) {
    const { code } = await run('secret-tool', ['lookup', ...attrs]);
    // 0 = found, 1 = ran fine but no such secret. Anything else (missing binary,
    // no secret service, D-Bus refusal) means there is no keyring to use.
    return code === 0 || code === 1;
}
async function keyringStore(attrs, label, token) {
    const { code } = await run('secret-tool', ['store', '--label', label, ...attrs], token);
    return code === 0;
}
async function keyringLookup(attrs) {
    const { code, stdout } = await run('secret-tool', ['lookup', ...attrs]);
    if (code !== 0)
        return null;
    // secret-tool does not add a trailing newline, but a token never contains
    // surrounding whitespace either way.
    const token = stdout.trim();
    return token || null;
}
async function keyringClear(attrs) {
    await run('secret-tool', ['clear', ...attrs]);
}
/**
 * One integration's credential, at rest.
 *
 * Read-only by construction: this stores what is needed to *authenticate* a
 * read against the integration's API and nothing more. There is no write path
 * to any integration anywhere in the daemon, by design (KAN-20).
 *
 * The type parameter is the integration's credential shape — Jira's
 * `{siteUrl, email, token}`, LaunchDarkly's `{token}` — and defaults to Jira's
 * so that every pre-existing construction site (`new CredentialStore()`) keeps
 * meaning exactly what it meant.
 */
export class CredentialStore {
    spec;
    metadataFile;
    keyringAttrs;
    constructor(spec = JIRA_CREDENTIAL_SPEC) {
        this.spec = spec;
        this.metadataFile = path.join(BUTCHR_DIR, `${spec.id}-credential.json`);
        this.keyringAttrs = ['service', 'butchr', 'account', spec.id];
    }
    readMetadata() {
        try {
            const raw = fs.readFileSync(this.metadataFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed?.storage !== 'keyring' && parsed?.storage !== 'file')
                return null;
            const fields = {};
            for (const name of this.spec.nonSecretFields) {
                if (typeof parsed[name] !== 'string')
                    return null;
                fields[name] = parsed[name];
            }
            return {
                fields,
                storage: parsed.storage,
                ...(typeof parsed.token === 'string' ? { token: parsed.token } : {})
            };
        }
        catch {
            // Missing or corrupt reads as "not configured" — the caller's job is to
            // degrade, not to repair.
            return null;
        }
    }
    writeMetadata(meta) {
        ensureButchrDir();
        // Non-secret fields first, then storage, then (file backend only) the
        // token — the same flat shape and key order this file has always had.
        const onDisk = {
            ...meta.fields,
            storage: meta.storage,
            ...(meta.token !== undefined ? { token: meta.token } : {})
        };
        // Create with 0600 from the outset. Writing first and chmod-ing after leaves
        // a window where the token is world-readable.
        fs.writeFileSync(this.metadataFile, JSON.stringify(onDisk, null, 2) + '\n', { mode: 0o600 });
        // writeFileSync's mode applies only on create; an existing file keeps its
        // old permissions, so re-assert them.
        fs.chmodSync(this.metadataFile, 0o600);
    }
    /** Non-secret summary — safe to send to the UI and to log. */
    status() {
        const meta = this.readMetadata();
        if (!meta)
            return { configured: false };
        return {
            configured: true,
            ...meta.fields,
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
    async storageTarget() {
        if (await keyringAvailable(this.keyringAttrs)) {
            return {
                storage: 'keyring',
                reason: 'The OS keyring is available, so the token goes there.'
            };
        }
        return {
            storage: 'file',
            path: this.metadataFile,
            reason: 'No OS keyring is available on this machine — either secret-tool (libsecret) is not installed or no secret service is running — so the token is written to a file readable only by you (mode 0600).'
        };
    }
    /** The full credential, or null when nothing is configured. */
    async load() {
        const meta = this.readMetadata();
        if (!meta)
            return null;
        if (meta.storage === 'file') {
            return meta.token ? { ...meta.fields, token: meta.token } : null;
        }
        const token = await keyringLookup(this.keyringAttrs);
        // Metadata says keyring but the keyring has nothing: the secret was
        // revoked or the service is unreachable. Not configured, as far as
        // callers are concerned — which means resolution falls back to the
        // integration's default behaviour.
        return token ? { ...meta.fields, token } : null;
    }
    /** Persist a credential, preferring the keyring. Returns where it landed. */
    async save(cred) {
        const fields = {};
        for (const name of this.spec.nonSecretFields) {
            fields[name] = String(cred[name] ?? '');
        }
        if (await keyringAvailable(this.keyringAttrs)) {
            if (await keyringStore(this.keyringAttrs, this.spec.keyringLabel, cred.token)) {
                this.writeMetadata({ fields, storage: 'keyring' });
                return 'keyring';
            }
        }
        this.writeMetadata({ fields, storage: 'file', token: cred.token });
        return 'file';
    }
    /** Remove the credential from both backends. Idempotent. */
    async clear() {
        // Clear the keyring regardless of what the metadata claims — if the
        // metadata file was lost, the secret would otherwise be orphaned there
        // with nothing left pointing at it.
        await keyringClear(this.keyringAttrs);
        try {
            fs.unlinkSync(this.metadataFile);
        }
        catch {
            // Already gone.
        }
    }
}
