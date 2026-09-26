import {beforeEach, describe, expect, it} from "vitest";

import {selectedText} from "../src/selection.js";

const ADDRESS = "0x28582509B138d2722bcAED3701140F2Fd270bf63";

beforeEach(() => {
  document.body.innerHTML = "";
});

/**
 * The shape of Etherscan's copy button, observed with a real click on the live page: a hidden
 * textarea holding the address, selected, focused, then copied.
 */
describe("selectedText", () => {
  it("reads a selection inside a textarea, which is how Etherscan's copy button works", () => {
    const textarea = document.createElement("textarea");
    textarea.value = ADDRESS;
    document.body.append(textarea);
    textarea.focus();
    textarea.select();

    expect(selectedText()).toBe(ADDRESS);
  });

  it("reads only the selected part of a control, not everything in it", () => {
    const input = document.createElement("input");
    input.value = `send to ${ADDRESS} now`;
    document.body.append(input);
    input.focus();
    input.setSelectionRange(8, 8 + ADDRESS.length);

    expect(selectedText()).toBe(ADDRESS);
  });

  it("reads an ordinary selection of page text", () => {
    document.body.innerHTML = `<p id="p">${ADDRESS}</p>`;
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("p")!);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(selectedText()).toBe(ADDRESS);
  });

  it("returns nothing when nothing is selected", () => {
    document.body.innerHTML = "<p>nothing highlighted</p>";
    document.getSelection()?.removeAllRanges();

    expect(selectedText()).toBe("");
  });

  it("does not throw on an input type that has no text selection", () => {
    const input = document.createElement("input");
    input.type = "number";
    document.body.append(input);
    input.focus();

    expect(() => selectedText()).not.toThrow();
  });
});
