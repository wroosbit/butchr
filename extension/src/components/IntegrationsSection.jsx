import React, { useEffect, useState } from 'react';
import { JiraCredentialCard } from './JiraCredentialCard.jsx';
import { LaunchDarklyCredentialCard } from './LaunchDarklyCredentialCard.jsx';

// The settings page's Integrations section (KAN-87): one entry per integration
// the daemon reports, each saying whether it is connected and which workspace
// types it contributes, with its credential card underneath.
//
// Everything drawn here comes from the daemon's `list_integrations` response
// (KAN-86). Nothing about an integration is written down in this file — not
// the list of integrations, not Jira's three types, not how each type is
// resolved — because a second copy of those facts is a copy that goes stale
// the first time the daemon's registry changes and nobody remembers this page.

/**
 * How a page becomes a workspace type, in the user's terms.
 *
 * `url-matched` types own URL patterns and are recognised from the address
 * alone. The others cannot be: a Jira Story's URL is byte-identical to a
 * Task's, so they are reached only by taking the URL match and then asking the
 * integration what the issue actually is.
 */
const RESOLUTION_PHRASE = {
  'url-matched': 'matched from the page URL',
  'refined-from-issue-type': "resolved from the issue's real type, which its URL does not say"
};

/** The card each integration gets. Absent id → no card, just the summary. */
const CREDENTIAL_CARDS = {
  jira: JiraCredentialCard,
  launchdarkly: LaunchDarklyCredentialCard
};

const chipStyle = {
  background: '#1e293b',
  padding: '2px 6px',
  borderRadius: '4px',
  fontSize: '12px',
  color: '#cbd5f5'
};

function ProvidedTypes({ providedTypes }) {
  if (!providedTypes || providedTypes.length === 0) {
    // The honest empty case. LaunchDarkly has a credential and no workspace
    // types yet; saying so is the answer, not a placeholder or an error.
    return (
      <div style={{ fontSize: '13px', color: '#94a3b8' }}>
        Provides no workspace types.
      </div>
    );
  }

  return (
    <div>
      <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '8px' }}>
        Provides {providedTypes.length} workspace{' '}
        {providedTypes.length === 1 ? 'type' : 'types'}:
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {providedTypes.map((t) => (
          <li
            key={t.type}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: '8px',
              fontSize: '13px',
              padding: '4px 0'
            }}
          >
            <code style={{ ...chipStyle, fontFamily: 'monospace' }}>{t.type}</code>
            <span style={{ fontWeight: 600 }}>{t.name}</span>
            {t.supervisor && <span style={{ ...chipStyle, color: '#fbbf24' }}>supervisor</span>}
            <span style={{ color: '#94a3b8' }}>
              {/* An unrecognised resolution is shown as the daemon spelled it
                  rather than dropped: a new one is news, not noise. */}
              {RESOLUTION_PHRASE[t.resolution] ?? t.resolution}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConnectionState({ integration }) {
  const credential = integration.credential || {};
  const configured = !!credential.configured;
  const unavailable = integration.available === false;
  const connected = configured && !unavailable;

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px' }}>
      <span
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: connected ? '#10b981' : '#64748b',
          flexShrink: 0
        }}
      />
      {unavailable ? (
        <span style={{ color: '#94a3b8' }}>Not available in this daemon</span>
      ) : connected ? (
        <span>
          Connected
          <span style={{ color: '#94a3b8' }}>
            {' '}
            ({credential.storage === 'keyring' ? 'OS keyring' : '0600 file'})
          </span>
        </span>
      ) : (
        <span style={{ color: '#94a3b8' }}>Not connected</span>
      )}
    </span>
  );
}

function IntegrationEntry({ integration, card }) {
  return (
    <div style={{ marginTop: '16px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '12px',
          marginBottom: '10px'
        }}
      >
        <div style={{ fontWeight: 700, fontSize: '16px' }}>{integration.name}</div>
        <ConnectionState integration={integration} />
      </div>

      <div
        style={{
          padding: '12px',
          borderRadius: '6px',
          background: '#0b1220',
          border: '1px solid #334155',
          marginBottom: '12px'
        }}
      >
        <ProvidedTypes providedTypes={integration.providedTypes} />
      </div>

      {card}
    </div>
  );
}

/**
 * The section as a function of the daemon's answer — no messaging, so the
 * render harness can draw it from a real `list_integrations_response`.
 *
 * `integrations` is null while the question is still outstanding. `error` is
 * set when the daemon could not be asked at all, which is a different thing
 * from an empty list and is said differently.
 */
export function IntegrationsSectionView({ integrations, error = null, renderCard }) {
  const card = (integration) => {
    if (renderCard) return renderCard(integration);
    const Card = CREDENTIAL_CARDS[integration.id];
    return Card ? <Card /> : null;
  };

  return (
    <div style={{ marginTop: '30px' }}>
      <div style={{ fontSize: '20px', fontWeight: 700, marginBottom: '6px' }}>Integrations</div>
      <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '4px' }}>
        What Butchr can talk to, whether it is connected, and which workspace types each one
        contributes. A type is either recognised from the page URL or refined afterwards by asking
        the integration what the page really is — both are shown, because the difference is what
        a credential buys you.
      </div>

      {error ? (
        <div style={{ marginTop: '16px', fontSize: '14px', color: '#f87171' }}>{error}</div>
      ) : integrations === null ? (
        <div style={{ marginTop: '16px', fontSize: '14px', color: '#94a3b8' }}>
          Asking the daemon…
        </div>
      ) : integrations.length === 0 ? (
        <div style={{ marginTop: '16px', fontSize: '14px', color: '#94a3b8' }}>
          This daemon reports no integrations.
        </div>
      ) : (
        integrations.map((integration) => (
          <IntegrationEntry key={integration.id} integration={integration} card={card(integration)} />
        ))
      )}
    </div>
  );
}

/** Responses after which the daemon's answer to `list_integrations` is stale. */
const INVALIDATING_RESPONSES = new Set([
  'set_jira_credential_response',
  'clear_jira_credential_response',
  'set_integration_credential_response',
  'clear_integration_credential_response'
]);

/**
 * The section, wired to the daemon.
 *
 * It re-asks after any credential change so the connection states it shows are
 * the daemon's current answer rather than the one that happened to be true
 * when the page opened — a settings page that goes quietly stale while you use
 * it is worse than one that never claimed to know.
 */
export function IntegrationsSection() {
  const [integrations, setIntegrations] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const ask = () => {
      chrome.runtime.sendMessage({ type: 'GET_INTEGRATIONS' }, (reply) => {
        // A missing reply means the service worker itself did not answer;
        // `status: 'error'` means it answered that the daemon is not connected.
        if (chrome.runtime.lastError || (reply && reply.status === 'error')) {
          setError('The daemon is not connected, so its integrations cannot be listed.');
        }
      });
    };

    const onMessage = (message) => {
      if (message.type !== 'DAEMON_RESPONSE') return;
      const msg = message.payload || {};
      if (msg.action === 'list_integrations_response') {
        setError(msg.success === false ? msg.error || 'The daemon refused to list integrations.' : null);
        if (Array.isArray(msg.integrations)) setIntegrations(msg.integrations);
        return;
      }
      if (INVALIDATING_RESPONSES.has(msg.action)) ask();
    };

    chrome.runtime.onMessage.addListener(onMessage);
    ask();
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  return <IntegrationsSectionView integrations={integrations} error={error} />;
}
