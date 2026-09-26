import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";

import {beforeEach, describe, expect, it} from "vitest";

import {addressesOnPage, clearMarks, markCollisions} from "../src/page.js";

/**
 * The same scan against a second explorer, because one real page is a sample of one.
 *
 * Etherscan keeps the full address in `data-full-address`. Blockscout does not: it shows
 * `0x79...41C0` — two characters after the prefix and four at the end, less than half of what
 * Etherscan shows — and keeps the whole address in `href`, `data-hash` and an identicon's `alt`.
 * Neither is in text. A scan tuned to the first explorer's attribute would have passed every test
 * in `etherscan.test.ts` and found nothing here.
 *
 * The fixture is the live DOM of the same account that fixture came from, a week into being
 * poisoned, rendered by Blockscout's own script. See the comment at its top.
 */
const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(join(here, "fixtures", "blockscout-poisoned-token-transfers.html"), "utf8");

/** Three different attacker addresses, each sharing four leading and four trailing characters. */
const PLANTED_A = "0x7916cdb1c89ab07f0c4261c8cbf9c88aae1c41c0";
const PLANTED_B = "0x791649981ed71e76857ea79c882d48a3379b41c0";
const PLANTED_C = "0x791685bbd7ec45d566ccb2d8d96c7ef3bdd541c0";
const VICTIM = "0x0bcf1545b4fee2ae742216eaf52f3766f7dc8675";
const REAL_PAYMENT = "0x28582509b138d2722bcaed3701140f2fd270bf63";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";

beforeEach(() => {
  document.body.innerHTML = FIXTURE;
});

const marked = () => [...document.querySelectorAll<HTMLElement>("[data-truesend-marked]")];

describe("addressesOnPage, on a real Blockscout page", () => {
  it("reads the full address from where Blockscout keeps it, which is not the text", () => {
    const found = addressesOnPage();

    for (const address of [PLANTED_A, PLANTED_B, PLANTED_C, VICTIM, REAL_PAYMENT, USDT]) {
      expect(found.has(address as never), `missed ${address}`).toBe(true);
    }
  });

  /**
   * Blockscout writes `Identicon for 0x…}` — a stray brace straight after the address, in the
   * page's own markup. An address followed by punctuation is still an address; only a longer run
   * of hex would make it something else.
   */
  it("reads an address that the page follows with punctuation", () => {
    document.body.innerHTML = `<img alt="Identicon for ${VICTIM}}">`;
    expect(addressesOnPage().has(VICTIM as never)).toBe(true);
  });
});

describe("markCollisions, on a real Blockscout page", () => {
  it("outlines all three attacker addresses, which collide with one another", () => {
    expect(markCollisions()).toBeGreaterThan(0);

    const html = marked().map((el) => el.outerHTML.toLowerCase());
    for (const planted of [PLANTED_A, PLANTED_B, PLANTED_C]) {
      expect(html.some((h) => h.includes(planted)), `did not outline ${planted}`).toBe(true);
    }
  });

  it("leaves the victim, the payment it actually made, and the token links alone", () => {
    markCollisions();

    for (const element of marked()) {
      const html = element.outerHTML.toLowerCase();
      const only = (a: string) =>
        html.includes(a) && ![PLANTED_A, PLANTED_B, PLANTED_C].some((p) => html.includes(p));
      expect(only(VICTIM), "outlined the victim's own address").toBe(false);
      expect(only(REAL_PAYMENT), "outlined an address that collides with nothing").toBe(false);
      expect(only(USDT), "outlined a token contract").toBe(false);
    }
  });

  /**
   * The reason this attack works, as a test. Two of the outlined addresses are different, and the
   * page renders them as the same nine characters. Nothing about what is on screen tells them
   * apart, so nothing the user can read is a basis for trusting either.
   */
  it("outlines addresses that the page renders as identical text", () => {
    markCollisions();

    const byShownText = new Map<string, Set<string>>();
    for (const element of marked()) {
      const shown = (element.textContent ?? "").trim();
      const href = element.closest("a")?.getAttribute("href") ?? element.querySelector("a")?.getAttribute("href") ?? "";
      const address = href.split("/address/")[1]?.toLowerCase();
      if (!address) continue;
      byShownText.set(shown, (byShownText.get(shown) ?? new Set()).add(address));
    }

    const ambiguous = [...byShownText.entries()].filter(([, addresses]) => addresses.size > 1);
    expect(ambiguous.length, "no two different addresses rendered identically").toBeGreaterThan(0);
  });

  it("does not outline the same thing twice, and clears back to the original page", () => {
    const original = document.body.innerHTML;
    const first = markCollisions();

    expect(markCollisions()).toBe(0);
    expect(marked().length).toBe(first);

    clearMarks();
    expect(marked().length).toBe(0);
    expect(document.body.innerHTML).toBe(original);
  });
});
