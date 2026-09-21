# Validating the detectors against real mainnet activity

Seven scripts, no API key, no notebook. Each one fetches from public RPC endpoints and either
asserts its claims or fails.

```bash
node src/verify-wbtc-case.mjs      # re-derive the May 2024 WBTC loss from chain
node src/scan-poisoning.mjs        # measure what is happening right now
node src/evaluate-engine.mjs       # run the shipped detector over both
node src/false-positives.mjs       # find out whether it cries wolf
node src/authorised-movements.mjs  # find out whether it cries wolf at solvers
node src/check-reconcile.mjs       # calibrate the instrument the last two rest on
node src/account-kinds.mjs         # find out which senders can sign at all
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
