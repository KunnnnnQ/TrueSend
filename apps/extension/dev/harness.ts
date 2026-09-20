/**
 * A page to look at the guard on.
 *
 * A Chrome extension cannot be loaded into every environment its behaviour needs checking in, and
 * "it compiled" is not a verification for something whose entire output is a visual warning. This
 * mounts the same `guard`, `overlay` and `page` modules the content script uses onto an ordinary
 * page, so the card and the in-place marking can actually be seen and driven.
 *
 * Not shipped: `wxt build` only takes `entrypoints/`.
 */
import {judge} from "../src/guard.js";
import {showVerdict} from "../src/overlay.js";
import {addressesOnPage, clearMarks, markCollisions} from "../src/page.js";

const saved = [{address: "0xab58c49b70d5e2f1a0c9f3d7e6b4a2c8d1f00e93" as const, label: "Alice"}];

function judgeFrom(input: HTMLInputElement, withSaved: boolean) {
  try {
    showVerdict(
      judge({
        address: input.value.trim(),
        onPage: addressesOnPage(),
        ...(withSaved ? {saved} : {}),
      }),
    );
  } catch (error) {
    // eslint-disable-next-line no-alert
    alert(error instanceof Error ? error.message : String(error));
  }
}

const field = document.getElementById("candidate") as HTMLInputElement;

document.getElementById("judge")!.addEventListener("click", () => judgeFrom(field, false));
document.getElementById("judge-saved")!.addEventListener("click", () => judgeFrom(field, true));
document.getElementById("mark")!.addEventListener("click", () => {
  clearMarks();
  const marked = markCollisions();
  document.getElementById("marked")!.textContent =
    marked === 0 ? "no collisions found" : `${marked} element(s) marked`;
});
document.getElementById("clear")!.addEventListener("click", () => {
  clearMarks();
  document.getElementById("marked")!.textContent = "";
});

// The real trigger, so copy behaves here exactly as it does on a live page.
document.addEventListener("copy", () => {
  const selection = document.getSelection()?.toString() ?? "";
  const match = selection.match(/0x[0-9a-fA-F]{40}/);
  if (match) showVerdict(judge({address: match[0], onPage: addressesOnPage(), saved}));
});
