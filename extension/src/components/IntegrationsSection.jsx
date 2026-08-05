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
//
// KAN-91 adds the switch. An integration now carries a persisted enabled state
// (KAN-85), defaulting to off, and a disabled one contributes nothing: no
// workspace types, no MCP servers. Two consequences shape this file.
//
// A disabled entry still lists what it *would* provide, greyed out. The daemon
// reports `providedTypes` whether the integration is on or off precisely so
// this page can do that — a switch with nothing beside it is a switch whose
// meaning the reader has to already know, and "everything starts disabled"
// means a fresh install is nothing but such switches.
//
// And turning one off is consequential enough to ask first. Disabling Atlassian
// unregisters `epic`/`story`/`task`, after which no Jira URL opens a workspace
// and no new agent of those types can start. That is the same class of action
// as the Agents page's Off control, and it is guarded the same way: a
// confirmation that states what is lost, over a button that names the target.
//
// KAN-106 draws the other half of what an integration provides: the MCP servers
// its agents get. The page had said "some workspace types" about a switch whose
// truer answer is "these workspace types *and* these tools, for every agent
// this daemon spawns" — and the tools were the half nobody could see. They come
// from the daemon's `providedMcpServers` for the same reason the types do, and
// with the same rule: nothing about any server is written down in this file, so
// a server added inside an integration appears here with no edit to the
// extension. `butchr` is not one of them — it is core, the daemon's own, and it
// reaches every agent whatever is switched on, so it is drawn once for the
// section rather than attributed to any row.

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

/** The Agents page's confirmation palette, for the same class of decision. */
const CAUTION = {
  bg: 'rgba(245, 158, 11, 0.12)',
  border: '#f59e0b',
  fg: '#fde68a',
  title: '#fffbeb'
};

const button = (extra) => ({
  border: '1px solid #475569',
  borderRadius: '6px',
  padding: '5px 10px',
  fontSize: '12px',
  fontWeight: 600,
  cursor: 'pointer',
  backgroundColor: '#1e293b',
  color: '#e2e8f0',
  ...extra
});

function ProvidedTypes({ providedTypes, enabled = true }) {
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
    <div
      // Inert, not absent. The types are still the answer to "what does this
      // switch turn on?", so they are still rendered — dimmed, struck through,
      // and said to be unregistered, so no reader mistakes the list for a
      // claim that they currently work.
      style={enabled ? undefined : { opacity: 0.55 }}
    >
      <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '8px' }}>
        {enabled ? 'Provides' : 'Would provide'} {providedTypes.length} workspace{' '}
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
            <code
              style={{
                ...chipStyle,
                fontFamily: 'monospace',
                ...(enabled ? {} : { textDecoration: 'line-through' })
              }}
            >
              {t.type}
            </code>
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
      {!enabled && (
        <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '8px', lineHeight: 1.45 }}>
          None of these are registered while this integration is off, so pages that would
          become one of them do not open a workspace. Turning it on registers them.
        </div>
      )}
    </div>
  );
}

/**
 * The reported servers as objects, whatever the daemon on the other end is.
 *
 * A daemon older than KAN-106 reports `providedMcpServers` as bare names, and
 * the extension is reloaded in Chrome independently of the daemon being
 * restarted — the drift the settings page's own staleness check exists for. A
 * name is still a true and useful answer, so an old daemon renders as names
 * with no command lines rather than as a broken list.
 */
const serverRows = (servers) =>
  (servers || []).map((server) => (typeof server === 'string' ? { name: server } : server));

/** One server's command line, as the daemon reported it — or why it did not. */
function ServerDetail({ server }) {
  // KAN-157: a server the daemon knows cannot start on this machine. Said first
  // and said loudly, because the bug this renders was a server that silently did
  // not exist — an agent came up with fewer tools than its workspace declared
  // and no way to find out why. A page that lists the server without this line
  // is the same silence in a different font. The command line still follows, so
  // the reader can see *what* would not start as well as why.
  const unusable = server.unusable ? (
    <span style={{ color: '#f87171', fontSize: '12px', lineHeight: 1.45 }}>
      cannot start on this machine — {server.unusable}
    </span>
  ) : null;

  if (server.detailWithheld) {
    // The daemon withholds the command line of a definition built from a stored
    // credential (router.ts, describeMcpServers). Saying so is the honest
    // rendering: a bare name with no explanation reads like missing data, and
    // the reason — this one is configured from your credential — is itself
    // worth knowing.
    return (
      <span style={{ display: 'block' }}>
        {unusable}
        {unusable && <br />}
        <span style={{ color: '#94a3b8', fontSize: '12px' }}>
          configured from the stored credential, so only its name is shown
        </span>
      </span>
    );
  }

  // An older daemon sends the name alone and says nothing about why. Nothing is
  // the right thing to say about a reason it did not give.
  if (!server.command) return unusable;

  return (
    <span style={{ display: 'block' }}>
      {unusable}
      {unusable && <br />}
      <span
        style={{
          fontFamily: 'monospace',
          fontSize: '12px',
          color: '#94a3b8',
          wordBreak: 'break-all'
        }}
      >
        {[server.command, ...(server.args || [])].join(' ')}
      </span>
      {/*
        KAN-157: for an npx-based server this line is not decoration — it is the
        thing that decides which Node runs it. Rendered under the command rather
        than folded into it, because it is not part of the command line.
      */}
      {server.pathPrefix?.length ? (
        <span
          style={{
            display: 'block',
            fontFamily: 'monospace',
            fontSize: '11px',
            color: '#64748b',
            wordBreak: 'break-all',
            marginTop: '2px'
          }}
        >
          PATH prefixed with {server.pathPrefix.join(':')}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The MCP servers an integration hands its agents.
 *
 * The consequential half of the switch, and the one the page used to omit: a
 * workspace type decides which pages open an agent, but a server decides what
 * every agent this daemon spawns can *do*. Rendered beside the types, from the
 * same response, under the same rule — the daemon reports them whether the
 * integration is on or off, so a switched-off entry can say what turning it on
 * would add.
 *
 * `attaches` is the third state this section has to be honest about. An
 * integration can be switched on and still contribute no servers: the registry
 * attaches them only while the credential is configured, so an agent never
 * boots with a server it cannot authenticate (KAN-85). Enabled-but-not-connected
 * is therefore not "provides these" — it is "provides these once connected",
 * and the difference is exactly the kind of thing a settings page is for.
 */
function ProvidedMcpServers({ servers: reported, enabled = true, attaches = true, name }) {
  const servers = serverRows(reported);

  if (servers.length === 0) {
    // The honest empty case, as ProvidedTypes has. An integration that
    // contributes no tools is a real and unremarkable thing to be.
    return (
      <div style={{ fontSize: '13px', color: '#94a3b8' }}>Adds no MCP servers.</div>
    );
  }

  return (
    <div style={enabled ? undefined : { opacity: 0.55 }}>
      <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '8px' }}>
        {enabled ? 'Adds' : 'Would add'} {servers.length} MCP{' '}
        {servers.length === 1 ? 'server' : 'servers'} to every agent:
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {servers.map((server) => (
          <li
            key={server.name}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: '8px',
              fontSize: '13px',
              padding: '4px 0'
            }}
          >
            <code
              style={{
                ...chipStyle,
                fontFamily: 'monospace',
                ...(enabled ? {} : { textDecoration: 'line-through' })
              }}
            >
              {server.name}
            </code>
            <ServerDetail server={server} />
          </li>
        ))}
      </ul>
      {!enabled ? (
        <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '8px', lineHeight: 1.45 }}>
          None of these reach an agent while this integration is off. Turning it on writes them
          into the workspace of every agent that starts afterwards; agents already running keep
          the configuration they were started with.
        </div>
      ) : !attaches ? (
        <div style={{ fontSize: '12px', color: '#fbbf24', marginTop: '8px', lineHeight: 1.45 }}>
          Not attached yet — {name} is on but not connected, and a server whose credential is
          missing is never written into an agent's workspace. Connecting it below is what adds
          these.
        </div>
      ) : null}
    </div>
  );
}

/**
 * The servers every agent gets regardless — `butchr`, the daemon's own.
 *
 * Drawn once for the section, deliberately not inside any integration's entry.
 * It is core: no switch on this page adds or removes it, and listing it under
 * whichever integration happened to be first would teach the reader something
 * false about what that switch does. Read from the response's own
 * `coreMcpServers` rather than named here, for the same reason nothing else on
 * this page is named here.
 */
function CoreMcpServers({ servers: reported }) {
  const servers = serverRows(reported);
  if (servers.length === 0) return null;

  return (
    <div
      style={{
        marginTop: '12px',
        padding: '10px 12px',
        borderRadius: '6px',
        background: '#0b1220',
        border: '1px solid #1e293b',
        fontSize: '12px',
        color: '#94a3b8',
        lineHeight: 1.5
      }}
    >
      Every agent also gets{' '}
      {servers.map((server, i) => (
        <React.Fragment key={server.name}>
          {i > 0 && (i === servers.length - 1 ? ' and ' : ', ')}
          <code style={{ ...chipStyle, fontFamily: 'monospace' }}>{server.name}</code>
        </React.Fragment>
      ))}
      {' '}— core, not from any integration below. It is Butchr talking to itself: the tools an
      agent uses to see and drive the fleet it belongs to. No switch here adds or removes it.
    </div>
  );
}

/**
 * The switch itself.
 *
 * `role="switch"` rather than a checkbox: this is a control whose two states
 * are on and off, and the daemon's own field is called `enabled`.
 *
 * Turning one *on* is one click — it adds capability and takes nothing away.
 * Turning one *off* is not, which is why `onRequestDisable` is a different
 * callback from `onEnable` rather than one handler with a boolean.
 */
function EnabledToggle({ integration, pending, onEnable, onRequestDisable }) {
  const enabled = !!integration.enabled;

  if (pending) {
    // The same rule as the Agents page: a control mid-flight stops offering a
    // choice and reports the one that was made, rather than greying out and
    // leaving the reader to guess which way it went.
    return (
      <span style={{ fontSize: '12px', color: '#fbbf24', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {enabled ? 'Turning off…' : 'Turning on…'}
      </span>
    );
  }

  return (
    <button
      role="switch"
      aria-checked={enabled}
      aria-label={`${integration.name} integration`}
      title={enabled ? `Turn ${integration.name} off` : `Turn ${integration.name} on`}
      onClick={() => (enabled ? onRequestDisable(integration) : onEnable(integration))}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '8px',
        border: `1px solid ${enabled ? '#10b981' : '#475569'}`,
        borderRadius: '999px',
        padding: '3px 10px 3px 4px',
        fontSize: '12px',
        fontWeight: 600,
        cursor: 'pointer',
        backgroundColor: enabled ? 'rgba(16, 185, 129, 0.14)' : '#1e293b',
        color: enabled ? '#6ee7b7' : '#94a3b8'
      }}
    >
      <span
        style={{
          width: '26px',
          height: '14px',
          borderRadius: '999px',
          background: enabled ? '#10b981' : '#475569',
          position: 'relative',
          flexShrink: 0
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: '2px',
            left: enabled ? '14px' : '2px',
            width: '10px',
            height: '10px',
            borderRadius: '50%',
            background: '#f8fafc'
          }}
        />
      </span>
      {enabled ? 'On' : 'Off'}
    </button>
  );
}

/**
 * What turning an integration off costs, said before it happens.
 *
 * The wording is KAN-85's decision reported rather than restated in softer
 * terms. This ticket left the question open — refuse while agents are running,
 * or allow and block only new activations — and KAN-85 settled it as the
 * second: disabling is always allowed, running agents are left strictly alone,
 * and only new activations are refused. So this panel says that, rather than
 * warning about a refusal the daemon will not perform. A confirmation that
 * describes a rule the system does not follow is worse than none.
 *
 * The agents that keep running are named afterwards, not here: the daemon
 * reports them in its `set_integration_enabled_response`, and asking it to
 * enumerate them beforehand would be a second round trip for a list that
 * changes nothing about the decision. The Agents page can go and look before
 * asking because the cost there is somebody's uncommitted work; here nothing
 * is lost that turning the switch back on does not restore.
 */
function DisableConfirmation({ integration, onCancel, onConfirm }) {
  const types = (integration.providedTypes || []).map((t) => t.type);
  // KAN-106: the other half of the cost, named the same way the types are. The
  // panel already said this for a type-less integration ("none of its MCP
  // servers reach the agents that start") and said nothing about it for one
  // with types, which is the case where the tools actually matter.
  const servers = serverRows(integration.providedMcpServers).map((s) => s.name);

  return (
    <div
      role="alertdialog"
      aria-label={`Turn ${integration.name} off?`}
      style={{
        backgroundColor: CAUTION.bg,
        border: `1px solid ${CAUTION.border}`,
        borderRadius: '8px',
        padding: '12px 14px',
        marginBottom: '12px'
      }}
    >
      <div style={{ fontWeight: 700, fontSize: '13px', color: CAUTION.title }}>
        Turn {integration.name} off?
      </div>

      <div style={{ fontSize: '12px', color: CAUTION.fg, marginTop: '6px', lineHeight: 1.45 }}>
        {types.length > 0 ? (
          <>
            This unregisters{' '}
            {types.map((t, i) => (
              <React.Fragment key={t}>
                {i > 0 && (i === types.length - 1 ? ' and ' : ', ')}
                <code style={{ fontFamily: 'monospace', fontWeight: 700 }}>{t}</code>
              </React.Fragment>
            ))}
            . While it is off, a page that would become one of those does not open a workspace,
            and no new agent of those types can be started.
            {servers.length > 0 && (
              <>
                {' '}
                No agent that starts afterwards gets{' '}
                {servers.map((s, i) => (
                  <React.Fragment key={s}>
                    {i > 0 && (i === servers.length - 1 ? ' or ' : ', ')}
                    <code style={{ fontFamily: 'monospace', fontWeight: 700 }}>{s}</code>
                  </React.Fragment>
                ))}
                {' '}either.
              </>
            )}
          </>
        ) : (
          <>
            While it is off, {integration.name} contributes nothing to Butchr — no workspace types,
            and none of its MCP servers reach the agents that start.
          </>
        )}
      </div>

      <div style={{ fontSize: '12px', color: CAUTION.fg, marginTop: '8px', lineHeight: 1.45 }}>
        <b>Agents already running are left alone.</b> They keep the configuration already written
        into their workspaces and go on working; it is only new activations that are refused.
      </div>

      <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '8px', lineHeight: 1.45 }}>
        The stored credential is kept — turning an integration off is not forgetting it, and
        turning it back on needs nothing re-entered. Clearing the credential is the separate
        control below.
      </div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '12px', justifyContent: 'flex-end' }}>
        <button style={button()} onClick={onCancel}>
          Cancel
        </button>
        {/* Names its target, for the same reason the Agents page's does: a bare
            "Confirm" among several integration entries is a control whose
            subject the reader has to reconstruct. */}
        <button
          style={button({ backgroundColor: '#78350f', borderColor: '#b45309', color: '#fef3c7' })}
          onClick={() => onConfirm(integration)}
        >
          Turn {integration.name} off
        </button>
      </div>
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

/** What the daemon reported after the switch was flipped, or why it did not. */
function ToggleOutcome({ result }) {
  if (!result) return null;

  if (!result.ok) {
    return (
      <div style={{ fontSize: '12px', color: '#fca5a5', marginBottom: '10px', lineHeight: 1.45 }}>
        {result.text}
      </div>
    );
  }

  // Named, not counted — the daemon sends the addresses for exactly this, and
  // "3 agents are unaffected" is a number the reader cannot check against the
  // fleet they are looking at.
  const running = result.runningAgentsUnaffected || [];
  return (
    <div style={{ fontSize: '12px', color: '#86efac', marginBottom: '10px', lineHeight: 1.45 }}>
      {result.text}
      {running.length > 0 && (
        <>
          {' '}
          <span style={{ color: '#94a3b8' }}>
            Still running, untouched:{' '}
            <span style={{ fontFamily: 'monospace' }}>{running.join(', ')}</span>.
          </span>
        </>
      )}
    </div>
  );
}

function IntegrationEntry({ integration, card, toggle = {} }) {
  const {
    confirmingId = null,
    pendingId = null,
    results = {},
    onEnable,
    onRequestDisable,
    onCancelDisable,
    onConfirmDisable
  } = toggle;

  const enabled = !!integration.enabled;
  const switchable = !!onEnable && !!onRequestDisable;
  // The daemon's own gate, restated from the row rather than guessed: servers
  // attach while the integration is on *and* — where it has a credential at all
  // — that credential is configured. An integration this daemon holds no
  // credential for (`available: false`) has nothing to be unconfigured about.
  const attaches =
    enabled &&
    (integration.available === false || !!(integration.credential || {}).configured);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap' }}>
          <ConnectionState integration={integration} />
          {switchable && (
            <EnabledToggle
              integration={integration}
              pending={pendingId === integration.id}
              onEnable={onEnable}
              onRequestDisable={onRequestDisable}
            />
          )}
        </div>
      </div>

      {confirmingId === integration.id && (
        <DisableConfirmation
          integration={integration}
          onCancel={onCancelDisable}
          onConfirm={onConfirmDisable}
        />
      )}

      <ToggleOutcome result={results[integration.id]} />

      <div
        style={{
          padding: '12px',
          borderRadius: '6px',
          background: '#0b1220',
          border: `1px solid ${enabled ? '#334155' : '#1e293b'}`,
          marginBottom: '12px'
        }}
      >
        <ProvidedTypes providedTypes={integration.providedTypes} enabled={enabled} />
        <div style={{ height: '1px', background: '#1e293b', margin: '12px 0' }} />
        <ProvidedMcpServers
          servers={integration.providedMcpServers}
          enabled={enabled}
          attaches={attaches}
          name={integration.name}
        />
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
 *
 * `toggle` carries the switch's callbacks and its transient state — which
 * entry is asking for confirmation, which is mid-flight, what the daemon last
 * answered. Hoisted out for the same reason AgentOffControl's is: it keeps
 * this view a function of its arguments, so the render harness can draw the
 * confirmation open without a browser. Omit it and the switches are not drawn
 * at all, which is what the harness wants for the plain summary rows.
 */
export function IntegrationsSectionView({
  integrations,
  coreMcpServers = null,
  error = null,
  renderCard,
  toggle
}) {
  const card = (integration) => {
    if (renderCard) return renderCard(integration);
    const Card = CREDENTIAL_CARDS[integration.id];
    return Card ? <Card /> : null;
  };

  return (
    <div style={{ marginTop: '30px' }}>
      <div style={{ fontSize: '20px', fontWeight: 700, marginBottom: '6px' }}>Integrations</div>
      <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '4px' }}>
        What Butchr can talk to, whether it is connected, and what each one contributes — the
        workspace types it registers, and the MCP servers it hands every agent that starts. A type
        is either recognised from the page URL or refined afterwards by asking the integration what
        the page really is — both are shown, because the difference is what a credential buys you.
        Each integration is off until you switch it on; a switched-off one still says what it would
        provide, so the switch is a choice rather than a guess.
      </div>

      <CoreMcpServers servers={coreMcpServers} />

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
          <IntegrationEntry
            key={integration.id}
            integration={integration}
            card={card(integration)}
            toggle={toggle}
          />
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
  /**
   * The servers every agent gets whatever is switched on. Held beside the rows
   * rather than inside them because that is what they are: not one
   * integration's, and not changed by any toggle on this page.
   */
  const [coreMcpServers, setCoreMcpServers] = useState(null);
  const [error, setError] = useState(null);
  /** The id whose disable confirmation is open; one at a time. */
  const [confirmingId, setConfirmingId] = useState(null);
  /** The id whose switch is mid-flight, so it reports rather than offers. */
  const [pendingId, setPendingId] = useState(null);
  /** id → what the daemon answered about the last flip of that switch. */
  const [results, setResults] = useState({});

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
        // A daemon too old to send them says nothing about core servers, which
        // is different from saying there are none — leave the previous answer
        // rather than drawing an empty claim.
        if (Array.isArray(msg.coreMcpServers)) setCoreMcpServers(msg.coreMcpServers);
        return;
      }
      if (msg.action === 'set_integration_enabled_response') {
        setPendingId(null);
        if (msg.success === false) {
          setResults((prev) => ({
            ...prev,
            [msg.integration]: {
              ok: false,
              text: msg.error || 'The daemon refused to change this integration.'
            }
          }));
          return;
        }
        // Re-rendered from this answer rather than by asking again: KAN-85
        // shaped the response to carry the row's own fields precisely so the
        // switch does not need a second round trip to stop lying about itself.
        // The fields it does not carry — the credential summary, where the
        // secret lives, whether the daemon supports one — are the fields a
        // toggle cannot change, so keeping the previous values is not staleness.
        setIntegrations((prev) =>
          prev === null
            ? prev
            : prev.map((row) =>
                row.id === msg.integration
                  ? {
                      ...row,
                      enabled: msg.enabled,
                      ...(msg.name !== undefined ? { name: msg.name } : {}),
                      ...(msg.providedTypes !== undefined ? { providedTypes: msg.providedTypes } : {}),
                      ...(msg.providedMcpServers !== undefined
                        ? { providedMcpServers: msg.providedMcpServers }
                        : {})
                    }
                  : row
              )
        );
        setResults((prev) => ({
          ...prev,
          [msg.integration]: {
            ok: true,
            text: msg.enabled
              ? `${msg.name || msg.integration} is on.`
              : `${msg.name || msg.integration} is off.`,
            runningAgentsUnaffected: msg.runningAgentsUnaffected || []
          }
        }));
        return;
      }
      if (INVALIDATING_RESPONSES.has(msg.action)) ask();
    };

    chrome.runtime.onMessage.addListener(onMessage);
    ask();
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const send = (integration, enabled) => {
    setConfirmingId(null);
    setPendingId(integration.id);
    setResults((prev) => {
      // The previous answer described the previous flip; leaving it up beside
      // a switch that has since moved is the stale-page failure this section
      // was already written to avoid.
      const { [integration.id]: _dropped, ...rest } = prev;
      return rest;
    });
    chrome.runtime.sendMessage(
      { type: 'SET_INTEGRATION_ENABLED', integration: integration.id, enabled },
      (reply) => {
        if (chrome.runtime.lastError || (reply && reply.status === 'error')) {
          setPendingId(null);
          setResults((prev) => ({
            ...prev,
            [integration.id]: {
              ok: false,
              text: 'The daemon is not connected, so this integration could not be changed.'
            }
          }));
        }
      }
    );
  };

  const toggle = {
    confirmingId,
    pendingId,
    results,
    onEnable: (integration) => send(integration, true),
    onRequestDisable: (integration) => setConfirmingId(integration.id),
    onCancelDisable: () => setConfirmingId(null),
    onConfirmDisable: (integration) => send(integration, false)
  };

  return (
    <IntegrationsSectionView
      integrations={integrations}
      coreMcpServers={coreMcpServers}
      error={error}
      toggle={toggle}
    />
  );
}
