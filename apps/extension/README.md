# Browser extension

Every address you copy gets four words. Two addresses on one page that a wallet would render
identically get outlined where they sit.

```bash
corepack pnpm --filter @truesend/extension dev     # loads into a dev browser
corepack pnpm --filter @truesend/extension build   # .output/chrome-mv3
```

## The part worth looking at

Most of this project needs history to say anything useful. The extension has a signal that needs
nothing at all:

> When someone is reading their own transaction list, the planted address and the address it
> imitates are **both on the screen**. Two entries that a wallet would render identically is a
> fact about what is in front of the user right now — not a heuristic, not an inference about
> intent, and not something that needs a server, a history scan or a network call.

So the extension outlines both, in place, in the list. That placement is the whole point: the two
rows are usually adjacent, and seeing them marked *next to each other* is what makes the
imitation visible. A warning in a panel somewhere else would ask the user to hold two
42-character strings in their head and compare them — which is precisely the thing they cannot
do, and the reason the attack works at all.

## Three moments

| | |
| --- | --- |
| **Paste** | The address is going into a field that is about to send money. The last point at which anything can be said. A clean address gets nothing: a card that appears every time anyone pastes anything is a card that gets ignored when it matters. |
| **Copy** | The user has chosen an address from somewhere. Showing its fingerprint here is what gives them something to compare against later. |
| **Page load** | The collision scan above. Nobody has done anything yet, and it is already worth saying. |

What it says, strongest first:

1. **"This address has been altered"** — its capitalisation disagrees with its own checksum, so a
   character changed between the sender and the screen. The one signal in this whole project that
   costs nothing and has no false positives.
2. **"This is not Alice"** — it imitates an address in the saved list. Not a score; a statement of
   who it is not.
3. **"Two addresses on this page look the same"** — the collision, with both fingerprints side by
   side.
4. Otherwise, the four words, and a reminder to check them against what the recipient said.

## Permissions

`storage`, and host access to read the page. That is all, and it is deliberate:

- **The clipboard is never read.** The copy handler reads the user's *selection* through the
  page's own `copy` event, so the extension only ever sees something the user just acted on — not
  whatever happens to be on the clipboard from another application.
- **Nothing leaves the browser.** No request, no telemetry, no risk API by default. That is also
  why the guard can answer inside the gap between a copy and a paste: every decision is a string
  comparison over data the page already handed it.
- The saved address list lives in `storage.local` and is never synced.

## Layout

```
entrypoints/content.ts   glue: three listeners and a MutationObserver
entrypoints/popup/       the saved address list
src/guard.ts             decides. Pure, no DOM, no clock — 14 tests
src/page.ts              finds and marks addresses in a document — 9 synthetic tests, 13 on real pages
src/selection.ts         what the user just selected, including inside a form control — 5 tests
src/overlay.ts           draws the card into a shadow root
test/fixtures/           markup captured from real Etherscan and Blockscout pages, unedited
dev/harness.html         the same modules on a hand-written page (synthetic — see below)
```

The entrypoint is glue on purpose. Deciding, drawing and page work are separate modules so they
can be tested and looked at without an extension around them.

## Looking at it

A Chrome extension cannot be loaded everywhere its behaviour needs checking, and "it compiled" is
not a verification for something whose entire output is a visual warning. `dev/harness.html`
mounts the same `guard`, `overlay` and `page` modules onto an ordinary page holding a fake
transaction list with a planted lookalike in it.

**That page is a picture of an assumption, and this package once believed it.** Its transaction
list prints every address in full as text. Real explorers do not, and for a while every test here
was written against the same picture, so all of them passed while the scan found nothing on the
pages it exists for. It is kept because it is useful for looking at the overlay; it establishes
nothing about whether the page scan works. The real-markup tests below do.

```bash
corepack pnpm --filter @truesend/extension harness
python -m http.server 3100 --directory apps/extension/dev
```

## What has been checked against a real page

Explorers do not print addresses, they print the ends of them. Measured on two real Etherscan
pages — a transaction list and a token-transfer list — **0 of 236 addresses could be read from
text**. Etherscan shows `0x1E227979...a6F538FD5`; Blockscout shows `0x79...41C0`, two characters
after the prefix and four at the end. The full address is in attributes, so that is where the scan
reads: `data-full-address`, `data-hash`, `data-clipboard-text`, `data-highlight-target`, `title`,
`alt` and `href`.

| | how it was checked |
| --- | --- |
| **Etherscan**, token transfers | a real account being poisoned at the time. Ten rows kept verbatim as a fixture (`test/fixtures/`), and the built scanner run in a real Chromium against the live page: 20 addresses found where there had been 0, 23 elements outlined, all 23 visible, the page's own tooltips left intact |
| **Blockscout**, token transfers | the same account, the live DOM after the page's own script rendered it. Sixteen addresses found; three different attacker addresses, all drawn as `0x79...41c0`, outlined |
| **Etherscan's copy button** | a real click. It fires two trusted `copy` events from a hidden `<textarea>`, and `getSelection()` returns the full address at that moment. This was assumed to go through `navigator.clipboard` and never fire the event; that assumption was wrong, and it was found by clicking |

Every other explorer is unchecked. The attribute list is what two real pages needed, not a claim
about the rest.

## Two things the overlay does on purpose

**It lives in a shadow root with `all: initial`.** It has to look the same on a block explorer, a
wallet, and a page that sets `* { font-size: 3em }`. A warning that inherits the host page's
styling is a warning the host page can hide.

**It is built with DOM calls, not `innerHTML`.** The strings going in are addresses and dictionary
words, so nothing is attacker-controlled in practice — but a content script that assembles markup
from page data is one refactor away from being an injection, and this one runs on every site.

## What it does not do

- **No history.** It cannot see the fabricated payment records that `analysis/` found, because
  that needs a chain scan with signer resolution and the answer has to arrive between a copy and
  a paste. The web app's Scan screen is where that lives.
- **No cross-device sync.** The saved list is per browser profile.
- **Chrome MV3 only, so far.** WXT builds Firefox too; it has not been tested there. The copy guard
  reads a form control's selection directly instead of trusting `getSelection()` to expose it,
  because not every engine does — that is the one place a Firefox difference is expected, and it
  is covered by a test rather than by having tried Firefox.
- **It runs in web pages and nowhere else.** A content script cannot enter another extension's
  popup or a mobile app. A wallet whose send screen is a browser-extension popup, or a phone, is
  outside what this can see, and those are where a large share of people send from. What covers
  them is the on-chain hold, not this.
- **At paste time it only knows what is on the destination page and what was saved.** The pair
  that matters — the real payee and the lookalike — is usually on the *source* page, the explorer,
  which is where the page scan runs. A user who has saved no contacts and pastes into a dapp gets
  the fingerprint and the altered-checksum check, and nothing that relates the address to their
  history. That is the price of "nothing leaves the browser", and it is a real one: closing it
  would mean sending the user's address to a server, which should be an explicit choice and is not
  made here.
- **Etherscan already warns at its own copy button**, for the transfers it flags. This does not
  replace that and is not the first thing to notice the mismatch; see `docs/prior-work.md`. What
  it adds on that page is relating two addresses to each other, which the dialog does not.
