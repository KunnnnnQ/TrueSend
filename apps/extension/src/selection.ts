/**
 * What the user has just selected, wherever the browser keeps it.
 *
 * Etherscan's copy button does not put text on the clipboard directly. It creates a hidden
 * `<textarea>`, fills it with the address, selects it and calls `execCommand("copy")`; the `copy`
 * event that follows fires with that textarea focused. Measured against the live page with a real
 * click: the event fires (twice, in fact), and in Chromium `getSelection().toString()` returns the
 * full address at that moment.
 *
 * That is a browser behaviour, not a guarantee. A selection inside an `<input>` or `<textarea>`
 * lives in the control, not in the document's Selection, and not every engine exposes it through
 * `getSelection()`. Asking the control directly costs a few lines and works everywhere, so the
 * guard does not quietly go blind on the one browser where it matters to somebody.
 */
export function selectedText(doc: Document = document): string {
  const fromSelection = doc.getSelection()?.toString() ?? "";
  if (fromSelection) return fromSelection;

  const focused = doc.activeElement;
  if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement) {
    try {
      return focused.value.slice(focused.selectionStart ?? 0, focused.selectionEnd ?? 0);
    } catch {
      // `selectionStart` throws on input types that have no text selection (number, email…).
      return "";
    }
  }

  return "";
}
