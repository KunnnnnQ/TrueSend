import {collidingAddresses, collidingPairs, findAddresses, type Address} from "@truesend/engine";

const MARK_ATTRIBUTE = "data-truesend-marked";

/**
 * Every address currently rendered on the page.
 *
 * Walks text nodes rather than reading the whole subtree as one string. Flattening a page
 * concatenates adjacent nodes with nothing between them, so a table cell holding an address
 * followed by a cell reading "1 USDC" becomes `…0e931 USDC` — and the address is then discarded
 * as part of a longer hex run, which is exactly what the transaction-hash guard in
 * `findAddresses` is supposed to do. Per-node text keeps each match bounded by the markup it
 * actually came from.
 */
export function addressesOnPage(root: HTMLElement = document.body): Set<Address> {
  const found = new Set<Address>();
  for (const text of textNodes(root)) {
    for (const match of findAddresses(text.nodeValue ?? "")) found.add(match.address);
  }
  return found;
}

/** Text nodes under `root` that could contain an address, skipping our own overlay. */
function textNodes(root: HTMLElement): Text[] {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest("script, style, #truesend-overlay")) {
        return NodeFilter.FILTER_REJECT;
      }
      return node.nodeValue?.includes("0x") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const out: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) out.push(node as Text);
  return out;
}

/**
 * Mark colliding addresses where they sit.
 *
 * The point of doing this in place rather than in a panel: the planted address and the address it
 * imitates are usually adjacent rows in a transaction list, and seeing them outlined *next to each
 * other* is what makes the imitation obvious. A warning elsewhere on the screen asks the user to
 * hold two 42-character strings in their head and compare them — which is exactly the thing they
 * cannot do, and the reason the attack works at all.
 *
 * @returns how many elements were marked.
 */
export function markCollisions(root: HTMLElement = document.body): number {
  const flagged = collidingAddresses(collidingPairs(addressesOnPage(root)));
  if (flagged.size === 0) return 0;

  const targets: HTMLElement[] = [];
  for (const node of textNodes(root)) {
    const parent = node.parentElement;
    if (!parent || parent.hasAttribute(MARK_ATTRIBUTE)) continue;
    if (findAddresses(node.nodeValue ?? "").some((match) => flagged.has(match.address))) {
      targets.push(parent);
    }
  }

  for (const element of targets) {
    element.setAttribute(MARK_ATTRIBUTE, "");
    // `important` because the host page is not cooperating and may well be styling this element.
    element.style.setProperty("outline", "1px solid rgba(242, 85, 90, 0.75)", "important");
    element.style.setProperty("outline-offset", "2px");
    element.style.setProperty("border-radius", "3px");
    element.title =
      "TrueSend: another address on this page shares the characters a wallet shows. " +
      "One of them is not what you think it is.";
  }

  return targets.length;
}

/** Undo the marking, for a page that swapped its content underneath us. */
export function clearMarks(root: HTMLElement = document.body): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[${MARK_ATTRIBUTE}]`)) {
    element.removeAttribute(MARK_ATTRIBUTE);
    element.style.removeProperty("outline");
    element.style.removeProperty("outline-offset");
    element.style.removeProperty("border-radius");
    element.removeAttribute("title");
  }
}
