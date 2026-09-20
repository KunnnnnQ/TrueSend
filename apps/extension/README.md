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
src/page.ts              finds and marks addresses in a document — 9 tests
src/overlay.ts           draws the card into a shadow root
dev/harness.html         the same modules on an ordinary page
```

The entrypoint is glue on purpose. Deciding, drawing and page work are separate modules so they
can be tested and looked at without an extension around them.

## Looking at it

A Chrome extension cannot be loaded everywhere its behaviour needs checking, and "it compiled" is
not a verification for something whose entire output is a visual warning. `dev/harness.html`
mounts the same `guard`, `overlay` and `page` modules onto an ordinary page holding a fake
transaction list with a planted lookalike in it.

```bash
corepack pnpm --filter @truesend/extension harness
python -m http.server 3100 --directory apps/extension/dev
```

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
- **Chrome MV3 only, so far.** WXT builds Firefox too; it has not been tested there.
