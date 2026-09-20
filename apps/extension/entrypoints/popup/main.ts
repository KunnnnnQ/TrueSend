import {
  checkAddressFormat,
  fingerprint,
  identiconSvg,
  normalizeAddress,
  type Address,
} from "@truesend/engine";

import type {SavedAddress} from "../../src/guard.js";

import "./style.css";

const form = document.getElementById("add") as HTMLFormElement;
const addressInput = document.getElementById("address") as HTMLInputElement;
const labelInput = document.getElementById("label") as HTMLInputElement;
const errorLine = document.getElementById("error") as HTMLParagraphElement;
const list = document.getElementById("list") as HTMLUListElement;

async function load(): Promise<SavedAddress[]> {
  const stored = await browser.storage.local.get("saved");
  return Array.isArray(stored["saved"]) ? (stored["saved"] as SavedAddress[]) : [];
}

async function save(entries: SavedAddress[]): Promise<void> {
  await browser.storage.local.set({saved: entries});
}

function showError(message: string | undefined): void {
  errorLine.textContent = message ?? "";
  errorLine.hidden = !message;
}

function render(entries: SavedAddress[]): void {
  list.replaceChildren();

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent =
      "Nothing saved yet. Add the addresses you pay regularly and anything imitating them gets " +
      "flagged on sight.";
    list.append(empty);
    return;
  }

  for (const entry of entries) {
    const print = fingerprint(entry.address);

    const item = document.createElement("li");

    const icon = document.createElement("span");
    icon.innerHTML = identiconSvg(print, 28);

    const who = document.createElement("div");
    who.className = "who";
    if (entry.label) {
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = entry.label;
      who.append(name);
    }
    const hex = document.createElement("div");
    hex.className = "hex";
    hex.textContent = print.short;
    const phrase = document.createElement("div");
    phrase.className = "phrase";
    phrase.textContent = print.phrase;
    who.append(hex, phrase);

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${entry.label ?? print.short}`);
    remove.addEventListener("click", async () => {
      const next = (await load()).filter((candidate) => candidate.address !== entry.address);
      await save(next);
      render(next);
    });

    item.append(icon, who, remove);
    list.append(item);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(undefined);

  const raw = addressInput.value.trim();
  const format = checkAddressFormat(raw);

  if (format === "not-an-address") {
    showError("That is not a 20-byte hex address.");
    return;
  }

  // Saving an address whose checksum is broken would be saving the wrong address as the
  // reference every future comparison is made against, which is worse than not saving one.
  if (format === "bad-checksum") {
    showError(
      "The checksum on that address does not match — it has been altered or mistyped. Ask for " +
        "it again rather than saving it.",
    );
    return;
  }

  const address = normalizeAddress(raw) as Address;
  const entries = await load();
  if (entries.some((entry) => entry.address === address)) {
    showError("Already saved.");
    return;
  }

  const label = labelInput.value.trim();
  const next = [...entries, {address, ...(label ? {label} : {})}];
  await save(next);
  render(next);

  form.reset();
  addressInput.focus();
});

render(await load());
