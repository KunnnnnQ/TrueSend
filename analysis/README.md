# Validating the detectors against real mainnet activity

Thirteen scripts, no API key, no notebook. Each one fetches from public RPC endpoints and either
asserts its claims or fails.

```bash
node src/verify-wbtc-case.mjs      # re-derive the May 2024 WBTC loss from chain
node src/scan-poisoning.mjs        # measure what is happening right now
node src/evaluate-engine.mjs       # run the shipped detector over both
node src/false-positives.mjs       # find out whether it cries wolf
node src/authorised-movements.mjs  # find out whether it cries wolf at solvers
node src/check-reconcile.mjs       # calibrate the instrument the last two rest on
node src/account-kinds.mjs         # find out which senders can sign at all
node src/check-tokens.mjs 0x…      # which tokens in an account's history are counterfeit
node src/token-precision.mjs       # whether the token rules cry wolf on legitimate tokens
node src/etherscan-labels.mjs      # how many planted lookalikes Etherscan already labels
node src/poison-hunter.mjs         # replay cases somebody else found: Poison-Hunter's sample
node src/suffix-rule.mjs           # check the end-only lookalike rule on fresh data
node src/live-accounts.mjs         # the whole Scan screen on accounts being poisoned now
```

`evaluate-engine.mjs` imports `@truesend/engine` from its built `dist`, exactly as the web app
and the extension do. Reimplementing the rules here — the obvious thing to do in a notebook —
would measure a copy of the detector rather than the detector, and the copy is the one thing that
can never ship. `--check` makes it exit non-zero if the headline numbers regress, so it runs in
CI against the committed sample and the figures below cannot quietly rot.

What it cannot catch is a mistake in the parts it does not run. It builds the May 2024 case's
history by hand, and that history stops before the loss — which is how the regression told under
finding 7 got past it. So the live demo's preset also runs in CI the way the screen runs it:
`packages/chain/test/wbtc-case.test.ts` feeds `scanHistory` every answer mainnet gave about the
preset's range, recorded by `packages/chain/scripts/record-scan.mjs`, and checks the whole Scan
screen's verdict — including with the bait's signer lookup refused.

## What the data changed

Two things came out of this that changed the product, not just the numbers.

### 1. The attack is not the one the project was built around

The pitch this project started from was: *you make a small test transfer, a bot sees it, and
plants a lookalike address in your history.* That describes a real technique. It is not what
happened in the case everyone cites, and `verify-wbtc-case.mjs` asserts the difference:

```
block 19788642   victim -> 0xd9a1c378…853a91    "0.05 ETH"
block 19789009   victim -> 0xd9a1c378…853a91    1155.288 WBTC
```

The first line looks like the victim's own cautious test transfer, 73 minutes before the real
one. **The victim never made it.** It was signed by `0x517dc8e5…`, who called a contract that
emitted a `Transfer` log naming the victim as the sender. The token it was emitted on has symbol
`ETH`, name `Ether` and 6 decimals — a contract impersonating the native currency.

So the attacker did not wait for a test transfer. **They fabricated one**, and the victim then
did exactly what the safety advice tells everyone to do: checked their history for a prior
successful payment to that address, found one, and trusted it.

A test transfer never verified that an address is *correct*. It only ever verified that an
address is *reachable*. Address poisoning is the attack that lives in that gap.

### 2. The detector missed it completely

Run against the verified case, the engine as originally written scored it **0 out of 100, level
`safe`**. Not a near miss — no findings at all.

The reason is structural. Every rule in the engine was a similarity rule, and the victim's
history contained no address resembling the attacker's for them to fire on. Worse, the engine
counted `outgoingCount > 0` as evidence of *trust*, so a fabricated outgoing record made the
attacker look like a payee the victim had already used.

The fix is not another heuristic. A transfer log naming you as the sender, in a transaction you
did not sign, is a **fact**: a record of a payment that did not happen. There is no benign reason
for one to exist. It is now the highest-weighted rule in the table, it needs no lookalike, and
`AddressSighting.spoofedOutgoingCount` is a required field so that an indexer which does not
resolve transaction signers has to write `0` deliberately rather than get the dangerous default
for free.

| | before | after |
| --- | --- | --- |
| WBTC case, signer-aware indexer | `safe` (0) | **`danger` (71)** |
| WBTC case, naive indexer | `safe` (0) | `safe` (0) |

The second row is not a defect, it is the point: **this only works if the indexer resolves who
signed each transaction.** That is now an architectural requirement rather than an optimisation,
and it is why `spoofedOutgoingCount` is required rather than optional.

## How much of this is happening

One 1200-block window of Ethereum mainnet USDT — about four hours, blocks
26013728..26014927, sampled 2026-09-19:

| | |
| --- | --- |
| USDT transfers | 84,612 |
| zero-value among them | 7,601 (8.98%) |
| **signed by someone other than the named sender** | **7,592 (99.88%)** |
| genuinely self-signed zero-value transfers | 9 |
| distinct addresses that had a fabricated payment planted in their history | **5,121** |
| distinct lookalike addresses planted | 5,665 |
| planted addresses imitating someone the same victim really paid, in this same window | 4,234 |

Nearly every zero-value transfer on the largest stablecoin on Ethereum is a fabricated history
entry. Not a fringe technique — the default state of the ledger.

**Timing.** Of the 4,076 planted addresses that followed the payment they imitate: median
**26 blocks** (~5 minutes), 90th percentile 146, longest observed 1,125
(~3.8 hours). 82% land within 50 blocks. This is what the engine's
`RECENT_PAYMENT_WINDOW_SECONDS` is now set from, rather than from intuition.

**Concentration.** 18 distinct addresses planted all 7,592 records, and one of them
(`0xd6434d157f254276d69ede3bd9fc805482206908`) accounts for **86.00%**. That is a real finding for the community-registry design: a registry keyed on the
*planter* rather than on each disposable lookalike would cover most of the attack surface with a
handful of entries.

> Found here first, and then found to be known. Guan and Li (ACM CCS 2024) report that *"98% of
> phishing addresses are controlled by four entities, which collected nearly 92% of the total
> profits"* over Nov 2022 – Feb 2024. Their figure counts clustered *entities* across fifteen
> months; this one counts *addresses* in a four-hour window, so the numbers are not comparable and
> are not being compared. The shape is the same, and a peer-reviewed measurement over fifteen
> months is better evidence for the registry design than four hours of mine. See
> [`docs/prior-work.md`](../docs/prior-work.md).

## Detection rates

Scored over the 750 committed rows, with the fixed engine:

| | danger | caution | safe |
| --- | --- | --- | --- |
| planted addresses (signer-aware indexer) | **100%** (750) | 0% | 0% |
| planted addresses (naive indexer) | 92.4% (693) | 7.6% (57) | 0% |
| **the genuine payees they imitate** (control) | 0% | 0% | **100%** (750) |

The control row matters as much as the first. A tool that flags real payees gets switched off,
and then it protects nobody.

### 3. The detector had a hole big enough to drive three fake USDTs through

`false-positives.mjs` samples real wallets at random, which turns up whatever they happen to hold.
Three of the contracts it found were fake USDTs, and the token detector — built around a table of
Cyrillic and Greek lookalike characters — waved through all three:

| renders as | actually is | what the old rules saw |
| --- | --- | --- |
| `USDT` | `U+A4A4` (a Yi radical) + `5DT` | nothing wrong |
| `USDT` | `U+A4F4` (a Lisu letter) + `S` + `U+17B4` ×2 + `DT` | nothing wrong |
| `USDT` | plain ASCII `USDT`, at a contract that is not USDT | nothing wrong |

Unicode has about 140,000 characters and an attacker picks from all of them, so a table of the
ones seen so far is an arms race that loses by default. The rules were replaced with two that
cover whole classes instead:

- **a real ticker is plain ASCII**, which catches every exotic-script impostor regardless of which
  script comes next and cannot be evaded by finding a new homoglyph;
- **a real token's symbol belongs to its own contract**, which catches the third one, whose symbol
  is spelled perfectly and whose only lie is where it lives.

The narrower homoglyph rules still run, because they name *which* token is being imitated. They
are no longer what the detection rests on. All three contracts are now regression tests, with
their real addresses, in `packages/engine/test/tokens.test.ts`.

### 4. The token detector was wired to nothing

The section above ends with the token rules rewritten, retested and three real counterfeits pinned as
regression tests. What it does not say is that **nothing in the product ever called them.**
`inspectToken` was exported from the engine and used by no screen, no indexer and no extension, because
none of them ever read a token's symbol; `docs/threat-model.md` listed it under *Defended*, pinned by a
test that exercised the function and not the product. It is now in the Scan screen, which reads
`symbol()` for every token in the scanned history in one batched call (`readTokenIdentities`).

Run through that path against a real account that was being poisoned when this was written
(`node src/check-tokens.mjs 0x0bcf…8675 --blocks 100000`), 17 token contracts read in 0.4 seconds:

| | |
| --- | --- |
| counterfeit | **16** — eleven posing as USDT in four spellings, five posing as ETH |
| real | 1 — the actual USDT, not flagged |
| planted | **all 16** had every one of their transfers planted: a record of the account "sending" it in a transaction it never signed, or a zero-value transfer in |

Two of the four USDT spellings are the ones the rewrite was built from. **The other two, and all five of
the ETH ones, were not** — `USD⟨U+FFF0⟩T` and `ET⟨U+FFF0⟩H` (an invisible noncharacter injected into the
word), `U5⟨U+17B4⟩⟨U+17B4⟩D⟨U+A4D4⟩`, `E⟨U+17B4⟩⟨U+17B4⟩⟨U+A4D4⟩H`. All but one were caught anyway, which is the
claim the rewrite made and had not until then been tested against anything unseen: asking "is this ASCII?"
catches the next homoglyph without anyone having to know it. The exception is next.

**It also missed one, and the miss is the May 2024 bait again.** `Ether..` — contract
`0x5bc57682…afe85f8`, 18 decimals, `balanceOf` reverting for the account it named as sender, records
of that account "sending" 1.468 of it to a lookalike, signed by someone else — got past the
native-currency rule, which compared the symbol to `eth`/`ether` exactly. Two dots. The rule now strips
the punctuation an attacker adds for free, and does not strip `+`, because `ETH+` is a real token.

**Then the rules were run over tokens that are fine, and that found a worse problem than the miss.**
The rules flag anything outside printable ASCII, and the honest objection to that is that plenty of real
tokens are. `node src/token-precision.mjs`, over two published lists of legitimate Ethereum tokens:

| | tokens | flagged, first version | flagged, now |
| --- | --- | --- | --- |
| Uniswap default list (curated) | 407 | **3** (0.74%) — MATIC, SOL, POL | **0** |
| CoinGecko (broad, contains junk) | 6,001 | 12 (0.20%) | 8 (0.13%) |

Re-measured on 2026-10-07 against the lists as they now stand — 408 and 6,027 tokens — the rules
still flag 0 and 8.

A second, weaker tier came later: the 408 tokens of Uniswap's default list, pinned in
`packages/chain/src/token-list.ts` by `tools/update-token-list.mjs`. A token named like one of them at
another contract is questioned (`listed-symbol-wrong-contract`): **counterfeit** once it has been planted
in the account's history, **unusual** otherwise, never an alarm on the name alone. Tickers are not
unique: across CoinGecko's list, 74 of 6,026 tokens share a listed ticker at a different contract — a
crowd of PEPEs, and the *current* Kyber Network Crystal, because Uniswap's list still carries the
contract from before Kyber's migration. That one is a real token the tier questions, a stale entry in
someone else's curation; the price is a line, not an alarm. Uniswap's own list carries one ticker
twice, two different `LIT`s, and the rule had to be taught that matching either one is a match.

Those three were false alarms on tokens people really hold. The native-currency rule had listed *every*
chain's currency — matic, bnb, avax, sol, pol — on the reasoning that a native currency cannot be a
token, which is true of the chain you are on and false of every other. On Ethereum, MATIC, POL and SOL are
ordinary, widely held ERC-20s. A red "counterfeit token" panel over a user's real MATIC is the false alarm
that gets a tool muted; the rule is now the running chain's own currency.

What CoinGecko's eight are is the other half of the same lesson. Most are meme tokens whose only fault
is how they are spelled — a Chinese ticker, an emoji, lookalike letters — nothing in the list marks any of
them as fraudulent; one has a symbol ending in a non-breaking space; and one is plainly called `ETH`, which
the rule is right to flag. Being spelled strangely is not being counterfeit. So the app calls a token **counterfeit**
when it claims to be a specific real asset, or when it was *planted* in this account's history — the
same fact the whole project rests on — and merely **unusual** otherwise, in a line and not an alarm.

What this does not establish: the live-account result here is **one account**, and an unusually heavily
poisoned one, not a typical user — three later runs of 25 accounts each are in "On accounts being
poisoned right now". The two legitimate lists are lists of tokens that get listed, which
is not the same as tokens people hold. And a counterfeit spelled strangely that has not yet been planted
in a given history is shown as unusual rather than as an alarm — the price of the precision, stated in
`docs/threat-model.md`.

### 5. The page scan found nothing on the pages it was written for

The browser extension outlines the planted address and the one it imitates, in place, in a user's own
transaction list. Its tests built that list out of `<td>0xabc…</td>`, with the full address as text. On
a real Etherscan transaction list and token-transfer list, **0 of 236 addresses could be read from text**:
Etherscan draws `0x1E227979...a6F538FD5` and keeps the address in attributes; Blockscout draws `0x79...41C0`
and keeps it in `href` and `data-hash`. Every test was green throughout, because they tested the scan
against the assumption it was built on. Details, and what was checked against which real page, are in
`apps/extension/README.md`.

The same page also showed that **Etherscan already warns** — a copy-time dialog for a transfer signed by a
different address than the sender, a low-value warning, labels on known attackers — which changes what
this project can honestly claim to be first at. That is `docs/prior-work.md` §6. Of 30 planted lookalikes
sampled a week after they were planted, **1** carried an Etherscan label (`node src/etherscan-labels.mjs`;
a sample that small puts the true share between roughly 0.6% and 17%).

## Against somebody else's cases

Every number above was measured on cases this project found, with rules written beside the detector
they test. `poison-hunter.mjs` uses cases somebody else found: the 150 sample poisoning transfers Guan
and Li published with their CCS 2024 paper (`docs/prior-work.md` §1). They come to 144 distinct
baits — 44 dust, 50 zero-value and 50 counterfeit-token — from November 2022 to August 2023. Six rows
repeat a bait against a different earlier payment it imitates; each bait is counted once. For every
bait the victim's history is rebuilt the way the Scan screen would have built it the moment the bait
landed — `scanHistory`, the app's own 50,000-block look-back, signers resolved — and the attacker's
address is scored the way Send would score it when the victim pasted it.

| the attacker's address | danger | caution | safe |
| --- | --- | --- | --- |
| zero-value baits (50) | **50** | 0 | 0 |
| counterfeit-token baits (50) | **50** | 0 | 0 |
| dust baits (44), the engine as it was | 2 | 42 | 0 |
| dust baits (44), with the end-only rule below | **42** | 2 | 0 |

- **No bait came back `safe`.** The 100 zero-value and counterfeit baits were caught by the
  fabrication rule alone — a record of the victim paying the attacker, in a transaction the victim
  never signed — with no help from similarity. An indexer that believes the logs leaves **50 of those
  100 at `safe`**: finding 2 at the top of this page, on cases nobody here chose.
- **The token check named all 50 counterfeit tokens.** The contract each counterfeit bait used was
  judged the way Scan judges it, and every one came back counterfeit.
- **No genuine payee was flagged.** Every address the victim had provably paid that week, by the
  victim's own signature, scored `safe`: 121 of 121. Thirteen addresses the dataset labels genuine
  scored `danger`, and each was checked: not one record naming any of them was signed by the victim.
  In eight, the victim's real payee — paid between one and nine times that week — is a third address,
  which both the dataset's attacker and its "genuine" address imitate; the label there is a second
  lookalike. The other five fit the same pattern, but no payee they imitate turned up in seven weeks
  of history, so they are left open rather than counted either way.

### 6. Lookalikes that only copy the end were invisible

The dust row above read 2 and 42 when this replay first ran (`data/poison-hunter-before-suffix-rule.json`).
Forty of the 44 dust baits matched the last seven characters of the address they imitated and fewer
than four of the first — 39 of them two or fewer — aimed at the habit of checking how an address
ends. The lookalike rule demanded
four at both ends, so it never fired on them. They reached `caution` only because a dust transfer from
an address never paid scores exactly the caution threshold, and the warning never said who was being
imitated — although in 43 of the 44 the victim had paid that address the same week.

The rule now also accepts **seven characters at the end alone** (`SUFFIX_ONLY_MATCH` in
`packages/engine/src/risk.ts`). Seven is 28 bits; six would have put the arithmetic in "Lookalikes are
never coincidence" below at about eight expected chance matches. The two dust baits still at `caution`
are not lookalikes under any rule: two leading characters, and one or three trailing.

Seven was read off this sample, so this sample cannot be its evidence. `suffix-rule.mjs` checks it on
fresh data — blocks 26,137,630–26,138,829, about four hours of mainnet USDT and USDC, 186,540 transfers:

- **Crying wolf.** Across 27,948,642 comparisons between genuine counterparties of the same account —
  addresses it paid at least one whole token, and addresses that paid it — the end-only rule matched
  **none**. Chance alone predicts 0.10.
- **Still catching.** In those four hours, **126 dust plantings** imitate a payee of the account they
  were sent to by the end alone — 120 of them with three leading characters and seven trailing, one
  short of the old floor. The both-ends rule recognises 1,706 others and missed all 126.

It shows in the app, too. Loaded in Scan with its 2022 history, one of the replayed dust baits used to
read `caution` at 18, from the dust rule alone. It now reads "Do not send" at 83, and its first reason
names the payee it imitates by "the last 7 characters".

## On accounts being poisoned right now

`live-accounts.mjs` draws accounts that had a payment record fabricated in the last 300 blocks of
USDT and USDC — people being targeted that hour — and runs on each exactly what the Scan screen
runs: `scanHistory` over the app's look-back, every counterparty through `assessAddress`, every token
through the engine's `checkTokens`. What counts as right comes from the account's own signatures,
not from the rules under test: a counterparty it signed a payment to is a contact it chose, and a
token it signed a transfer of is one it holds.

| | first run | after the fixes, first version of 7 | final |
| --- | --- | --- | --- |
| accounts scanned (skipped as too active) | 25 (1) | 25 (2) | 25 (0) |
| counterparties scored | 1,407 | 501 | 781 |
| contacts the accounts paid themselves, warned about | **1** of 789 | **0** of 62 | **0** of 136 |
| tokens the accounts moved themselves, flagged | 0 of 64 | 0 of 30 | 0 of 30 |
| counterfeit tokens named | 502 | 674 | 600 |
| tokens with every transfer planted, called clean | 4 | 1 | 1 |

The second run is a fresh draw from a later window — blocks 26,139,487–26,139,786; the first drew
from 26,139,303–26,139,602, so a few accounts may be in both. Neither fix has a threshold that could
have been tuned on the first. The final run drew from blocks 26,140,010–26,140,309, a window that
overlaps neither, with fix 7 in its corrected form and the listed tier described under finding 4
switched on. Every run's file is kept: `data/live-accounts-before-fixes.json`,
`data/live-accounts.json` and `data/live-accounts-listed-tier.json`. After the fixes, the one token
passed with every transfer planted was, both times, a real one used for zero-value poisoning — BUSD,
then USDT.

All three runs used `scanHistory` as it was before 2026-10-07, which dropped a transfer without a
trace when the endpoint refused to say who signed it. A dropped record could have hidden a warning,
or caused one; nothing counted them, so whether any did cannot now be told. The script now refuses
a scan with anything unchecked, as the app now says so instead of hiding it.

### 7. A copied payment made a real contact "do not send"

The one contact warned about in the first run — and one more in a two-account trial before it — had
been paid by the account with its own signature, in one case 195,825 USDT. Thirty-five to forty
blocks later a planter, the same address both times, published a counterfeit-token "transfer" of exactly the same
amount from the account to the same real recipient. The fabrication rule exists because a fake
record makes an address look like one already paid; this address really had been paid, but the rule
still scored it 65, and the real recipient read "Do not send".

On an address the user had already paid with their own signature *before* any fabrication named
it, the record is now `spoofed-copy-of-payment`: shown, weighing nothing. The order is the whole
test, and the first version of the fix got it wrong. It asked only whether the user had ever paid
the address, and on the app's own May 2024 preset — which scans past the loss — it called the
attacker "Looks fine": the 1155 WBTC was a payment the victim signed, so the bait before it read as
a copy. No test caught it, because every test built its copy case without a loss in it; loading the
preset in the app did, after the change had already reached the live demo. The preset now runs in
CI from recorded mainnet answers, and with the first version of the fix put back, it fails. A planter copying a real
payment produces the payment first and the fake after; an attack that works produces the fake first
and the payment after. The exemption now needs the payment first, a history that cannot show the
order gets none, and when the user paid after the fake the finding says so. In the final run the
copy turned up on 16 of the 136 contacts the accounts had paid, and none of the 136 was warned about.

### 8. Fakes with ordinary names, or none, were called clean

Of the four tokens in the first run whose every transfer was planted but which the check called
clean, one was the real USDC — zero-value poisoning runs on real tokens, so passing it is right. The
other three were fakes: a `cbBTC` that is not Coinbase's, and two contracts with empty names, each of
which forged three hundred transfers in a single transaction. The rules read names, and the canonical
list knows three assets, so there was nothing for them to object to. The records those fakes planted
were caught all along — their recipients scored `danger` — but the token panel never named the
contract.

A token is now also counterfeit on its own records: the account "sending" a nonzero amount it never
held, in a transaction somebody else signed (`forgedTransfersByToken`, the test the fold already
applies to call such a record a fabrication). A real token cannot record that, with one exception the
fold already has: a token received before the scanned window and moved by an approved spender looks
forged. In the second run, five tokens were convicted on their records alone; all five had no name,
and none is on CoinGecko's Ethereum token list. The one token still passed with every transfer
planted was the real BUSD, used for zero-value poisoning.

The listed tier, on in the final run, caught no fake that the other rules had missed. It questioned
one token — an `ALPHA` at a contract that is neither Alpha Finance's nor on CoinGecko's list, never
planted, so shown as unusual — and none of the 30 tokens the accounts moved themselves. What it is
for is a case that sample did not contain: a fake named like a real asset that only ever plants
zero-value records, which no other rule can see. It also takes the 408 listed tokens out of the
forgery rule's one false alarm, a real token held from before the look-back.

## Does it cry wolf?

Everything above measures whether the detector *catches* things. This measures whether it is
bearable to live with, which decides whether anyone keeps it switched on — and a tool that gets
switched off protects nobody.

`false-positives.mjs` picks wallets at random from people who just made a genuine payment,
rebuilds each history the way the product does, and scores every counterparty in it.

Over **59 wallets and 21,899 counterparties**:

| | |
| --- | --- |
| counterparties flagged at all | 909 (4.2%) |
| — on a **fact** | 884 (4.0%) |
| — on a **heuristic** | 25 (0.1%) |
| **wallets that saw no warning at all** | **31 of 59 (52.5%)** |

**97.2% of every warning rests on a checkable fact** — a transfer log naming the user as sender
in a transaction they demonstrably did not sign. Every one of those 884 was then checked against
the chain rather than taken on trust, and all 884 held up; see below. The 25 heuristic-only
warnings are the ones that could be wrong.

Read the per-counterparty percentages carefully. The median wallet here has **3** counterparties
and the largest has **15,674**, so an aggregate "4.2%" is mostly describing that one wallet. The
per-wallet row is the one that says what a person actually sees.

### The objection that could have sunk this

A `Transfer` log naming you as sender in someone else's transaction is *usually* a fabrication —
but it is also exactly what a legitimate intent-based settlement looks like. A CoW or UniswapX
solver moves your tokens after you sign an order off chain, and the log names you while the
transaction names them. If a meaningful share of these records were those, the
headline would be worthless.

**The first version of this test was wrong, and wrong in the direction that flattered the
result.** It asked whether the wallet had ever *signed* a transfer of the token, on the reasoning
that "if you have never signed a transfer of a token, you never held it". Receiving a token needs
no signature. A wallet paid in USDC that sells it through a gasless permit has never signed
anything touching USDC, and its USDC really leaves. That test filed every such case under
impossible and duly returned a clean zero.

`reconcile.mjs` asks the token instead of guessing. An honest token's balances move exactly as
its logs say, so each record is checked against the owner's balance either side of its block,
against the net of every transfer log in that block that touches them. `check-reconcile.mjs`
calibrates it first, on two records whose nature was already established: the fabricated WBTC
bait, which must not read as real, and the 1155 WBTC the victim genuinely sent, which must.

Of **1,746** records claiming these wallets paid somebody without signing:

| | |
| --- | --- |
| zero value — nothing moved, so nothing was paid | 376 (21.5%) |
| the contract will not answer `balanceOf` at all | 1,119 (64.1%) |
| balances contradict the logs | 241 (13.8%) |
| **value really left the wallet — not a fabrication** | **10 (0.6%)** |
| could not be checked | 0 |

99.4% were fabrications. **Ten were not.** Seven of the ten were settled through
`0x9008d19f…560ab41` — CoW Protocol's settlement contract — nine were USDG and one USDT. The old
test called 1,369 records impossible-to-be-a-settlement, and **nine of them were CoW
settlements**: the predicted failure mode, in the data, in exactly the predicted place.

The largest bucket deserves its own look. **64% of fabricated records come from a contract that
will not answer `balanceOf` at all.** Those are not tokens. They are log emitters.

### Which rule the product should use, measured rather than argued

Reconciling needs archive state, which the product does not have — public endpoints serve recent
state only. So it is ground truth, used to score rules that see only what the product sees. On
the 1,370 nonzero records:

| rule | left alone | false alarm | caught | **missed** |
| --- | --- | --- | --- | --- |
| flag every unsigned transfer (what the product used to do) | 0 | 10 | 1,360 | **0** |
| **real if the owner has held the token — shipped** | **10** | **0** | **1,360** | **0** |
| real if they have signed a transfer of that token | 1 | 9 | 1,360 | **0** |
| real if they have ever received that token | 10 | 0 | 1,360 | **0** |

A *missed* is a fabrication the rule waves through, and it has to stay at zero: a false alarm
costs trust, a miss costs somebody their money.

Nothing was missed by any rule, and that is itself a measurement rather than a property of the
rules. It says that in this sample **no attacker planted a nonzero inbound of their own token** —
the one cheap move that would buy the exemption. That is a fact about how the attack is currently
run, and it is the thing to re-measure if these rules ever start looking too good.

`foldHistory` implements the shipped row; see `packages/engine/src/history.ts`.

`authorised-movements.mjs` then checks the fix end to end rather than on paper. It finds people
on mainnet whose tokens moved without their signature, rebuilds each history the way the Scan
screen does, and scores the address the tokens went to:

| | verdict on the recipient |
| --- | --- |
| before the fix | **danger, 71/100** — `spoofed-outgoing-transfer` |
| after, over 8 real histories | **safe, 0–6/100** — 0 of 8 called an attacker |

71 is the same score the engine gives the WBTC attacker, which is the point: for three days the
detector could not tell a CoW solver from the address that took 1155 WBTC.

Handing the engine the single unsigned record on its own would have rigged this — with no history
at all it cannot know the owner ever held the token, so of course it cries fabrication. That is
also the real limit of the fix: the engine learns about a holding by watching the token arrive, so
a token acquired before the start of the scanned window is invisible and the warning comes back.
None of the eight hit that, but a longer-dormant holder would. Only a balance read removes it, and
that belongs in the chain layer, not in a pure rule.

### Some accounts cannot sign anything, and the detector was blind to all of them

The whole engine compares the owner against `tx.from`, and for a contract account that comparison
can never be true. An ERC-4337 smart account's payments reach the chain inside a bundler's
transaction; EIP-7702 puts it in the protocol that accounts with code other than a delegation
designator *"may not originate transactions"* at all.

That was worse than a missing trust signal. `assessAddress` builds its payee set from payments the
owner signed, and the lookalike rule only compares against that set. A smart account has none, so
**the lookalike rule could not fire for it at all** — a test shows a lookalike of a payee the
account really paid scoring `no-history-at-all`.

`scanHistory` reads the owner's code once per scan to tell a contract account from an ordinary
one. The obvious version of that check — "has code, therefore a contract" — would have been a
second bug, because an EIP-7702 delegated EOA also has code and still signs. `account-kinds.mjs`
measures how much that distinction is worth, on the addresses named as the sender of a USDT or
USDC transfer:

| | |
| --- | --- |
| plain EOA | 1,205 (62.5%) |
| **EIP-7702 delegated EOA — has code, still signs** | **314 (16.3%)** |
| contract | 409 (21.2%) |

The naive reading would have dropped the signer test for one sender in six, and for every user of
this project's own `GuardedAccount`, which is a delegation. So the designator is matched exactly —
`0xef0100` and twenty more bytes, checked against a live account rather than a fixture.

The contract share is an upper bound on smart *wallets*: pools, routers and vaults appear as
senders inside other people's transactions too, and the live example the script found was a
Uniswap v4 pool manager. The delegated share has no such caveat, because a delegation designator
only ever sits on an EOA.

**Reading the classification correctly turned out to be the easy part.** Knowing an account
cannot sign says what to *stop* doing — stop demanding a signature that structurally cannot exist —
and the first attempt filled that gap by trusting the tokens instead: a value-moving record
against a token the history shows arriving must be the account's own doing, since a contract's
balance only moves when its own code moves it.

That reasoning has this file's own opening argument as its counterexample. `held` — whether the
account "has" a token — is established by reading a `Transfer` log, and a log is not evidence of
anything a token contract didn't choose to claim. An attacker's own token can emit "the account
received one wei of this" for free, then "the account sent some back" right after, and the first
version credited that as a genuine payment with no signature anywhere in the reasoning. Worse than
the plain fabrication it replaced: a plain fabrication scores danger; this **suppressed every
baseline suspicion**, including "this address has never been paid before," and would have made an
attacker's own address read as a fully trusted payee for the price of two log entries.

Found by asking whether the fix was actually safe rather than trusting that its tests were green,
before it reached a deployed contract or a live user. Fixed by giving a contract account exactly
the treatment a solver already gets against an EOA: a value-moving unsigned record lands in
`authorisedOutgoingCount`, never in `outgoingCount`, whoever the owner is. Pinned as a permanent
regression test in `packages/engine/test/history.test.ts`
(`describe("the exact hole this used to have")`), reproducing the two-log attack exactly and
asserting the baseline suspicion survives it.

**The honest cost, stated rather than hidden:** the lookalike rule still has no payees to compare
against for a smart-account owner, because nothing that reads only logs and a signer can tell "the
account's own logic authorised this" apart from "a token contract claimed it happened." That is not
a bug to be found later — there is no safe version of this that keeps the rule working for these
accounts from this information alone. The fabrication rule is unaffected and is the one that
matters more: it needs no payee, and it is what would have caught the May 2024 case regardless of
which kind of account the victim was.

### Lookalikes are never coincidence

A lookalike needs four leading and four trailing hex characters to match: 32 bits. Across this
sample the expected number of chance collisions is **0.030**. The number observed was **575**.

That is the heuristic's whole justification, and it is a factor of roughly nineteen thousand
rather than a judgement call.

The end-only rule added after the Poison-Hunter replay needs seven trailing characters: 28 bits,
sixteen times likelier by chance, which puts the same sample's expectation at about **0.5** — still
under one. Six would have put it near eight, which is why it is seven. It was then checked on fresh
data rather than left to the arithmetic: no genuine pair in 27.9 million comparisons (see
[Against somebody else's cases](#against-somebody-elses-cases)).

### The distribution is heavy-tailed

Danger verdicts per wallet, sorted: 163, 154, 95, 71, 63, 56, 50, 44, 44, 31, … and then 31
zeros.

Most wallets see nothing. A few are hammered. Reporting only the mean would hide both facts, and
the second one is the reason the product exists.

## What these numbers are not

- **The false-positive measurement is on *active* wallets**, sampled from addresses that made a
  payment in the last few minutes. Active addresses are targeted more than dormant ones, so
  4.2% is an upper bound on what a typical holder would see, not a typical figure.
- **25 heuristic-only warnings is not the same as 25 false positives.** Those are the ones that
  *could* be wrong, and given the collision arithmetic above almost certainly are not — most are
  likely cases where the fabricated record that corroborates them fell outside the scanned window.
  Nothing here establishes that, and it is not claimed.
- **The control set is not a false-positive rate either.** Those addresses were already known to
  be real payees, so of course they came back clean. It shows the detector does not fire on an
  obvious safe case and nothing more.
- **Not a recall figure.** The 4,234 pairs are the ones where victim, bait and imitated address
  all land inside one 1200-block window on one token. Poisoning where the real payment happened
  earlier, on another token, or in native ETH is invisible to this scan. The true volume is
  higher than measured; nothing here estimates how much. The recall figure is the Poison-Hunter
  replay, which has limits of its own:
- **The live-account runs are 25 accounts each, drawn in one hour.** Active payers are the ones
  targeted, so these are the people the product is for, not a cross-section. Accounts too active to
  scan in the time a user would wait (2,000 transfers in the look-back) are counted and skipped, so an
  exchange's hot wallet is not measured at all.
- **The Poison-Hunter sample is 150 rows its authors chose,** from November 2022 to August 2023,
  50 of each kind; the repository does not say how they were chosen. The replay says what the
  detector does on those, not what share of all poisoning it would catch. The end-only rule was
  read off the same rows, so its numbers there show the hole closing, not that the rule works — the
  fresh-data check is what says that.
- **Runs before 2026-10-07 could not see a refused lookup.** `scanHistory` dropped any transfer
  whose signer or block time the endpoint refused, silently, in the app and in these scripts alike.
  `poison-hunter.mjs` checked for the one record that mattered most to it, the bait, and rescanned
  any case missing it; no bait is missing from the published results. The other scripts had no such
  check. Every script that measures now refuses an incomplete scan.
- **Not adversarial.** These rules are public. An attacker who reads them can plant a lookalike
  that matches only three characters, wait a day, and score nothing. That is precisely why the
  contracts never consult the score: an unknown recipient is held regardless.
- **One token, one window, one chain.** Re-running on a different window moves the third decimal,
  not the conclusion, but the sample is what it is.

## Reproducing

The scan runs against whatever the chain head is now, so the counts will differ from the table
above; the shape has been stable across every window tried. `data/scan-latest.json` carries the
aggregate counts for the full scan plus 750 matched rows, each with the two transaction hashes it
rests on, so any single claim can be checked on a block explorer without rerunning anything.

```bash
node src/scan-poisoning.mjs --blocks 1200 --sample 0
```

Archive queries for the 2024 case need an endpoint that serves old blocks on a free plan. As of
2026-09-20 that is `rpc.mevblocker.io`; publicnode, drpc, llamarpc, cloudflare, ankr, blockpi,
flashbots and 1rpc are all either gated, rate-limited to a handful of blocks, or down. The list
lives in `src/rpc.mjs` with that note attached, because none of it is discoverable from their
documentation.

`poison-hunter.mjs` scans 144 victims through that one endpoint, which answers with a Cloudflare
rate-limit page (error 1015) well before four scans run in parallel; the default is two, and every
finished scan is cached in `.cache/` so a rerun resumes. Behind a proxy, Node's `fetch` ignores
`HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set.
