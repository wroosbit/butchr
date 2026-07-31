// Selection and clipboard helpers for the xterm pane.
//
// A full-screen TUI turns on mouse tracking, and from that moment xterm.js
// forwards every mouse event to the program instead of selecting text — which
// is why drag-select silently does nothing in a herdr pane. xterm ships one
// escape hatch for this: a modifier that forces native selection anyway. We do
// not get to choose which modifier. SelectionService.shouldForceSelection reads
// shiftKey everywhere except macOS, where it reads altKey and only when
// macOptionClickForcesSelection is enabled.

const IS_MAC = /mac/i.test(
  globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || ''
);

export const SELECT_MODIFIER_LABEL = IS_MAC ? 'Option' : 'Shift';
export const SELECT_MODIFIER_SYMBOL = IS_MAC ? '⌥' : '⇧';

/**
 * Whether this mouse event carries the modifier xterm treats as "select, do not
 * report". Mirrors shouldForceSelection so we stay in step with what xterm just
 * decided about the same event.
 */
export function forcesSelection(event) {
  return IS_MAC ? event.altKey : event.shiftKey;
}

/**
 * Writes text to the system clipboard, reporting whether it landed.
 *
 * The async clipboard API is the happy path but rejects whenever the document
 * has lost focus, which a side panel does the moment the user clicks back into
 * the page. execCommand only needs a selection inside this document, so it
 * still works there — worth keeping as a fallback even though it is deprecated.
 */
export async function copyToClipboard(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return copyViaExecCommand(text);
  }
}

function copyViaExecCommand(text) {
  const staging = document.createElement('textarea');
  staging.value = text;
  staging.setAttribute('readonly', '');
  // Off-screen rather than hidden: an unrendered textarea cannot be selected,
  // and without a selection execCommand('copy') has nothing to copy.
  staging.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
  document.body.appendChild(staging);

  const previouslyFocused = document.activeElement;
  staging.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  staging.remove();
  // Hand focus back, or the next keystroke goes nowhere instead of to the PTY.
  previouslyFocused?.focus?.();
  return copied;
}
