import React, { useEffect, useState } from 'react';

import { inputStyle, labelStyle, hintStyle } from './credentialStyles.js';
import { describeGuardian, guardianName } from '../lib/guardian.js';

/**
 * The guardian setting, on the options page.
 *
 * The human asked for it here by name: *"one guardian agent, which is
 * configurable in the settings page or via mcp."* The MCP half is
 * `butchr_guardian`; this is the other, and both go through the daemon's one
 * `guardian` action so that neither can acquire a rule of its own.
 *
 * ---------------------------------------------------------------------------
 * A POINTER, WHICH IS WHY THIS IS NOT A PICKER OF RUNNING AGENTS
 * ---------------------------------------------------------------------------
 *
 * The guardian **names an agent that already exists and already has its own
 * ticket** — the human, relayed 2026-08-11: *"the guardian agent should pointed
 * to an existing agent, not a whole new agent."* Nothing on this card starts,
 * reserves or creates anything, and pointing it at an agent that is not running
 * is **allowed**: the guardian is a setting, and setting it before the agent is
 * up is an ordinary thing to want.
 *
 * So the address is typed, with the running agents offered as suggestions
 * rather than as the permitted set. A dropdown restricted to what is running
 * would have quietly made the setting depend on the fleet's current state, and
 * would have made the honest case — *a pointer at something that is not there,
 * reported loudly* — unreachable from the UI that is supposed to demonstrate it.
 *
 * ---------------------------------------------------------------------------
 * THE REFUSAL IS SHOWN, NOT PRE-EMPTED
 * ---------------------------------------------------------------------------
 *
 * There is exactly one guardian, and setting a different one is **refused** by
 * the daemon unless `replace` is passed. This card does not check for an
 * incumbent before asking — it asks, and renders the refusal, which names who
 * the guardian already is and when it was set. A UI that pre-empted the refusal
 * would be a second copy of the rule, and the copy in the UI is the one that
 * goes stale; it would also mean nobody ever sees the sentence that explains
 * why there is only one.
 *
 * The Replace control appears **after** a refusal rather than beside the Save
 * button, so that changing the guardian is a decision taken with the incumbent's
 * name on screen. That is the whole difference between *setting* a guardian and
 * *knowing who the guardian is and changing it*.
 */

const PANEL = {
  alarm: { bg: 'rgba(220, 38, 38, 0.12)', border: '#ef4444', fg: '#fecaca' },
  caution: { bg: 'rgba(217, 119, 6, 0.12)', border: '#f59e0b', fg: '#fde68a' },
  neutral: { bg: 'rgba(148, 163, 184, 0.08)', border: '#334155', fg: '#cbd5e1' },
  calm: { bg: 'rgba(148, 163, 184, 0.08)', border: '#334155', fg: '#cbd5e1' }
};

const button = (extra) => ({
  border: '1px solid #475569',
  borderRadius: '6px',
  padding: '6px 12px',
  background: '#1e293b',
  color: '#e2e8f0',
  fontSize: '13px',
  cursor: 'pointer',
  ...extra
});

/**
 * The card as a function of its arguments — no messaging, so a render harness
 * can draw every state. Same split as `IntegrationsSectionView`.
 */
export function GuardianCardView({
  state,
  config,
  type,
  // NOT `key`. React reserves that name: passing `key={…}` to a component
  // strips it from props entirely, so the field would have rendered
  // permanently empty and every save would have posted an empty key. Caught
  // before it shipped, and named here because the next author will reach for
  // the obvious spelling too.
  workspaceKey,
  onTypeChange,
  onKeyChange,
  onSave,
  onReplace,
  onClear,
  onPoke,
  pending = false,
  result = null,
  candidates = []
}) {
  const described = describeGuardian(state);
  const palette = described ? PANEL[described.tone] ?? PANEL.neutral : PANEL.neutral;
  const current = guardianName(state?.address);

  return (
    <div style={{ marginTop: '30px' }}>
      <div style={{ fontSize: '20px', fontWeight: 700, marginBottom: '6px' }}>Guardian</div>
      <div style={{ ...hintStyle, marginBottom: '16px' }}>
        The one agent Butchr pokes on a timer to sweep the fleet. It is a <strong>pointer to an
        agent that already exists</strong> — the poke is additional to whatever that agent is
        already working on, it costs no capacity, and nothing here starts anything. There is
        exactly one, deliberately: the failure mode of two is two agents each assuming the other
        swept.
      </div>

      <div
        style={{
          backgroundColor: '#111827',
          borderRadius: '8px',
          border: '1px solid #334155',
          padding: '20px'
        }}
      >
        {/* WHAT IS TRUE RIGHT NOW, in the same words the board page uses, from
            the same describeGuardian. One description, two surfaces — a settings
            page that phrased this differently from the board would be the second
            copy that drifts. */}
        {described ? (
          <div
            style={{
              backgroundColor: palette.bg,
              border: `1px solid ${palette.border}`,
              borderRadius: '6px',
              padding: '10px 12px',
              marginBottom: '18px',
              fontSize: '13px',
              lineHeight: 1.5
            }}
          >
            <div style={{ color: palette.fg, fontWeight: 700, marginBottom: '4px' }}>
              {described.headline}
            </div>
            <div style={{ color: '#94a3b8' }}>{described.detail}</div>
            {described.action ? (
              <div style={{ color: palette.fg, fontWeight: 600, marginTop: '6px' }}>
                {described.action}
              </div>
            ) : null}
            {/* The limit, rendered in every state including the reassuring one —
                see lib/guardian.js. The daemon's sentence, verbatim. */}
            <div
              style={{
                color: '#64748b',
                marginTop: '8px',
                paddingTop: '6px',
                borderTop: '1px solid rgba(100, 116, 139, 0.25)',
                fontSize: '12px'
              }}
            >
              {described.proves}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: '13px', color: '#94a3b8', marginBottom: '18px' }}>
            Asking the daemon…
          </div>
        )}

        <label style={labelStyle} htmlFor="guardian-type">
          Workspace type
        </label>
        <div style={hintStyle}>
          The agent's type, e.g. <code>epic</code>. Suggestions are the agents running right now;
          you may name one that is not, and the next poke will report that it could not be
          delivered.
        </div>
        <input
          id="guardian-type"
          list="guardian-types"
          style={{ ...inputStyle, marginBottom: '16px' }}
          value={type}
          placeholder="epic"
          onChange={(e) => onTypeChange(e.target.value)}
        />
        <datalist id="guardian-types">
          {[...new Set(candidates.map((c) => c.type).filter(Boolean))].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>

        <label style={labelStyle} htmlFor="guardian-key">
          Workspace key
        </label>
        <input
          id="guardian-key"
          list="guardian-keys"
          style={{ ...inputStyle, marginBottom: '16px' }}
          value={workspaceKey}
          placeholder="KAN-203"
          onChange={(e) => onKeyChange(e.target.value)}
        />
        <datalist id="guardian-keys">
          {candidates.map((c) => (
            <option key={`${c.type}/${c.key}`} value={c.key}>
              {`${c.type}/${c.key}`}
            </option>
          ))}
        </datalist>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <button
            style={button({
              background: '#1d4ed8',
              borderColor: '#1d4ed8',
              color: '#eff6ff',
              opacity: pending || !type.trim() || !workspaceKey.trim() ? 0.6 : 1
            })}
            disabled={pending || !workspaceKey.trim() || !type.trim()}
            onClick={onSave}
          >
            {pending ? 'Saving…' : 'Set guardian'}
          </button>

          {/* POKE NOW. It exists because the interesting question about a
              guardian is not who it is but whether it is reachable, and waiting
              thirty minutes to find out is what this whole feature is trying to
              stop somebody doing. It runs the same code path the timer takes. */}
          <button
            style={button({ opacity: pending || !current ? 0.6 : 1 })}
            disabled={pending || !current}
            onClick={onPoke}
            title={
              current
                ? `Send one poke to ${current} now, off the schedule`
                : 'There is no guardian to poke'
            }
          >
            Poke now
          </button>

          <button
            style={button({ opacity: pending || !current ? 0.6 : 1 })}
            disabled={pending || !current}
            onClick={onClear}
          >
            Clear
          </button>
        </div>

        {/* THE DAEMON'S ANSWER, INCLUDING WHEN IT IS A REFUSAL. An undelivered
            poke and a refused set both arrive here as failures and are rendered
            as failures — a poke reported as "sent" when nothing was delivered is
            precisely the reassurance this feature exists to refuse. */}
        {result ? (
          <div
            style={{
              marginTop: '14px',
              fontSize: '13px',
              lineHeight: 1.5,
              color: result.ok ? '#86efac' : '#fca5a5'
            }}
          >
            {result.message}
            {result.refusal === 'already-set' && result.incumbent ? (
              <div style={{ marginTop: '10px' }}>
                <button
                  style={button({
                    background: '#b91c1c',
                    borderColor: '#b91c1c',
                    color: '#fef2f2'
                  })}
                  onClick={onReplace}
                >
                  {`Replace ${guardianName(result.incumbent)} with ${type}/${workspaceKey}`}
                </button>
              </div>
            ) : null}
          </div>
        ) : null}

        {config?.setAt ? (
          <div style={{ marginTop: '14px', fontSize: '12px', color: '#64748b' }}>
            {`Set ${new Date(config.setAt).toLocaleString()}`}
            {config.setBy ? ` by ${config.setBy}` : ''}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The card, wired to the daemon. */
export function GuardianCard() {
  const [state, setState] = useState(null);
  const [config, setConfig] = useState(null);
  const [type, setType] = useState('');
  const [keyValue, setKeyValue] = useState('');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState(null);
  const [candidates, setCandidates] = useState([]);

  const ask = () => chrome.runtime.sendMessage({ type: 'GUARDIAN', op: 'get' });

  useEffect(() => {
    const onMessage = (payload) => {
      if (!payload || typeof payload !== 'object') return;

      if (payload.action === 'guardian_response') {
        setPending(false);
        if (payload.state) setState(payload.state);
        if (payload.config) setConfig(payload.config);

        if (payload.op === 'get') return;

        if (payload.success) {
          setResult({
            ok: true,
            message:
              payload.op === 'poke'
                ? `Poke delivered: ${payload.result?.detail ?? 'no detail'}`
                : payload.detail ?? 'Saved.'
          });
          // The address the daemon now holds, so the fields show what is true
          // rather than what was typed.
          if (payload.op === 'clear') {
            setType('');
            setKeyValue('');
          }
        } else {
          setResult({
            ok: false,
            // The daemon's own sentence. Not paraphrased: the refusal names the
            // incumbent and the reason there is only one guardian, and a
            // shortened version would drop exactly the part that explains it.
            message: payload.error ?? 'The daemon refused that.',
            refusal: payload.refusal ?? null,
            incumbent: payload.incumbent ?? null
          });
        }
        return;
      }

      // The running fleet, for the suggestions. Offered, never enforced — see
      // this file's header.
      if (payload.action === 'list_agents_response' && Array.isArray(payload.agents)) {
        setCandidates(
          payload.agents
            .filter((a) => a && a.type && a.key)
            .map((a) => ({ type: a.type, key: a.key }))
        );
        if (payload.guardian) setState(payload.guardian);
      }
    };

    chrome.runtime.onMessage.addListener(onMessage);
    ask();
    chrome.runtime.sendMessage({ type: 'FETCH_AGENTS' });
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  // Show the configured guardian in the fields once, so the page opens
  // describing what is true rather than empty.
  useEffect(() => {
    if (config?.address && !type && !keyValue) {
      setType(config.address.type ?? '');
      setKeyValue(config.address.key ?? '');
    }
  }, [config]);

  const send = (message) => {
    setPending(true);
    setResult(null);
    chrome.runtime.sendMessage(message);
  };

  return (
    <GuardianCardView
      state={state}
      config={config}
      type={type}
      workspaceKey={keyValue}
      onTypeChange={setType}
      onKeyChange={setKeyValue}
      onSave={() =>
        send({
          type: 'GUARDIAN',
          op: 'set',
          workspaceType: type.trim(),
          key: keyValue.trim()
        })
      }
      onReplace={() =>
        send({
          type: 'GUARDIAN',
          op: 'set',
          workspaceType: type.trim(),
          key: keyValue.trim(),
          replace: true
        })
      }
      onClear={() => send({ type: 'GUARDIAN', op: 'clear' })}
      onPoke={() => send({ type: 'GUARDIAN', op: 'poke' })}
      pending={pending}
      result={result}
      candidates={candidates}
    />
  );
}
