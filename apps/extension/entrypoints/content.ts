import {findAddresses} from "@truesend/engine";

import {judge, type SavedAddress} from "../src/guard.js";
import {hide, showVerdict} from "../src/overlay.js";
import {addressesOnPage, clearMarks, markCollisions} from "../src/page.js";

/**
 * The guard, running on every page.
 *
 * Three moments, in order of how much they matter:
 *
 *   1. **Paste.** The address is going into a field that is about to send money. This is the last
 *      point at which anything can be said.
 *   2. **Copy.** The user has chosen an address from somewhere. Showing its fingerprint here is
 *      what gives them something to compare against later.
 *   3. **Page load.** Two addresses on one screen that a wallet would render identically. Nobody
 *      has done anything yet, and it is already worth saying.
 *
 * Everything is local. No request leaves the browser, which is why the extension asks for no
 * permission beyond storage — and why it can answer inside the gap between a copy and a paste.
 *
 * This file is glue on purpose: the deciding is in `src/guard.ts`, the drawing is in
 * `src/overlay.ts`, and the page work is in `src/page.ts`, all of which are testable without a
 * browser extension around them.
 */
export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_idle",

  async main() {
    const saved = await loadSaved();

    markCollisions();

    document.addEventListener("copy", () => {
      // The selection, not the clipboard. Reading what the user just highlighted needs no
      // clipboard permission at all, and the extension never sees anything they did not just act
      // on.
      const [match] = findAddresses(document.getSelection()?.toString() ?? "");
      if (!match) return;

      showVerdict(judge({address: match.address, onPage: addressesOnPage(), saved}));
    });

    document.addEventListener(
      "paste",
      (event) => {
        const [match] = findAddresses(event.clipboardData?.getData("text") ?? "");
        if (!match) return;

        const verdict = judge({address: match.address, onPage: addressesOnPage(), saved});
        // A clean address gets nothing on paste. The user is mid-task, and a card that appears
        // every time anyone pastes anything is a card that gets ignored when it matters.
        if (verdict.level !== "neutral") showVerdict(verdict);
      },
      true,
    );

    // Single-page apps swap their content without a navigation, so the page scan has to keep up.
    const observer = new MutationObserver(
      debounce(() => {
        clearMarks();
        markCollisions();
      }, 600),
    );
    observer.observe(document.body, {childList: true, subtree: true, characterData: true});

    window.addEventListener("pagehide", () => {
      observer.disconnect();
      hide();
    });
  },
});

async function loadSaved(): Promise<SavedAddress[]> {
  try {
    const stored = await browser.storage.local.get("saved");
    return Array.isArray(stored["saved"]) ? (stored["saved"] as SavedAddress[]) : [];
  } catch {
    // Storage can be unavailable in a sandboxed frame. The page-collision check still works
    // without it, and that is the signal that needs nothing remembered.
    return [];
  }
}

function debounce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
}
