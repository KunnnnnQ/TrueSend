# TrueSend

**Everyone is told to send a small test transfer first. Attackers do not wait for yours — they
fabricate one.**

Anyone can call a contract that emits a `Transfer` log naming *you* as the sender. No approval, no
signature, nothing you can refuse. Your history then shows a payment to an address you have never
paid, and every wallet renders it as a payment you made.

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

**A hold nobody hears about is only a delay.** The watcher alerts the owner *and* the guardian
within a poll, with a one-click cancel link that lands on the transfer. An alert is never sent
twice and a failure is never dropped, because a user who stops watching for themselves on the
strength of a promise deserves that promise kept.

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
| `contracts/` — policy, 7702 delegate, vault, factory | Built. 53 tests: unit, fuzz, invariant. 92.8% lines, 64.6% branches |
| `packages/engine/` — fingerprints, heuristics, scoring | Built. 65 tests including property tests |
| `packages/chain/` — history with signer resolution, policy reads | Built. Shared by the app and the indexer |
| `apps/web/` — Scan, Send, Pending | Built. Scan reads mainnet directly and resolves signers; Send and Pending drive a deployed policy |
| `apps/indexer/` — hold watcher, alerts, risk API | Built. 17 tests on alert idempotency and resume |
| `apps/extension/` — clipboard guard | Not started |
| `analysis/` — replay against real mainnet cases | Built. Verifies the 2024 WBTC case from chain, measures live poisoning volume, replays the shipped detector |

Not audited. Branch coverage is the weakest number here and the first place a reviewer should
look.

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
apps/extension/     Clipboard guard
apps/indexer/       Watches for holds, tells the owner and the guardian, serves risk queries
packages/chain/     Reading history and policy state. One implementation of "check the signer"
analysis/           Replaying the detectors against real cases
docs/               architecture.md, threat-model.md
```

## License

MIT.
