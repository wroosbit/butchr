import React from 'react';
import { createRoot } from 'react-dom/client';
import './sidepanel.css'; // Just re-use general styles or write inline
import { IntegrationsSection } from './src/components/IntegrationsSection.jsx';
import { GuardianCard } from './src/components/GuardianCard.jsx';

/*
 * THE "DEFAULT AGENT" CARD WAS HERE, AND KAN-395 DELETED IT RATHER THAN
 * NARROWING IT TO ONE OPTION.
 *
 * The human's decision, relayed 2026-08-14: *"we should shrink the scope to
 * only use claude, with no shell or antigravity. no select option at all, only
 * claude."* A select with one entry is still a select — it is a control that
 * says a choice exists — so the card goes and `DEFAULT_AGENT` in
 * `daemon/src/launchers.ts` becomes the only place that answers "what does a
 * new agent run".
 *
 * WHAT IT ACTUALLY DID, which is worse than "it offered a choice nobody wanted".
 * The select's initial state was `'shell'`, and it wrote
 * `chrome.storage.sync.defaultAgent`; the service worker read that key and fell
 * back to `|| 'shell'`. So BOTH BRANCHES ENDED AT A BARE BASH PROMPT — a user
 * who opened Settings and pressed Save without touching the dropdown pinned the
 * fleet to `shell`, and a user who never opened Settings at all got `undefined
 * || 'shell'` and the same result. That is KAN-53's incident (a story agent was
 * a shell for twenty minutes, executing its messages as shell commands) living
 * one layer above the `resolveLauncher` fix that removed it.
 *
 * The storage key is not migrated and does not need to be: nothing reads it any
 * more, and the `storage` permission has gone from the manifest with it.
 */
function Options() {
  return (
    <div className="container" style={{ maxWidth: '600px', margin: '40px auto', padding: '20px', color: '#f8fafc', fontFamily: 'sans-serif' }}>
      <div className="header" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '30px', paddingBottom: '20px', borderBottom: '1px solid #334155' }}>
        <span style={{ fontSize: '24px' }}>⚙️</span>
        <div className="title" style={{ fontSize: '24px', fontWeight: 700 }}>Butchr Settings</div>
      </div>

      {/*
        The Jira credential card used to sit here on its own. It now lives
        inside the Integrations section, under the Jira entry, unchanged.
      */}
      {/* Who watches the fleet (KAN-284). Above Integrations because it is not
          one: an integration is something Butchr talks to, and this is a
          setting about Butchr's own supervision. */}
      <GuardianCard />

      <IntegrationsSection />
    </div>
  );
}

const root = createRoot(document.getElementById('root'));
root.render(<Options />);
