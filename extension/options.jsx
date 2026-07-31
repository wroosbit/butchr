import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './sidepanel.css'; // Just re-use general styles or write inline

const inputStyle = {
  width: '100%',
  padding: '10px',
  borderRadius: '6px',
  background: '#1e293b',
  border: '1px solid #334155',
  color: '#f8fafc',
  fontSize: '14px',
  boxSizing: 'border-box'
};

const labelStyle = { display: 'block', fontWeight: 600, marginBottom: '8px' };
const hintStyle = { fontSize: '13px', color: '#94a3b8', marginBottom: '12px' };

/**
 * Atlassian credential entry.
 *
 * The token is write-only by design. It lives in this component's state just
 * long enough to be posted to the daemon, is wiped on submit, and is never
 * written to chrome.storage or rendered back — not even masked-with-reveal.
 * Once submitted it is not readable through the product; the only affordances
 * are "replace it" and "clear it".
 *
 * Why the daemon needs this at all: a Jira issue URL is byte-identical whether
 * the issue is a Task or a Story, so the daemon has to ask Jira which it is.
 * Without a credential everything still works — Stories just open as `task`
 * workspaces.
 */
function JiraCredentialCard() {
  const [status, setStatus] = useState(null); // null until the daemon answers
  const [siteUrl, setSiteUrl] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // {ok: bool, text: string}

  useEffect(() => {
    const onMessage = (message) => {
      if (message.type !== 'DAEMON_RESPONSE') return;
      const msg = message.payload || {};

      if (msg.action === 'jira_credential_status_response') {
        setStatus(msg);
        return;
      }
      if (msg.action === 'set_jira_credential_response') {
        setBusy(false);
        // Wipe the secret from component state the moment it is no longer
        // needed, whether or not it was accepted.
        setToken('');
        if (msg.valid) {
          const where = `Stored in ${msg.storage === 'keyring' ? 'the OS keyring' : 'a 0600 file'}.`;
          const who = msg.accountName ? `Verified as ${msg.accountName}. ` : 'Credential verified. ';
          setResult({
            ok: true,
            text: who + where + (msg.note ? `\n\n${msg.note}` : '')
          });
          if (msg.status) setStatus((prev) => ({ ...prev, ...msg.status, available: true }));
        } else {
          // `msg.error` is now several lines: a diagnosis, then the endpoints
          // that were tried and what each said. Rendered verbatim — the whole
          // point is that the user can read which leg failed and act on it,
          // and that is lost if it gets flattened to a first sentence.
          setResult({ ok: false, text: msg.error || 'The credential was rejected.' });
        }
        return;
      }
      if (msg.action === 'clear_jira_credential_response') {
        setBusy(false);
        setResult({ ok: true, text: 'Credential cleared.' });
        if (msg.status) setStatus({ ...msg.status, available: true });
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    chrome.runtime.sendMessage({ type: 'GET_JIRA_CREDENTIAL_STATUS' });
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const submit = () => {
    if (!siteUrl.trim() || !email.trim() || !token) {
      setResult({ ok: false, text: 'Site URL, account email and API token are all required.' });
      return;
    }
    setBusy(true);
    setResult(null);
    chrome.runtime.sendMessage({
      type: 'SET_JIRA_CREDENTIAL',
      siteUrl: siteUrl.trim(),
      email: email.trim(),
      token
    });
  };

  const clear = () => {
    setBusy(true);
    setResult(null);
    chrome.runtime.sendMessage({ type: 'CLEAR_JIRA_CREDENTIAL' });
  };

  const configured = !!(status && status.configured);
  const storageTarget = status && status.storageTarget;

  return (
    <div
      className="card"
      style={{
        backgroundColor: '#111827',
        borderRadius: '8px',
        border: '1px solid #334155',
        padding: '20px',
        marginTop: '20px'
      }}
    >
      <div style={{ fontWeight: 700, fontSize: '16px', marginBottom: '6px' }}>
        Atlassian Credential
      </div>
      <div style={hintStyle}>
        Lets Butchr tell a Jira <strong>Story</strong> from a <strong>Task</strong>, which their
        URLs do not. Optional — without it, Stories simply open as <code>task</code> workspaces.
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
        ) : configured ? (
          <span>
            Configured — {status.email} @ {status.siteUrl}
            <span style={{ color: '#94a3b8' }}>
              {' '}
              ({status.storage === 'keyring' ? 'OS keyring' : '0600 file'})
            </span>
          </span>
        ) : (
          <span style={{ color: '#94a3b8' }}>Not configured</span>
        )}
      </div>

      <div style={{ marginBottom: '16px' }}>
        <label style={labelStyle} htmlFor="jira-site">
          Site URL
        </label>
        <input
          id="jira-site"
          type="url"
          autoComplete="off"
          placeholder="https://yoursite.atlassian.net"
          value={siteUrl}
          onChange={(e) => setSiteUrl(e.target.value)}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: '16px' }}>
        <label style={labelStyle} htmlFor="jira-email">
          Account email
        </label>
        <input
          id="jira-email"
          type="email"
          autoComplete="off"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={inputStyle}
        />
      </div>

      <div style={{ marginBottom: '16px' }}>
        <label style={labelStyle} htmlFor="jira-token">
          API token
        </label>
        <div style={hintStyle}>
          Create one at{' '}
          <a
            href="https://id.atlassian.com/manage-profile/security/api-tokens"
            target="_blank"
            rel="noreferrer"
            style={{ color: '#818cf8' }}
          >
            id.atlassian.com
          </a>
          . Choose a <strong>scoped</strong> token with <code>read:jira-work</code> — Butchr never
          writes to Jira. Adding <code>read:jira-user</code> is optional and only lets this page
          greet you by name. The token goes straight to the local daemon and is never stored in the
          browser or shown again.
        </div>
        <input
          id="jira-token"
          type="password"
          autoComplete="new-password"
          placeholder={configured ? 'Enter a new token to replace the stored one' : ''}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          style={inputStyle}
        />
        {/*
          Where the secret will land, said before it is typed rather than in the
          success message afterwards. Which backend you get depends on whether a
          working OS keyring is present, which the user cannot see — and once the
          token has been submitted, being told where it went is no longer a
          choice they can make.
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

      <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
        <button onClick={submit} disabled={busy} className="btn btn-primary">
          {busy ? 'Verifying…' : configured ? 'Replace credential' : 'Save & verify'}
        </button>
        {configured && (
          <button
            onClick={clear}
            disabled={busy}
            className="btn"
            style={{ background: 'transparent', border: '1px solid #334155', color: '#94a3b8' }}
          >
            Clear
          </button>
        )}
      </div>

      {result && (
        <div
          style={{
            marginTop: '12px',
            fontSize: '14px',
            lineHeight: 1.5,
            // The diagnosis is a paragraph followed by one bullet per endpoint
            // tried. Newlines are the structure, so they have to survive.
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

function Options() {
  const [defaultAgent, setDefaultAgent] = useState('shell');
  const [status, setStatus] = useState('');

  useEffect(() => {
    chrome.storage.sync.get(['defaultAgent'], (result) => {
      if (result.defaultAgent) {
        setDefaultAgent(result.defaultAgent);
      }
    });
  }, []);

  const handleSave = () => {
    chrome.storage.sync.set({ defaultAgent }, () => {
      setStatus('Settings saved.');
      setTimeout(() => setStatus(''), 2000);
    });
  };

  return (
    <div className="container" style={{ maxWidth: '600px', margin: '40px auto', padding: '20px', color: '#f8fafc', fontFamily: 'sans-serif' }}>
      <div className="header" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '30px', paddingBottom: '20px', borderBottom: '1px solid #334155' }}>
        <span style={{ fontSize: '24px' }}>⚙️</span>
        <div className="title" style={{ fontSize: '24px', fontWeight: 700 }}>Butchr Settings</div>
      </div>

      <div className="card" style={{ backgroundColor: '#111827', borderRadius: '8px', border: '1px solid #334155', padding: '20px' }}>
        <div style={{ marginBottom: '20px' }}>
          <label style={{ display: 'block', fontWeight: 600, marginBottom: '8px' }}>Default Agent</label>
          <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '12px' }}>Choose which agent to launch when you open a terminal session.</div>
          <select
            value={defaultAgent}
            onChange={(e) => setDefaultAgent(e.target.value)}
            style={{ width: '100%', padding: '10px', borderRadius: '6px', background: '#1e293b', border: '1px solid #334155', color: '#f8fafc', fontSize: '14px' }}
          >
            <option value="shell">Shell (No start command)</option>
            <option value="claude">Claude</option>
            <option value="anti-gravity">Anti-Gravity</option>
          </select>
        </div>

        <button onClick={handleSave} className="btn btn-primary">Save Settings</button>
        <div style={{ marginTop: '10px', color: '#10b981', fontSize: '14px', height: '20px' }}>{status}</div>
      </div>

      <JiraCredentialCard />
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<Options />);
