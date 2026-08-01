import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Switching agents on and off from the Agents page.
 *
 * WHY A HOOK AND NOT STATE IN THE PAGE
 *
 * The Agents page re-renders every 2 seconds, from a `list_agents` payload that
 * replaces the whole fleet wholesale. Anything a human is in the middle of —
 * an open confirmation, a stop that has been asked for but not yet taken effect
 * — lives on a different clock from that poll, and mixing the two in the page's
 * own state is how a control comes to flicker: the poll answers, the array is
 * replaced, and the thing the user was looking at is gone or has moved.
 *
 * So the poll owns exactly one thing (what is running) and this hook owns the
 * other (what a person has asked for), keyed by agent name rather than by row.
 * The two never write to each other's state.
 *
 * HOW AN IN-FLIGHT ACTION ENDS
 *
 * By the poll agreeing with it, and not by a response. This is deliberate:
 * `deactivate_response` means the daemon accepted the request, not that the
 * agent is gone, and clearing the control there would flash the row back to
 * "running, press Off" for however many hundred milliseconds the teardown
 * takes — the exact revert the ticket asks not to happen. So a pending Off
 * clears when the agent leaves the census, and a pending On clears when it
 * appears in it. Ground truth ends the spinner; nothing else does.
 *
 * A refusal or an error ends it too, because those mean it will never happen.
 * And a request that produces neither within {@link ACTION_TIMEOUT_MS} ends
 * with a visible complaint rather than a control that spins for ever.
 */

/**
 * How long a stop or start may stay in flight before the page stops claiming
 * to know what is happening. Generous: a Claude spawn does real work — MCP
 * config, workspace trust, a herdr pane — before the agent shows up in a
 * census, and a timeout that fired during a healthy start would be its own
 * kind of lie.
 */
export const ACTION_TIMEOUT_MS = 45000;

const agentNameFor = (type, key) => `butchr-${type}-${String(key).toLowerCase()}`;

/**
 * The name a daemon message is about, or null when it is about nothing we
 * asked for. Every reply below carries `type` and `key`; the name is rebuilt
 * from them by the same rule the daemon names agents by, so the page never has
 * to correlate on a session id it may not have seen.
 */
function subjectOf(payload) {
  if (!payload || typeof payload.key !== 'string' || typeof payload.type !== 'string') return null;
  return agentNameFor(payload.type, payload.key);
}

export function useFleetControls(agents) {
  /** agentName → 'off' | 'on'. What a person has asked for and not yet got. */
  const [pending, setPending] = useState({});
  /** agentName of the row whose Off confirmation is open, or null. */
  const [confirming, setConfirming] = useState(null);
  /** agentName → work-state payload, for the open confirmation. */
  const [workState, setWorkState] = useState({});
  /** agentName → the refusal that stopped it starting. */
  const [refusals, setRefusals] = useState({});
  /** agentName → a plain error string, for everything that is not a refusal. */
  const [errors, setErrors] = useState({});

  const timers = useRef({});

  const clearPending = useCallback((agentName) => {
    if (timers.current[agentName]) {
      clearTimeout(timers.current[agentName]);
      delete timers.current[agentName];
    }
    setPending((prev) => {
      if (!(agentName in prev)) return prev;
      const next = { ...prev };
      delete next[agentName];
      return next;
    });
  }, []);

  const startPending = useCallback((agentName, action) => {
    setPending((prev) => ({ ...prev, [agentName]: action }));
    setErrors((prev) => {
      if (!(agentName in prev)) return prev;
      const next = { ...prev };
      delete next[agentName];
      return next;
    });
    if (timers.current[agentName]) clearTimeout(timers.current[agentName]);
    timers.current[agentName] = setTimeout(() => {
      delete timers.current[agentName];
      setPending((prev) => {
        if (!(agentName in prev)) return prev;
        const next = { ...prev };
        delete next[agentName];
        return next;
      });
      setErrors((prev) => ({
        ...prev,
        [agentName]:
          `No answer from the daemon after ${Math.round(ACTION_TIMEOUT_MS / 1000)}s. ` +
          'The agent list below is still the truth — check it, and check ~/.local/share/butchr/daemon.log.'
      }));
    }, ACTION_TIMEOUT_MS);
  }, []);

  useEffect(() => () => {
    for (const id of Object.values(timers.current)) clearTimeout(id);
    timers.current = {};
  }, []);

  // The poll is what ends an action, not the response to it. An Off is done
  // when the agent is no longer in the census; an On is done when it is.
  useEffect(() => {
    if (!Array.isArray(agents)) return;
    const alive = new Set(agents.map((a) => a.agentName));
    for (const [agentName, action] of Object.entries(pending)) {
      if (action === 'off' && !alive.has(agentName)) clearPending(agentName);
      if (action === 'on' && alive.has(agentName)) clearPending(agentName);
    }
    // A confirmation for an agent that is no longer running has nothing left to
    // confirm — it stopped by some other route while the dialog was open.
    if (confirming && !alive.has(confirming)) setConfirming(null);
  }, [agents, pending, confirming, clearPending]);

  useEffect(() => {
    const handleMessage = (message) => {
      if (message.type !== 'DAEMON_RESPONSE') return;
      const payload = message.payload;
      if (!payload) return;

      if (payload.action === 'agent_work_state_response') {
        const agentName = subjectOf(payload);
        if (!agentName) return;
        setWorkState((prev) => ({ ...prev, [agentName]: payload }));
        return;
      }

      if (payload.action === 'activate_response' && payload.success === false) {
        const agentName = subjectOf(payload);
        if (!agentName) return;
        clearPending(agentName);
        // Everything ActivationRefusal.jsx renders, in the shape the sidepanel
        // hands it — same component, same fields, so a refusal reads the same
        // on both surfaces. KAN-36 was filed because one surface swallowed it;
        // shipping a second surface that swallowed it differently would be
        // worse than shipping no button at all.
        setRefusals((prev) => ({
          ...prev,
          [agentName]: {
            refusedBy: payload.refusedBy ?? null,
            reason:
              payload.reason ??
              payload.error ??
              'The daemon refused to start this agent and gave no reason.',
            derivation: payload.derivation ?? null,
            capacity: payload.capacity ?? null,
            type: payload.type ?? null,
            key: payload.key ?? null,
            priority: payload.priority ?? null,
            preemption: payload.preemption ?? null
          }
        }));
        return;
      }

      if (payload.action === 'deactivate_response' && payload.success === false) {
        const agentName = subjectOf(payload);
        if (!agentName) return;
        clearPending(agentName);
        // The agent is still running. Saying so is the point: a stop that
        // failed and a stop that worked must not look the same, or the list
        // becomes the thing nobody believes.
        setErrors((prev) => ({
          ...prev,
          [agentName]: payload.error ?? 'The daemon could not stop this agent, and gave no reason.'
        }));
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [clearPending]);

  /** Open the Off confirmation, and go and find out what stopping would cost. */
  const requestOff = useCallback((agent) => {
    setConfirming(agent.agentName);
    setWorkState((prev) => {
      const next = { ...prev };
      delete next[agent.agentName];
      return next;
    });
    chrome.runtime.sendMessage({
      type: 'FETCH_AGENT_WORK_STATE',
      workspaceType: agent.type,
      key: agent.key
    });
  }, []);

  const cancelOff = useCallback(() => setConfirming(null), []);

  const confirmOff = useCallback((agent) => {
    setConfirming(null);
    startPending(agent.agentName, 'off');
    // By key rather than by session id, deliberately. A sessionless agent —
    // anything that outlived the daemon holding its terminal — has no session
    // id to stop by and is exactly as stoppable; `deactivate_by_key` reaches
    // both, and using one path means there is one way an agent stops.
    chrome.runtime.sendMessage({
      type: 'DEACTIVATE_BUTCHR_BY_KEY',
      workspaceType: agent.type,
      key: agent.key
    });
  }, [startPending]);

  /**
   * Switch a stopped agent back on.
   *
   * `candidate` is a row from one of the three not-running lists the daemon
   * sends: missing, preempted, or standby. They differ in why the agent is not
   * running and not at all in how it is started.
   */
  const turnOn = useCallback((candidate, options = {}) => {
    const agentName = candidate.agentName ?? agentNameFor(candidate.type, candidate.key);
    setRefusals((prev) => {
      const next = { ...prev };
      delete next[agentName];
      return next;
    });
    startPending(agentName, 'on');
    chrome.runtime.sendMessage({
      type: 'ACTIVATE_BUTCHR_BY_KEY',
      workspaceType: candidate.type,
      key: candidate.key,
      ...(candidate.url ? { url: candidate.url } : {}),
      ...(candidate.defaultAgent ? { defaultAgent: candidate.defaultAgent } : {}),
      ...(options.override ? { override: true } : {}),
      ...(options.preempt ? { preempt: true } : {})
    });
  }, [startPending]);

  const dismissRefusal = useCallback((agentName) => {
    setRefusals((prev) => {
      if (!(agentName in prev)) return prev;
      const next = { ...prev };
      delete next[agentName];
      return next;
    });
  }, []);

  return {
    pending,
    confirming,
    workState,
    refusals,
    errors,
    requestOff,
    cancelOff,
    confirmOff,
    turnOn,
    dismissRefusal
  };
}
