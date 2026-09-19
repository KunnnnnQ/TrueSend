# TrueSend

**Everyone is told to send a small test transfer first. That test is what the attacker is waiting
for.**

Address poisoning turns the standard safety advice into the attack surface. You pay someone, a bot
sees it, grinds out an address matching the leading and trailing characters your wallet shows, and
sends you a zero-value transfer so it lands in your history. Next time you copy the recipient from
that history and the money is gone.

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

**Scores explain themselves.** Every finding carries a sentence naming the contact being imitated
and both fingerprints. A bare number asks for trust; a reason lets the user catch what the rules
missed.

## Status

| Component | State |
| --- | --- |
| `contracts/` — policy, 7702 delegate, vault, factory | Built. 53 tests: unit, fuzz, invariant. 92.8% lines, 64.6% branches |
| `packages/engine/` — fingerprints, heuristics, scoring | Built. 41 tests including property tests |
| `apps/web/` — Scan, Send, Pending, Contacts | Not started |
| `apps/indexer/` — event indexing and risk API | Not started |
| `apps/extension/` — clipboard guard | Not started |
| `analysis/` — replay against real mainnet cases | Not started |

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
apps/web/           Next.js
apps/extension/     Clipboard guard
apps/indexer/       Event indexing + risk API
analysis/           Replaying the detectors against real cases
docs/               architecture.md, threat-model.md
```

## License

MIT.
