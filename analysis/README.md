# Validating the detectors against real mainnet activity

Three scripts, no API key, no notebook. Each one fetches from public RPC endpoints and either
asserts its claims or fails.

```bash
node src/verify-wbtc-case.mjs    # re-derive the May 2024 WBTC loss from chain
node src/scan-poisoning.mjs      # measure what is happening right now
node src/evaluate-engine.mjs     # run the shipped detector over both
node src/false-positives.mjs     # find out whether it cries wolf
```

`evaluate-engine.mjs` imports `@truesend/engine` from its built `dist`, exactly as the web app
and the extension do. Reimplementing the rules here — the obvious thing to do in a notebook —
would measure a copy of the detector rather than the detector, and the copy is the one thing that
can never ship. `--check` makes it exit non-zero if the headline numbers regress, so it runs in
CI against the committed sample and the figures below cannot quietly rot.

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

## Does it cry wolf?

Everything above measures whether the detector *catches* things. This measures whether it is
bearable to live with, which decides whether anyone keeps it switched on — and a tool that gets
switched off protects nobody.

`false-positives.mjs` picks wallets at random from people who just made a genuine payment,
rebuilds each history the way the product does, and scores every counterparty in it.

Over **40 wallets and 2,501 counterparties**:

| | |
| --- | --- |
| counterparties flagged at all | 239 (9.6%) |
| — on a **fact** | 217 (8.7%) |
| — on a **heuristic** | 22 (0.9%) |
| **wallets that saw no warning at all** | **23 of 40 (57.5%)** |

**90.8% of every warning rests on a checkable fact** — a transfer log naming the user as
sender in a transaction they demonstrably did not sign. That is not a false positive in any
useful sense; it is a discovery. The 22 heuristic-only warnings are the ones that could be wrong.

### The objection that could have sunk this

A `Transfer` log naming you as sender in someone else's transaction is *usually* a fabrication —
but it is also exactly what a legitimate intent-based settlement looks like. A CoW or UniswapX
solver moves your tokens after you sign an order off chain, and the log names you while the
transaction names them. If a meaningful share of the 354 fabricated records were those, the
headline would be worthless.

The discriminator used is **whether the wallet has ever signed a transfer of that token itself**,
which needs no list of known tokens and so cannot be wrong about a token the list forgot. If you
have never signed a transfer of a token, you never held it, and a record of you sending it is
fabricated.

| | |
| --- | --- |
| zero value — never a settlement | 41 (11.6%) |
| a token the wallet has never signed — they never held it | 313 (88.4%) |
| **a token the wallet has used — could be a solver** | **0 (0.0%)** |

Zero, at this sample size. Not one of them could be a legitimate settlement.

### Lookalikes are never coincidence

A lookalike needs four leading and four trailing hex characters to match: 32 bits. Across this
sample the expected number of chance collisions is **0.00022**. The number observed was
**159**.

That is the heuristic's whole justification, and it is a factor of about seven hundred thousand
rather than a judgement call.

### The distribution is heavy-tailed

Danger verdicts per wallet, sorted: 71, 53, 36, 14, 12, 9, 9, 6, … and then 23 zeros.

Most wallets see nothing. A few are hammered. Reporting only the mean would hide both facts, and
the second one is the reason the product exists.

## What these numbers are not

- **The false-positive measurement is on *active* wallets**, sampled from addresses that made a
  payment in the last few minutes. Active addresses are targeted more than dormant ones, so
  9.6% is an upper bound on what a typical holder would see, not a typical figure.
- **22 heuristic-only warnings is not the same as 22 false positives.** Those are the ones that
  *could* be wrong, and given the collision arithmetic above almost certainly are not — most are
  likely cases where the fabricated record that corroborates them fell outside the scanned window.
  Nothing here establishes that, and it is not claimed.
- **The control set is not a false-positive rate either.** Those addresses were already known to
  be real payees, so of course they came back clean. It shows the detector does not fire on an
  obvious safe case and nothing more.
- **Not a recall figure.** The 4,234 pairs are the ones where victim, bait and imitated address
  all land inside one 1200-block window on one token. Poisoning where the real payment happened
  earlier, on another token, or in native ETH is invisible to this scan. The true volume is
  higher than measured; nothing here estimates how much.
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
