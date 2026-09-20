import {beforeEach, describe, expect, it} from "vitest";

import {addressesOnPage, clearMarks, markCollisions} from "../src/page.js";

const ALICE = "0xab58c49b70d5e2f1a0c9f3d7e6b4a2c8d1f00e93";
/** Ground out to share Alice's first six and last four characters. */
const POISONED = "0xab58c41122334455667788990011223344ff0e93";
const BOB = "0x742d35cc6634c0532925a3b844bc454e4438f44e";

/** A transaction list, which is the shape this runs against in practice. */
function history(...addresses: string[]): void {
  document.body.innerHTML = `
    <table><tbody>
      ${addresses.map((a) => `<tr><td>3 May</td><td class="addr">${a}</td><td>1 USDC</td></tr>`).join("")}
    </tbody></table>
  `;
}

const marked = () => document.querySelectorAll("[data-truesend-marked]");

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("addressesOnPage", () => {
  it("finds the addresses in a rendered list", () => {
    history(ALICE, BOB);
    expect([...addressesOnPage()].sort()).toEqual([ALICE, BOB].sort());
  });

  it("finds nothing on a page with no addresses", () => {
    document.body.innerHTML = "<p>no addresses here</p>";
    expect(addressesOnPage().size).toBe(0);
  });
});

describe("markCollisions", () => {
  /**
   * The behaviour the whole page scan exists for. The planted address and the one it imitates are
   * adjacent rows, and outlining them *where they sit* is what makes the imitation visible —
   * a warning elsewhere would ask the user to compare two 42-character strings from memory, which
   * is the thing they cannot do and the reason the attack works.
   */
  it("marks both halves of a colliding pair and nothing else", () => {
    history(ALICE, BOB, POISONED);

    expect(markCollisions()).toBe(2);

    const texts = [...marked()].map((element) => element.textContent);
    expect(texts).toContain(ALICE);
    expect(texts).toContain(POISONED);
    expect(texts).not.toContain(BOB);
  });

  it("marks nothing on a page of unrelated addresses", () => {
    history(ALICE, BOB);

    expect(markCollisions()).toBe(0);
    expect(marked()).toHaveLength(0);
  });

  it("leaves a visible outline rather than only an attribute", () => {
    history(ALICE, POISONED);
    markCollisions();

    const element = marked()[0] as HTMLElement;
    expect(element.style.outline).toContain("242, 85, 90");
    expect(element.title).toContain("TrueSend");
  });

  it("does not mark the same element twice when run again", () => {
    history(ALICE, POISONED);

    expect(markCollisions()).toBe(2);
    expect(markCollisions()).toBe(0);
    expect(marked()).toHaveLength(2);
  });

  /** Single-page apps replace their content, so the marks have to be removable. */
  it("clears cleanly, leaving no styling behind", () => {
    history(ALICE, POISONED);
    markCollisions();
    clearMarks();

    expect(marked()).toHaveLength(0);
    const cell = document.querySelector(".addr") as HTMLElement;
    expect(cell.style.outline).toBe("");
    expect(cell.title).toBe("");
    expect(cell.getAttribute("style")).toBeFalsy();
  });

  it("can mark again after clearing, for a page that swapped its rows", () => {
    history(ALICE, POISONED);
    markCollisions();
    clearMarks();

    expect(markCollisions()).toBe(2);
  });

  it("ignores an address that appears twice as a collision with itself", () => {
    history(ALICE, ALICE);
    expect(markCollisions()).toBe(0);
  });
});
