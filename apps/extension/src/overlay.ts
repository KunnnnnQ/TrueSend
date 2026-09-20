import {identiconSvg} from "@truesend/engine";

import type {GuardVerdict} from "./guard.js";

const HOST_ID = "truesend-overlay";

/**
 * The card the extension shows over whatever page the user is on.
 *
 * Rendered inside a shadow root with every property reset, because it has to look the same on a
 * block explorer, a wallet, and a page that sets `* { font-size: 3em }`. A warning that inherits
 * the host page's styling is a warning the host page can hide.
 *
 * Built with DOM calls rather than `innerHTML`. The strings going in are addresses and dictionary
 * words, so nothing here is attacker-controlled in practice — but a content script that assembles
 * markup from page data is one refactor away from being an injection, and this one runs on every
 * site.
 */
const STYLE = `
:host { all: initial; }
.card {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  width: 340px;
  max-width: calc(100vw - 32px);
  box-sizing: border-box;
  padding: 14px;
  border-radius: 12px;
  border: 1px solid #2b3549;
  background: #0b0f18;
  color: #e8ecf4;
  font: 13px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  animation: rise 140ms ease-out;
}
.card.danger { border-color: rgba(242, 85, 90, 0.55); }
.card.caution { border-color: rgba(232, 168, 56, 0.5); }

@keyframes rise { from { opacity: 0; transform: translateY(6px); } }
@media (prefers-reduced-motion: reduce) { .card { animation: none; } }

.head { display: flex; align-items: flex-start; gap: 10px; }
.title { font-weight: 600; flex: 1; min-width: 0; }
.title.danger { color: #f2555a; }
.title.caution { color: #e8a838; }
.close {
  all: unset;
  cursor: pointer;
  color: #5b6679;
  padding: 0 4px;
  line-height: 1;
  font-size: 16px;
}
.close:hover { color: #e8ecf4; }

.row { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.mono {
  font-family: ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  font-size: 12px;
}
.hex { color: #8b97ad; }
.phrase { color: #e8ecf4; letter-spacing: 0.01em; }
.detail { margin-top: 10px; color: #8b97ad; font-size: 12px; }

.compare { margin-top: 12px; border-top: 1px solid #1e2636; padding-top: 10px; }
.compare-label { color: #5b6679; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; }
.compare .row { margin-top: 8px; }
.tag { font-size: 11px; color: #5b6679; }
`;

let hideTimer: ReturnType<typeof setTimeout> | undefined;

function ensureHost(): ShadowRoot {
  const existing = document.getElementById(HOST_ID);
  if (existing?.shadowRoot) return existing.shadowRoot;

  const host = document.createElement("div");
  host.id = HOST_ID;
  const shadow = host.attachShadow({mode: "open"});

  const style = document.createElement("style");
  style.textContent = STYLE;
  shadow.append(style);

  document.documentElement.append(host);
  return shadow;
}

function addressRow(
  shadow: Document,
  fingerprintSvg: string,
  short: string,
  phrase: string,
  tag?: string,
): HTMLElement {
  const row = shadow.createElement("div");
  row.className = "row";

  const icon = shadow.createElement("span");
  // The only markup assembled from a string, and it comes from our own generator rather than
  // from the page.
  icon.innerHTML = fingerprintSvg;
  row.append(icon);

  const text = shadow.createElement("div");
  const hex = shadow.createElement("div");
  hex.className = "mono hex";
  hex.textContent = short;
  const words = shadow.createElement("div");
  words.className = "mono phrase";
  words.textContent = phrase;
  text.append(hex, words);
  row.append(text);

  if (tag) {
    const label = shadow.createElement("span");
    label.className = "tag";
    label.textContent = tag;
    row.append(label);
  }

  return row;
}

export function showVerdict(verdict: GuardVerdict, autoHideMs = 9_000): void {
  const shadow = ensureHost();
  shadow.querySelector(".card")?.remove();
  if (hideTimer) clearTimeout(hideTimer);

  const card = document.createElement("div");
  card.className = `card ${verdict.level}`;
  card.setAttribute("role", verdict.level === "danger" ? "alert" : "status");

  const head = document.createElement("div");
  head.className = "head";

  const title = document.createElement("div");
  title.className = `title ${verdict.level}`;
  title.textContent = verdict.headline;

  const close = document.createElement("button");
  close.className = "close";
  close.textContent = "×";
  close.setAttribute("aria-label", "Dismiss");
  close.addEventListener("click", () => hide());

  head.append(title, close);
  card.append(head);

  card.append(
    addressRow(document, identiconSvg(verdict.fingerprint, 32), verdict.fingerprint.short, verdict.fingerprint.phrase),
  );

  if (verdict.detail) {
    const detail = document.createElement("p");
    detail.className = "detail";
    detail.textContent = verdict.detail;
    card.append(detail);
  }

  if (verdict.lookalike) {
    const compare = document.createElement("div");
    compare.className = "compare";

    const label = document.createElement("div");
    label.className = "compare-label";
    label.textContent =
      verdict.lookalike.source === "saved" ? "The one you saved" : "The other one on this page";
    compare.append(label);

    compare.append(
      addressRow(
        document,
        identiconSvg(verdict.lookalike.fingerprint, 32),
        verdict.lookalike.fingerprint.short,
        verdict.lookalike.fingerprint.phrase,
        verdict.lookalike.label,
      ),
    );

    card.append(compare);
  }

  shadow.append(card);

  // A danger card stays until it is dismissed. Something that disappears on its own is something
  // the user can miss while they are looking at their wallet rather than at the corner.
  if (verdict.level !== "danger") {
    hideTimer = setTimeout(hide, autoHideMs);
  }
}

export function hide(): void {
  if (hideTimer) clearTimeout(hideTimer);
  document.getElementById(HOST_ID)?.remove();
}
