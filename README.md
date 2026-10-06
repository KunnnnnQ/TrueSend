# TrueSend

**Everyone is told to send a small test transfer first. Attackers do not wait for yours — they
fabricate one.**

Anyone can call a contract that emits a `Transfer` log naming *you* as the sender. No approval, no
signature, nothing you can refuse. Your history then shows a payment to an address you have never
paid, and whether your wallet notices depends on a filter it bought from somebody else. Of 53
popular Ethereum wallets evaluated in 2025, 16 displayed fabricated transfers as real, most
outsourced the filtering to their activity provider, and **only three warned when the user went to
pay the address** ([Guan and Li, arXiv:2508.12107](https://arxiv.org/abs/2508.12107)).

Etherscan, where most victims copy the address they later pay, does warn — with a dialog at its own
copy button when the transfer was signed by a different address than the sender, and by labelling
attackers it already knows. Of 30 planted lookalikes sampled a week after they were planted, one
carried a label. That protection stops at the edge of one site's copy button;
[`docs/prior-work.md`](docs/prior-work.md) §6 says exactly how far it reaches and how it was
checked.

That is how 1155 WBTC was lost in May 2024. The victim's "cautious test transfer" 73 minutes
before the real one was signed by somebody else, on a token contract whose symbol is `ETH`. Every
step of that is re-derived from chain and asserted in [`analysis/`](analysis/README.md) — not
taken from the write-ups, which mostly describe it wrongly.

It is not rare. In one four-hour window of mainnet USDT, **99.88% of zero-value transfers were
signed by somebody other than the address they name as sender**, and 5,121 distinct addresses had
a fabricated payment planted in their history.

A test transfer never verified that an address is *correct*. It only ever verified that it is
*reachable*.

TrueSend replaces the test transfer with two things that actually work:

- **A revocable hold on chain.** A transfer to a recipient your account has not trusted is queued,
  not sent. You — or a guardian who can veto but never spend — can drop it during the hold. This
  does not depend on you noticing anything while you sign.
- **A fingerprint a person can check.** Four dictionary words and a small glyph derived from the
  address. Two addresses that look identical in every wallet do not look identical here.

```
|██  ██  ██|        |  ██  ██  |
|██████████|        |  ██████  |
|██████████|        |██  ██  ██|
|  ██  ██  |        |██  ██  ██|
|  ██  ██  |        |  ██  ██  |

 0xAb58c4…0e93       0xaB58c4…0E93
 okay law add lunch  salute hollow mention submit
```

Same first six and last four characters. Same row in your wallet. Different everything else.

## Two modes

|  | `GuardedAccount` | `SafeVault` |
| --- | --- | --- |
| How | EIP-7702 delegation on your existing EOA | A contract that holds the funds |
| Migration | None — keep the address people already know | Fund a new address |
| Guarantee | Every payment routed through the account interface is held | Unbypassable by construction |
| Limitation | The key can still sign a raw transfer that never reaches the delegate | Counterparties must learn the new address |

That limitation is a property of EIP-7702, not of this implementation — the EIP changes what
happens when someone *calls* your address, not your key's ability to *originate* a transaction. It
is asserted by two named tests rather than buried in prose, and
[`docs/threat-model.md`](docs/threat-model.md) says exactly how far each claim reaches.

## The one property worth reading

Across arbitrary orderings of sends, cancels, trust changes, cooldown changes and waiting:

> every wei that left the vault either went to a recipient whose trust delay had fully elapsed, or
> sat in the queue until its unlock time.

Checked by `invariant_everyPayoutWasTrustedOrWaitedOutItsCooldown` over a fuzz campaign. The
campaign carries its own anti-vacuity test, because two earlier versions of it passed every
property while moving zero funds.

## Design decisions worth defending

**Policy changes are asymmetric.** Tightening applies immediately; loosening is itself queued
behind the current cooldown. Without that, anyone holding the key sets the cooldown to zero and
drains in one transaction, and the whole mechanism is decorative.

**Trust activates on a delay.** Otherwise "add the poisoned address to contacts, then send" is a
one-transaction bypass.

**The guardian's power is strictly negative.** It can veto a transfer and revoke trust. It cannot
move funds, and it cannot veto its own replacement — a guardian that could entrench itself would
hold the account hostage.

**The cooldown never consults the risk score.** Heuristics are public and evadable. An unknown
recipient is held regardless of what the engine thinks. The score changes what the user is *told*,
never what the contract *allows*.

**The registry reports the planter, not the lookalike.** Measured: 5,665 disposable lookalike
addresses in four hours, planted by 18 addresses, one of them responsible for 86%. A registry of
lookalikes needs thousands of entries a day; a registry of planters needs a handful. And because
attesting is permissionless, no number of reports can reach "do not send" on its own — a registry
that could condemn an address by itself would be a griefing tool aimed at the people this protects.
[`docs/registry.md`](docs/registry.md).

**One signal needs nothing remembered.** When someone reads their own transaction list, the
planted address and the one it imitates are both on the screen. The extension outlines them where
they sit, in the list, next to each other — no history, no network, no guess about intent. Asking
a user to compare two 42-character strings from memory is the thing they cannot do, and the
reason the attack works.

That claim was false for a while. The scan read addresses out of page text, and real explorers do not
print addresses — Etherscan draws `0x1E227979...a6F538FD5`, Blockscout draws `0x79...41C0`, and the
whole address is in an attribute. On two real pages, **0 of 236 addresses were readable from text**, and
every test had passed because every test built its transaction list out of full addresses. It now reads
the attributes, is tested against rows copied verbatim from both explorers, and was run in a real
browser against a live account being poisoned at the time: 20 addresses found where there had been none,
all 23 outlines visible. It runs in web pages and nowhere else — not in a wallet's extension popup, not
on a phone.

**A hold nobody hears about is only a delay.** The watcher alerts the owner *and* the guardian
within a poll, with a one-click cancel link that lands on the transfer. An alert is never sent
twice and a failure is never dropped, because a user who stops watching for themselves on the
strength of a promise deserves that promise kept.

**It has been measured against the thing that kills security tools.** Across 59 randomly sampled
active wallets, 52.5% saw no warning at all, and **97% of every warning that did fire rests on a
checkable fact** rather than an inference — a transfer log naming the user as sender in a
transaction they demonstrably did not sign. Those facts are checked rather than asserted: each
record is reconciled against the token's own balances, and all 884 held up. A tool that cries
wolf gets switched off, and then it protects nobody, so that number is the one worth arguing
about. [`analysis/README.md`](analysis/README.md#does-it-cry-wolf).

**Measuring it found two ways it cried wolf. Fixing the second one found a worse bug hiding behind
the fix.** A transfer you did not sign is not always a fabrication: someone you authorised — a
Permit2 filler, a CoW solver, a relayer spending a gasless signature — can move your tokens for
you, and 4.6% of nonzero USDT and USDC transfers are exactly that. The detector scored those
71/100 danger, the same score it gives the address that took 1155 WBTC. Fixed, and checked against
eight real histories pulled from live mainnet: 71/100 danger before, 0–6/100 safe after.

The second one is a smart account, whose every payment is submitted by a bundler rather than
signed by the account itself — telling one apart from an EIP-7702 delegated EOA, which also has
code but still signs, is read from the exact designator EIP-7702 defines rather than guessed; on
live mainnet 16% of token senders are delegated EOAs, so guessing wrong would not have been a
corner case. The first fix for this credited a smart account's *unsigned* transfers as genuine
payments, on the reasoning that a contract's balance only moves when its own code moves it — which
is false for the same reason the fabrication rule exists at all: a `Transfer` log is not evidence,
so an attacker's own token can claim a smart account received and later sent its tokens for the
price of two log entries and no signature from anyone. That version would have scored the
attacker's own address a clean, fully-trusted payee. Found before it shipped anywhere, by asking
whether the fix was actually safe rather than trusting green tests; pinned as a permanent
regression test. The account classification stays and is correct; a contract account's unsigned
transfers now land in the same bucket as an EOA's authorised third party, never as a payment it
made — which means the lookalike rule still has no payees to compare against for a smart-account
owner. That gap is real, open, and recorded in
[`docs/threat-model.md`](docs/threat-model.md), not patched with something unsafe. The fabrication
rule — the one that matters more, and the only reason the WBTC case is caught at all — works
correctly for these accounts either way.

**The counterfeit tokens are in the history too.** The bait in the May 2024 case was a token calling
itself `ETH`. On a real account being poisoned on 2026-09-26, sixteen of seventeen token contracts in its
recent history were counterfeits — eleven posing as USDT in four spellings, five posing as ETH — and
every one of their transfers had been planted. The Scan screen now reads what each token calls itself and
says so; before that, the token rules existed, were tested and were listed as a defence, and nothing in
the product called them. Measured against Uniswap's curated token list they flag none of 407 legitimate
tokens, after a first version flagged MATIC, SOL and POL.

**Scores explain themselves.** Every finding carries a sentence naming the contact being imitated
and both fingerprints. A bare number asks for trust; a reason lets the user catch what the rules
missed.

**One rule is a fact, not a heuristic.** A transfer log naming you as the sender, in a transaction
you did not sign, is a record of a payment that did not happen. It is the highest-weighted rule,
it needs no lookalike to compare against, and it is the only reason the WBTC case is caught at
all — the victim's history contained nothing resembling the attacker's address, so every
similarity rule scored it zero. Measured: `safe` (0) before, `danger` (71) after.

## Status

| Component | State |
| --- | --- |
| `contracts/` — policy, 7702 delegate, vault, factory, community registry | Built. 94 tests: unit, fuzz, invariant. 100% branch coverage |
| `packages/engine/` — fingerprints, heuristics, scoring | Built. 145 tests including property tests |
| `packages/chain/` — history with signer resolution, token identities, policy reads | Built. 27 tests. Shared by the app and the indexer |
| `apps/web/` — Scan, Send, Pending | Built. Scan reads mainnet directly, resolves signers and reads what every token in the history calls itself; that scan follows the user to Send, which also recognises a token address Scan already flagged; Send and Pending drive a deployed policy |
| `apps/indexer/` — hold watcher, alerts, risk API | Built. 17 tests on alert idempotency and resume |
| `apps/extension/` — copy and paste guard, in-page collision scan | Built. 41 tests, 13 of them against markup copied from real Etherscan and Blockscout pages |
| `analysis/` — replay against real mainnet cases | Built. Verifies the 2024 WBTC case from chain, measures live poisoning volume and the false-positive rate, replays the shipped detector |

Not audited.

Branch coverage was 64.6% and called out here as the weakest number in the repo. A coverage report
then named the eighteen untaken branches and **every one of them was an error path** — a policy
that had never been shown to refuse an uninitialised account, a queue that had never been shown to
refuse a second cancellation, a cooldown that had never been shown to refuse zero. In a contract
whose whole job is refusing things, those are the branches that matter most. They are covered now,
in `contracts/test/PolicyGuards.t.sol`, and branch coverage is 100%.

## Running it

Contracts need [Foundry](https://getfoundry.sh); everything else needs Node 20+ and pnpm via
corepack.

```bash
cd contracts && forge test
```

```bash
corepack pnpm install && corepack pnpm -r test
```

The app runs against real mainnet history with nothing deployed — Scan needs only an RPC. There
is a preset that loads the verified 2024 WBTC case, so the screen has something real to show
against a wallet that has never been targeted.

```bash
corepack pnpm --filter @truesend/web dev
```

Send and Pending need a policy to act on. Nothing is deployed on a public network yet;
`contracts/deployments/README.md` has the two commands that give you one on a local chain.

Deploying uses a keystore rather than a raw key, and writes an address book the app reads
directly so no address is ever transcribed by hand:

```bash
cast wallet import truesend-deployer --interactive
```

```bash
cd contracts && forge script script/Deploy.s.sol --account truesend-deployer --rpc-url sepolia --broadcast
```

## Layout

```
contracts/          Foundry. PolicyLib + GuardedBase, then GuardedAccount (7702) and SafeVault
packages/engine/    Pure TypeScript. Runs identically in the app, the extension and the API
apps/web/           Next.js. Scan reads history and checks signers; Send quotes before you sign;
                    Pending counts down against chain time and cancels
apps/extension/     Copy and paste guard. Outlines addresses on a page that render identically
apps/indexer/       Watches for holds, tells the owner and the guardian, serves risk queries
packages/chain/     Reading history and policy state. One implementation of "check the signer"
analysis/           Replaying the detectors against real cases
docs/               architecture.md, threat-model.md, registry.md
```

## License

MIT.
