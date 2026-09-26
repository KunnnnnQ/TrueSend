import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {beforeEach, describe, expect, it} from "vitest";

import {addressesOnPage, clearMarks, markCollisions} from "../src/page.js";

/**
 * The page scan, run against markup that was not written by the person who wrote the scan.
 *
 * Every other test in this package builds its transaction list out of `<td>0xabc…</td>` — the full
 * address as text. That is a picture of what a transaction list would look like if you had never
 * opened one. Etherscan renders `0x1E227979...a6F538FD5`, with a literal ellipsis, and puts the full
 * address in attributes. Measured on two real pages before this file existed:
 *
 *     transaction list   0 of  92 addresses readable from text
 *     token transfers    0 of 144 addresses readable from text
 *
 * so the scan that the README describes — planted address and the one it imitates, outlined where
 * they sit — found nothing on the one page victims are actually looking at. The old tests were
 * green throughout, because they tested the scan against the assumption it was built on.
 *
 * The fixture is a handful of rows copied verbatim from a real account that was being poisoned at
 * the time of capture; see the comment at its top.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, "fixtures", "etherscan-poisoned-token-transfers.html"), "utf8");

/**
 * The six addresses on that page.
 *
 * LOOKALIKE shares the payee's first four and last four characters and nothing else, which is the
 * bare minimum a wallet would render identically. Etherscan has already labelled it
 * Fake_Phishing7859477, so the page shows that name rather than hex. OTHER_PLANTER is a different
 * planter's address, shown as truncated hex, and collides with none of the others.
 */
const VICTIM = "0x0bcf1545b4fee2ae742216eaf52f3766f7dc8675";
const REAL_PAYEE = "0x7916de5ef2389e8ed627a9a3e92ea5bf807c41c0";
const LOOKALIKE = "0x791685bbd7ec45d566ccb2d8d96c7ef3bdd541c0";
const OTHER_PLANTER = "0x799e1507d296e95b643e8d149c03c2409b7c41c0";
const ORDINARY = "0x28582509b138d2722bcaed3701140f2fd270bf63";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const ALL_SIX = [VICTIM, REAL_PAYEE, LOOKALIKE, OTHER_PLANTER, ORDINARY, USDT].sort();

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
});

/** Everything the page tells us about which address an element stands for, lowercased. */
function addressesOf(element: Element): string {
  return element.outerHTML.toLowerCase();
}

describe("addressesOnPage, on a real Etherscan page", () => {
  it("reads addresses the page only ever shows truncated", () => {
    expect([...addressesOnPage()].sort()).toEqual(ALL_SIX);
  });

  it("counts an address once, however many attributes carry it", () => {
    // Each address here sits in data-full-address, title, data-bs-title, data-highlight-target and
    // href at once, and in a copy button's data-clipboard-text besides. It is one address.
    const found = [...addressesOnPage()];
    expect(new Set(found).size).toBe(found.length);
  });
});

describe("markCollisions, on a real Etherscan page", () => {
  /** The feature, working on the page it was written for. */
  it("outlines the payee this account really pays and the lookalike of it", () => {
    expect(markCollisions()).toBeGreaterThan(0);

    const marked = [...document.querySelectorAll("[data-truesend-marked]")].map(addressesOf);

    expect(marked.some((html) => html.includes(REAL_PAYEE)), "the real payee was not outlined").toBe(true);
    expect(marked.some((html) => html.includes(LOOKALIKE)), "the lookalike was not outlined").toBe(true);
  });

  it("outlines nothing else on the page", () => {
    markCollisions();

    for (const element of document.querySelectorAll("[data-truesend-marked]")) {
      const html = addressesOf(element);
      for (const innocent of [VICTIM, OTHER_PLANTER, ORDINARY, USDT]) {
        // An element may legitimately contain a colliding address; it must not be marked *because
        // of* one that collides with nothing, which shows up as it carrying only that address.
        const carriesOnlyInnocent =
          html.includes(innocent) && !html.includes(REAL_PAYEE) && !html.includes(LOOKALIKE);
        expect(carriesOnlyInnocent, `outlined an address that collides with nothing: ${innocent}`).toBe(false);
      }
    }
  });

  it("outlines what the user is shown, so the outline is somewhere they can see", () => {
    markCollisions();

    for (const element of document.querySelectorAll("[data-truesend-marked]")) {
      expect((element.textContent ?? "").trim().length, "marked an element with nothing on screen").toBeGreaterThan(0);
    }
  });

  it("does not outline the same element twice when it runs again", () => {
    const first = markCollisions();
    const second = markCollisions();

    expect(second).toBe(0);
    expect(document.querySelectorAll("[data-truesend-marked]").length).toBe(first);
  });

  it("clears cleanly, leaving the page as it found it", () => {
    const before = document.body.innerHTML;
    markCollisions();
    clearMarks();

    expect(document.querySelectorAll("[data-truesend-marked]").length).toBe(0);
    expect(document.body.innerHTML).toBe(before);
  });
});
