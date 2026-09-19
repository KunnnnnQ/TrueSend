# Validating the detectors against real mainnet activity

Three scripts, no API key, no notebook. Each one fetches from public RPC endpoints and either
asserts its claims or fails.

```bash
node src/verify-wbtc-case.mjs    # re-derive the May 2024 WBTC loss from chain
node src/scan-poisoning.mjs      # measure what is happening right now
node src/evaluate-engine.mjs     # run the shipped detector over both
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

## What these numbers are not

- **Not a false-positive rate.** The control set is the genuine payments the planted addresses
  were imitating — addresses already known to be real. It shows the detector does not fire on an
  obvious safe case. It does not sample ordinary user behaviour broadly, so it cannot tell you how
  often a normal person would see a warning.
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
