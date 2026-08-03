import React, { useEffect, useState } from 'react';
import { inputStyle, labelStyle, hintStyle } from './credentialStyles.js';

// Butchr's second integration credential (KAN-87), speaking the generalized
// daemon actions KAN-86 added: `integration_credential_status`,
// `set_integration_credential`, `clear_integration_credential`, each carrying
// `integration: 'launchdarkly'`.
//
// It deliberately mirrors JiraCredentialCard's rendering rather than sharing
// code with it: the same write-only field, the same storage disclosure placed
// *before* the field, the same `whiteSpace: 'pre-line'` verbatim rendering of
// the daemon's leg trail. Unifying the two into one component would mean
// rewriting the Jira card, which KAN-87 puts out of scope — so the invariants
// are restated here, with the reasons, instead of being pointed at.
//
// The split into a stateful shell and a pure view is not test scaffolding: the
// view is what scripts/render-integrations.mjs renders against real daemon
// payloads, so the states a user only reaches by submitting a bad token — the
// rejection trail above all — are provable without a browser.

/** The shape of a LaunchDarkly rejection, as the daemon words it. */
const REJECTED_FALLBACK = 'The token was rejected.';

/**
 * Everything the card draws, as a function of daemon-supplied state.
 *
 * `status` is null until the daemon answers, then
 * `{available, configured, storage?, storageTarget?}` — never a token. There
 * is no prop through which a stored token could arrive, which is the point:
 * the component cannot render one back even by mistake.
 */
export function LaunchDarklyCredentialCardView({
  status,
  token = '',
  busy = false,
  result = null,
  onTokenChange = () => {},
  onSubmit = () => {},
  onClear = () => {}
}) {
  const unsupported = !!(status && status.available === false);
  const configured = !!(status && status.configured);
  const storageTarget = status && status.storageTarget;

  return (
    <div
      className="card"
      style={{
        backgroundColor: '#111827',
        borderRadius: '8px',
        border: '1px solid #334155',
        padding: '20px'
      }}
    >
      <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '6px' }}>
        LaunchDarkly Credential
      </div>
      <div style={hintStyle}>
        An API access token, validated against LaunchDarkly the moment you save it. Optional — no
        workspace type depends on it yet.
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 12px',
          borderRadius: '6px',
          background: '#0b1220',
          border: '1px solid #334155',
          marginBottom: '20px',
          fontSize: '14px'
        }}
      >
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: configured ? '#10b981' : '#64748b',
            flexShrink: 0
          }}
        />
        {status === null ? (
          <span style={{ color: '#94a3b8' }}>Checking…</span>
        ) : unsupported ? (
          <span style={{ color: '#94a3b8' }}>
            This daemon has no LaunchDarkly credential support.
          </span>
        ) : configured ? (
          // A token, and nothing about the token: LaunchDarkly's credential has
          // no non-secret half — no site, no account email — so "configured"
          // and where it is stored is the whole of what can honestly be said.
          <span>
            Configured
            <span style={{ color: '#94a3b8' }}>
              {' '}
              ({status.storage === 'keyring' ? 'OS keyring' : '0600 file'})
            </span>
          </span>
        ) : (
          <span style={{ color: '#94a3b8' }}>Not configured</span>
        )}
      </div>

      {!unsupported && (
        <div style={{ marginBottom: '16px' }}>
          <label style={labelStyle} htmlFor="launchdarkly-token">
            API access token
          </label>
          <div style={hintStyle}>
            Create one under <strong>Account settings → Authorization</strong> in LaunchDarkly. The
            token goes straight to the local daemon and is never stored in the browser or shown
            again.
          </div>
          <input
            id="launchdarkly-token"
            type="password"
            autoComplete="new-password"
            placeholder={configured ? 'Enter a new token to replace the stored one' : ''}
            value={token}
            onChange={(e) => onTokenChange(e.target.value)}
            style={inputStyle}
          />
          {/*
            Same disclosure, same reason as the Jira card: which backend the
            secret lands in is decided by probing this machine, so it cannot be
            read off the configuration — and telling the user afterwards is a
            notification, not a choice.
          */}
          {storageTarget && (
            <div
              style={{
                marginTop: '10px',
                padding: '10px 12px',
                borderRadius: '6px',
                background: '#0b1220',
                border: '1px solid #334155',
                fontSize: '13px',
                color: '#94a3b8'
              }}
            >
              <strong style={{ color: '#e2e8f0' }}>
                {storageTarget.storage === 'keyring'
                  ? 'This will be stored in your OS keyring.'
                  : 'This will be stored in a file, not your OS keyring.'}
              </strong>{' '}
              {storageTarget.reason}
              {storageTarget.path && (
                <>
                  {' '}
                  Path: <code style={{ wordBreak: 'break-all' }}>{storageTarget.path}</code>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {!unsupported && (
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button onClick={onSubmit} disabled={busy} className="btn btn-primary">
            {busy ? 'Verifying…' : configured ? 'Replace token' : 'Save & verify'}
          </button>
          {configured && (
            <button
              onClick={onClear}
              disabled={busy}
              className="btn"
              style={{ background: 'transparent', border: '1px solid #334155', color: '#94a3b8' }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {result && (
        <div
          style={{
            marginTop: '12px',
            fontSize: '14px',
            lineHeight: 1.5,
            // A diagnosis, then the leg that was tried and what LaunchDarkly
            // said about it. The newlines are the structure; flattening this to
            // a first sentence throws away the part the user can act on.
            whiteSpace: 'pre-line',
            wordBreak: 'break-word',
            color: result.ok ? '#10b981' : '#f87171'
          }}
        >
          {result.text}
        </div>
      )}
    </div>
  );
}

/**
 * LaunchDarkly credential entry.
 *
 * The token is write-only, exactly as Jira's is: it lives in this component's
 * state only long enough to be posted to the daemon, is wiped when the daemon
 * answers whether or not the token was accepted, and is never written to
 * chrome.storage or rendered back — not masked, not partially. The only
 * affordances on a stored token are "replace it" and "clear it".
 */
export function LaunchDarklyCredentialCard() {
  const [status, setStatus] = useState(null); // null until the daemon answers
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {ok: bool, text: string}

  useEffect(() => {
    const onMessage = (message) => {
      if (message.type !== 'DAEMON_RESPONSE') return;
      const msg = message.payload || {};
      // The generalized actions are shared with Jira, so every response has to
      // be checked for whose it is before it is believed.
      if (msg.integration && msg.integration !== 'launchdarkly') return;

      if (msg.action === 'integration_credential_status_response') {
        setStatus(msg);
        return;
      }
      if (msg.action === 'set_integration_credential_response') {
        setBusy(false);
        // Wipe the secret from component state the moment it is no longer
        // needed, whether or not it was accepted.
        setToken('');
        if (msg.valid) {
          setResult({
            ok: true,
            text: `Token verified. Stored in ${
              msg.storage === 'keyring' ? 'the OS keyring' : 'a 0600 file'
            }.`
          });
          if (msg.status) setStatus((prev) => ({ ...prev, ...msg.status, available: true }));
        } else {
          // Rendered verbatim: `msg.error` is a diagnosis followed by the leg
          // trail — which endpoint was tried, what it answered, and
          // LaunchDarkly's own request id if it gave one.
          setResult({ ok: false, text: msg.error || REJECTED_FALLBACK });
        }
        return;
      }
      if (msg.action === 'clear_integration_credential_response') {
        setBusy(false);
        setResult({ ok: true, text: 'Credential cleared.' });
        if (msg.status) setStatus((prev) => ({ ...prev, ...msg.status, available: true }));
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.runtime.sendMessage({
      type: 'GET_INTEGRATION_CREDENTIAL_STATUS',
      integration: 'launchdarkly'
    });
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const submit = () => {
    if (!token) {
      setResult({ ok: false, text: 'An API token is required.' });
      return;
    }
    setBusy(true);
    setResult(null);
    chrome.runtime.sendMessage({
      type: 'SET_INTEGRATION_CREDENTIAL',
      integration: 'launchdarkly',
      token
    });
  };

  const clear = () => {
    setBusy(true);
    setResult(null);
    chrome.runtime.sendMessage({
      type: 'CLEAR_INTEGRATION_CREDENTIAL',
      integration: 'launchdarkly'
    });
  };

  return (
    <LaunchDarklyCredentialCardView
      status={status}
      token={token}
      busy={busy}
      result={result}
      onTokenChange={setToken}
      onSubmit={submit}
      onClear={clear}
    />
  );
}
