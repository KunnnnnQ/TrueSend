The TrueSend browser extension, built from this tag by `.github/workflows/release.yml` after its
typecheck and tests passed.

**Install in Chrome, Edge or Brave:** download the `.zip` below and unzip it. Open
`chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the unzipped
folder. It is not on the Chrome Web Store.

**What it does.** Shows a fingerprint for every address you copy, so a lookalike reads differently
from the address it imitates. On a page, it outlines addresses that a wallet would render
identically sitting next to each other — tested against markup saved from real Etherscan and
Blockscout pages.

**What it does not do.** It runs in web pages only: not inside a wallet's popup, and not on a phone.
It sends nothing anywhere — it asks for `storage` and access to the pages you visit, and has no
network code of its own.

Source, tests and the threat model: https://github.com/KunnnnnQ/TrueSend
