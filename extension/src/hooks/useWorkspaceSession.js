import { useState, useEffect, useRef, useCallback } from 'react';

// How long to wait for the daemon's status_response before calling it a
// failure. The daemon answers a status check in milliseconds; anything
// approaching this means the native host or daemon is not healthy.
const STATUS_TIMEOUT_MS = 5000;

/**
 * pageStatus is an explicit state machine rather than a `supported` boolean,
 * so "we haven't heard back yet" and "the daemon says this page isn't
 * supported" cannot render as the same thing:
 *   'checking'    - status request in flight
 *   'supported'   - daemon resolved a workspace type for this URL
 *   'unsupported' - daemon answered: no workspace type matches
 *   'error'       - daemon unreachable, errored, or never answered
 */
export function useWorkspaceSession(currentTab, activeTabView, setActiveTabView, termRef) {
  const [pageStatus, setPageStatus] = useState('checking');
  const [statusError, setStatusError] = useState(null);
  const [active, setActive] = useState(false);
  // Whether this daemon holds a session for the agent. `active` says the agent
  // exists at all — it outlives the daemon, so the two come apart after a
  // daemon restart, and only `active` may drive the On/Off toggle.
  const [attached, setAttached] = useState(false);
  const [sessionData, setSessionData] = useState({});
  // Why the terminal stopped, when the daemon told us. Distinct from
  // `attached === false`, which also covers the ordinary "haven't attached
  // yet" case: this one means a terminal we *were* watching died, and it is
  // the difference between a pane that is thinking and a pane that is dead.
  const [detachReason, setDetachReason] = useState(null);
  // Why the last attempt to start this agent was refused, when the daemon told
  // us. It always did; nothing here listened, so the switch flipped back in
  // silence and the user had a dead control rather than a capacity limit.
  const [activateError, setActivateError] = useState(null);

  const respondedRef = useRef(false);
  // One re-attach attempt per detached agent: the activate response arrives
  // asynchronously, and re-firing on every render would spawn a stream of
  // activates at an agent that is already being attached to.
  const reattachSentRef = useRef(false);

  const retryStatus = useCallback(() => {
    if (!currentTab || !currentTab.url) return;
    respondedRef.current = false;
    reattachSentRef.current = false;
    setDetachReason(null);
    setActivateError(null);
    setPageStatus('checking');
    setStatusError(null);
    chrome.runtime.sendMessage({ type: 'CHECK_STATUS', url: currentTab.url });
  }, [currentTab]);

  // Restart the check (and its timeout) whenever the tab or URL changes.
  useEffect(() => {
    if (!currentTab || !currentTab.url) return;
    respondedRef.current = false;
    reattachSentRef.current = false;
    setDetachReason(null);
    setActivateError(null);
    setPageStatus('checking');
    setStatusError(null);

    const timer = setTimeout(() => {
      if (!respondedRef.current) {
        setStatusError('No response from the Butchr daemon.');
        setPageStatus('error');
      }
    }, STATUS_TIMEOUT_MS);

    return () => clearTimeout(timer);
  }, [currentTab?.id, currentTab?.url]);

  useEffect(() => {
    const handleMessage = (message) => {
      if (message.type === 'DAEMON_STATUS' && message.connected === false) {
        respondedRef.current = true;
        setStatusError('The Butchr native host is not connected.');
        setPageStatus('error');
        return;
      }

      if (message.type !== 'DAEMON_RESPONSE') return;
      const payload = message.payload;

      // The native host reports it cannot reach the daemon at all.
      if (payload.action === 'daemon_error') {
        respondedRef.current = true;
        setStatusError(payload.error || 'The Butchr daemon is not reachable.');
        setPageStatus('error');
        return;
      }

      if (payload.action === 'status_response' || payload.supported !== undefined) {
        respondedRef.current = true;
        if (payload.supported) {
          setPageStatus('supported');
          setStatusError(null);
          setSessionData({
            type: payload.type,
            key: payload.key,
            sessionId: payload.sessionId,
            status: payload.status,
            createdAt: payload.createdAt,
            workDir: payload.workDir,
            herdrStatus: payload.herdrStatus
          });
          setActive(!!payload.active);
          setAttached(!!payload.attached);
          // A fresh answer from the daemon supersedes any remembered death:
          // if it says we are attached, the terminal is live again.
          if (payload.attached) setDetachReason(null);
        } else {
          setPageStatus('unsupported');
          setStatusError(null);
          if (activeTabView === 'info') setActiveTabView('terminal');
        }
      } else if (payload.action === 'error_response') {
        respondedRef.current = true;
        setStatusError(payload.error || 'The daemon returned an error.');
        setPageStatus('error');
      } else if (payload.action === 'agent_detached_event') {
        // The PTY behind this terminal died. The agent itself may well still
        // be running, so `active` is left alone — only the attach is gone.
        setSessionData((prev) => {
          if (payload.key && prev.key && payload.key !== prev.key) return prev;
          setAttached(false);
          setDetachReason(payload.reason === 'taken-over' ? 'taken-over' : 'exited');
          return prev;
        });
      } else if (payload.action === 'activate_response' && payload.success === false) {
        // The refusal the panel used to throw away. Ordered before the success
        // branch because a refused activate carries no sessionId and would
        // otherwise match nothing at all — which is exactly what happened.
        //
        // `active` is deliberately left alone. A capacity refusal means no
        // agent was started, and the switch is already showing Off; a refusal
        // on a re-attach means the agent is running and saying otherwise would
        // be the lie this toggle has twice been fixed for telling.
        setSessionData((prev) => {
          if (payload.key && prev.key && payload.key !== prev.key) return prev;
          setActivateError({
            refusedBy: payload.refusedBy ?? null,
            reason:
              payload.reason ??
              payload.error ??
              'The daemon refused to start this agent and gave no reason.',
            derivation: payload.derivation ?? null,
            capacity: payload.capacity ?? null,
            // Who this activation is and what it is worth, so the panel can
            // state the comparison rather than just its outcome.
            type: payload.type ?? null,
            key: payload.key ?? null,
            priority: payload.priority ?? null,
            // Present only when this activation outranks something running.
            // It is what the panel turns into a named stand-down button; with
            // it absent, no preemption is on offer and none is shown.
            preemption: payload.preemption ?? null
          });
          // This attempt is finished. Re-arm the automatic re-attach so that
          // closing an agent and coming back is not suppressed by a flag left
          // set by an attempt that never landed.
          reattachSentRef.current = false;
          return prev;
        });
      } else if (payload.action === 'activate_response' && payload.sessionId) {
        setActive(true);
        setAttached(true);
        setDetachReason(null);
        setActivateError(null);
        setSessionData((prev) => ({
          ...prev,
          sessionId: payload.sessionId,
          status: payload.status,
          createdAt: payload.createdAt,
          workDir: payload.workDir,
          // A state carried over from the previous session would describe an
          // agent that no longer exists; the next status check fills this in.
          herdrStatus: undefined
        }));
        setActiveTabView('terminal');
      } else if (payload.action === 'deactivate_response' || payload.action === 'agent_deactivated_event' || payload.action === 'agent_reset_event') {
        // A deactivate that failed left the agent running; flipping to Off
        // would be the same lie this toggle exists to stop telling.
        if (payload.action === 'deactivate_response' && payload.success === false) return;

        // Check if the event is for the current session (if it has type/key)
        setSessionData((prev) => {
          if (payload.key && prev.key && payload.key !== prev.key) return prev;
          setActive(false);
          setAttached(false);
          // Off is a deliberate stop, not a failure worth reporting as one.
          setDetachReason(null);
          // An agent going away is the thing that makes room, so a capacity
          // refusal from before it did is no longer describing this machine.
          setActivateError(null);
          reattachSentRef.current = false;
          if (termRef.current && payload.action === 'agent_reset_event') {
            termRef.current.write('\r\n\x1b[31m[Workspace Reset by Agent]\x1b[0m\r\n');
          }
          return { ...prev, sessionId: null, herdrStatus: undefined };
        });
      } else if (payload.action === 'agent_activated_event') {
        setSessionData((prev) => {
          if (payload.key && prev.key && payload.key !== prev.key) return prev;
          setActive(true);
          setAttached(true);
          setDetachReason(null);
          setActivateError(null);
          setActiveTabView('terminal');
          return {
            ...prev,
            sessionId: payload.sessionId,
            status: payload.status,
            createdAt: payload.createdAt,
            workDir: payload.workDir
          };
        });
      }
    };

    chrome.runtime.onMessage.addListener(handleMessage);
    return () => chrome.runtime.onMessage.removeListener(handleMessage);
  }, [currentTab, activeTabView, termRef]);

  // An agent that exists but has no session in this daemon is one we simply
  // haven't attached to yet — usually because the daemon restarted underneath
  // it. Re-attaching on sight is what keeps that invisible: the agent is
  // already running, so activate reuses the herdr pane rather than starting
  // anything, and the user never sees a fresh-start flicker.
  useEffect(() => {
    if (pageStatus !== 'supported' || !active || attached) {
      if (attached) reattachSentRef.current = false;
      return;
    }
    if (!currentTab || !currentTab.url || reattachSentRef.current) return;

    // A terminal that died under us is not the same as one we never attached
    // to. Re-attaching on sight would race whatever killed it — and if the
    // attach is refused, we would land right back here and spin. The user
    // gets a visible state and a Reconnect button instead.
    if (detachReason) return;

    reattachSentRef.current = true;
    chrome.runtime.sendMessage({ type: 'ACTIVATE_BUTCHR', url: currentTab.url, tabId: currentTab.id });
  }, [pageStatus, active, attached, detachReason, currentTab?.id, currentTab?.url]);

  // Deliberate re-attach after a death we reported. Clearing the reason first
  // is what re-arms the automatic path if this attempt does not land.
  const handleReconnect = useCallback(() => {
    if (!currentTab || !currentTab.url) return;
    setDetachReason(null);
    setActivateError(null);
    reattachSentRef.current = false;
    chrome.runtime.sendMessage({ type: 'ACTIVATE_BUTCHR', url: currentTab.url, tabId: currentTab.id });
  }, [currentTab]);

  /**
   * Start the agent past a capacity refusal, deliberately.
   *
   * The daemon has always accepted this and records it with the figures at the
   * time; what was missing was any way to say it from the panel. A refusal
   * whose own advice ("pass override: true") cannot be followed from where it
   * is displayed is only half-visible.
   */
  const handleOverrideActivate = useCallback(() => {
    if (!currentTab || !currentTab.url) return;
    setActivateError(null);
    reattachSentRef.current = false;
    chrome.runtime.sendMessage({
      type: 'ACTIVATE_BUTCHR',
      url: currentTab.url,
      tabId: currentTab.id,
      override: true
    });
  }, [currentTab]);

  /**
   * Start the agent by standing down a lower-priority one, deliberately.
   *
   * Separate from the override above because they are different asks with
   * different victims. Override over-commits the machine and nobody else pays;
   * this ends another agent's turn mid-work. It is reachable only from the
   * refusal that named that agent, which is what makes the consent informed
   * rather than nominal — there is no way to preempt from this panel without
   * having been shown who.
   */
  const handlePreemptActivate = useCallback(() => {
    if (!currentTab || !currentTab.url) return;
    setActivateError(null);
    reattachSentRef.current = false;
    chrome.runtime.sendMessage({
      type: 'ACTIVATE_BUTCHR',
      url: currentTab.url,
      tabId: currentTab.id,
      preempt: true
    });
  }, [currentTab]);

  const dismissActivateError = useCallback(() => setActivateError(null), []);

  const handleToggle = (isChecked) => {
    setActivateError(null);
    if (!isChecked) {
      // Off means the agent ends, not just that we let go of it. Without a
      // session there is no id to deactivate by, but the agent is still there
      // — deactivate_by_key reaches the one that outlived the daemon.
      if (sessionData.sessionId) {
        chrome.runtime.sendMessage({ type: 'DEACTIVATE_BUTCHR', sessionId: sessionData.sessionId });
      } else if (sessionData.key) {
        chrome.runtime.sendMessage({
          type: 'DEACTIVATE_BUTCHR_BY_KEY',
          workspaceType: sessionData.type,
          key: sessionData.key
        });
      }
    } else if (currentTab) {
      chrome.runtime.sendMessage({ type: 'ACTIVATE_BUTCHR', url: currentTab.url, tabId: currentTab.id });
    }
  };

  const handleReset = () => {
    if (currentTab && confirm('Are you sure you want to reset this workspace? This will turn the agent off and permanently delete all files in the workspace directory.')) {
      chrome.runtime.sendMessage({ type: 'RESET_BUTCHR', url: currentTab.url });
      setActive(false);
      setAttached(false);
      reattachSentRef.current = false;
      setSessionData((prev) => ({ ...prev, sessionId: null }));
      if (termRef.current) {
        termRef.current.write('\r\n\x1b[31m[Workspace Reset]\x1b[0m\r\n');
      }
    }
  };

  return {
    pageStatus,
    statusError,
    supported: pageStatus === 'supported',
    active,
    attached,
    detachReason,
    activateError,
    sessionData,
    handleToggle,
    handleReset,
    handleReconnect,
    handleOverrideActivate,
    handlePreemptActivate,
    dismissActivateError,
    retryStatus
  };
}
