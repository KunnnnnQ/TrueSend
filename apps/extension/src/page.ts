import {collidingAddresses, collidingPairs, findAddresses, type Address} from "@truesend/engine";

const MARK_ATTRIBUTE = "data-truesend-marked";

/**
 * Attributes a real block explorer puts the full address in.
 *
 * Explorers do not print an address, they print the ends of one — Etherscan renders
 * `0x1E227979...a6F538FD5`, with a literal ellipsis — and keep the whole thing in attributes so the
 * copy button and the tooltip can find it. Measured on two real Etherscan pages, transaction list
 * and token transfers, **0 of 236 addresses were readable from text**. A scan that only reads text
 * finds nothing on the page where victims are actually poisoned, which is what this list fixes.
 *
 * Blockscout is the second explorer measured, and it shows less than Etherscan does — `0x79...41C0`,
 * two characters after the prefix and four at the end. There the full address is in `href`,
 * `data-hash` and an identicon's `alt`, and `data-hash` and `alt` are the only place the address
 * of an entry without a link is written at all.
 *
 * Deliberately a list rather than "every attribute": walking all attributes of all elements on a
 * page that re-scans itself on every mutation is the kind of cost that gets an extension removed.
 * These are the ones seen on real pages; `title`, `href` and `data-clipboard-text` are the
 * conventions other sites share.
 */
const ADDRESS_ATTRIBUTES = [
  "data-full-address",
  "data-clipboard-text",
  "data-highlight-target",
  "data-address",
  "data-hash",
  "data-bs-title",
  "data-original-title",
  "title",
  "alt",
  "href",
] as const;

/** Lets the browser do the filtering instead of visiting every element. */
const CARRIER_SELECTOR = [
  "[data-full-address]",
  "[data-clipboard-text]",
  "[data-highlight-target]",
  "[data-address]",
  "[data-hash]",
  'img[alt*="0x"]',
  '[data-bs-title*="0x"]',
  '[data-original-title*="0x"]',
  '[title*="0x"]',
  'a[href*="0x"]',
].join(",");

interface Carrier {
  address: Address;
  element: HTMLElement;
}

/**
 * Every address on the page, and the element each one was read from.
 *
 * Two kinds of source. Text nodes, walked one at a time rather than reading the subtree as one
 * string: flattening concatenates adjacent nodes with nothing between them, so a cell holding an
 * address followed by a cell reading "1 USDC" becomes `…0e931 USDC`, and the address is discarded
 * as part of a longer hex run — which is exactly what the transaction-hash guard in
 * `findAddresses` is for. And attributes, per the note on `ADDRESS_ATTRIBUTES`.
 */
function carriers(root: HTMLElement): Carrier[] {
  const found: Carrier[] = [];

  for (const node of textNodes(root)) {
    const element = node.parentElement;
    if (!element) continue;
    for (const match of findAddresses(node.nodeValue ?? "")) {
      found.push({address: match.address, element});
    }
  }

  for (const element of root.querySelectorAll<HTMLElement>(CARRIER_SELECTOR)) {
    if (element.closest("script, style, #truesend-overlay")) continue;
    for (const name of ADDRESS_ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value?.includes("0x")) continue;
      for (const match of findAddresses(value)) found.push({address: match.address, element});
    }
  }

  return found;
}

/** Every address currently on the page, however it is written there. */
export function addressesOnPage(root: HTMLElement = document.body): Set<Address> {
  return new Set(carriers(root).map((carrier) => carrier.address));
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
 * What an element looked like before it was marked.
 *
 * Restored verbatim, not reconstructed. This used to set `title` and later delete it, which on a
 * real explorer destroys the page's own tooltip — and Etherscan keeps the full address there — and
 * used to remove `style` properties by name, which discards any the page had set itself.
 */
const originals = new WeakMap<HTMLElement, {style: string | null; title: string | null}>();

/**
 * Mark colliding addresses where they sit.
 *
 * The point of doing this in place rather than in a panel: the planted address and the address it
 * imitates are usually adjacent rows in a transaction list, and seeing them outlined *next to each
 * other* is what makes the imitation obvious. A warning elsewhere on the screen asks the user to
 * hold two 42-character strings in their head and compare them — which is exactly the thing they
 * cannot do, and the reason the attack works at all.
 *
 * Marks the element the user is looking at. An address usually turns up in several elements at once
 * — a link, the span inside it, a copy button beside it — and outlining all of them would draw the
 * same box three times, so only the outermost element that has anything on screen is marked, and
 * an icon-only copy button is never the target.
 *
 * @returns how many elements were marked.
 */
export function markCollisions(root: HTMLElement = document.body): number {
  const all = carriers(root);
  const flagged = collidingAddresses(collidingPairs(new Set(all.map((carrier) => carrier.address))));
  if (flagged.size === 0) return 0;

  const candidates = new Set<HTMLElement>();
  for (const {address, element} of all) {
    if (!flagged.has(address)) continue;
    // Inside an element already marked, not just *being* one. Otherwise the inner elements this
    // pass filtered out as "not outermost" become outermost on the next pass, once their parent is
    // skipped for already being marked, and get a second outline nested inside the first.
    if (element.closest(`[${MARK_ATTRIBUTE}]`)) continue;
    if ((element.textContent ?? "").trim().length === 0) continue;
    candidates.add(element);
  }

  const targets = [...candidates].filter(
    (element) => ![...candidates].some((other) => other !== element && other.contains(element)),
  );

  for (const element of targets) {
    originals.set(element, {style: element.getAttribute("style"), title: element.getAttribute("title")});

    element.setAttribute(MARK_ATTRIBUTE, "");
    // `important` because the host page is not cooperating and may well be styling this element.
    element.style.setProperty("outline", "1px solid rgba(242, 85, 90, 0.75)", "important");
    element.style.setProperty("outline-offset", "2px");
    element.style.setProperty("border-radius", "3px");

    const note =
      "TrueSend: another address on this page shares the characters a wallet shows. " +
      "One of them is not what you think it is.";
    const own = element.getAttribute("title");
    // Appended, not substituted: the page's own tooltip may be the only place the full address is
    // written out, and the user should still be able to read it.
    element.title = own ? `${own}\n\n${note}` : note;
  }

  return targets.length;
}

/** Undo the marking, for a page that swapped its content underneath us. */
export function clearMarks(root: HTMLElement = document.body): void {
  for (const element of root.querySelectorAll<HTMLElement>(`[${MARK_ATTRIBUTE}]`)) {
    element.removeAttribute(MARK_ATTRIBUTE);

    const before = originals.get(element);
    originals.delete(element);

    // A mark from before this page's script reloaded has nothing saved. Better to remove what we
    // know we add than to leave a red outline on the page for good.
    if (!before) {
      element.style.removeProperty("outline");
      element.style.removeProperty("outline-offset");
      element.style.removeProperty("border-radius");
      continue;
    }

    if (before.style === null) element.removeAttribute("style");
    else element.setAttribute("style", before.style);

    if (before.title === null) element.removeAttribute("title");
    else element.setAttribute("title", before.title);
  }
}
