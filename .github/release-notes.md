The TrueSend browser extension, built from this tag by `.github/workflows/release.yml` after its
typecheck and tests passed.

**Install in Chrome, Edge or Brave:** download the `.zip` below and unzip it. Open
`chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped
folder. It is not on the Chrome Web Store.

**What it does.** Shows a fingerprint for every address you copy, so a lookalike reads differently
from the address it imitates. On a page, it outlines addresses that pass for each other sitting next
to each other — the same first and last few characters a wallet shows, or the same last seven —
tested against markup saved from real Etherscan and Blockscout pages.

**New in 0.1.1.** An address that matches only the last seven characters of another now counts as a
lookalike, in the copy guard and in the page outline. Replaying 144 poisoning cases published with a
CCS 2024 paper found that 40 of the 44 dust baits copied only the end of the address they imitated;
the old rule wanted four characters at both ends and saw none of them. Checked on fresh mainnet data:
no false match in 27.9 million comparisons between genuine counterparties.

**What it does not do.** It runs in web pages only: not inside a wallet's popup, and not on a phone.
It sends nothing anywhere — it asks for `storage` and access to the pages you visit, and has no
network code of its own.

Source, tests and the threat model: https://github.com/KunnnnnQ/TrueSend
