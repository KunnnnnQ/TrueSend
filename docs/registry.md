# The community registry

An EAS resolver for reports about address poisoning, built around one number from `analysis/`:

> In 1200 blocks of mainnet USDT, **5,665** distinct lookalike addresses were planted — by **18**
> distinct addresses, one of which accounted for **86%** of them.

A registry of lookalikes would need thousands of entries a day, each useful to one victim once. A
registry of *planters* needs a handful, and each entry covers everyone they go on to target. So
the primary subject of a report is the planter, not the lookalike.

## What the chain can prove, and what it cannot

This is the line the whole design turns on, and the contract is built to sit exactly on it.

**A `Lookalike` report is provable.** Two addresses either share the leading and trailing
characters a wallet shows, or they do not. `PoisonRegistry.isLookalike` decides it on chain, and
an attestation that fails is **rejected outright** — it never reaches the registry. That half
needs no trust at all.

**A `Planter` report is not provable.** Establishing that an address signed a transaction which
emitted a fabricated `Transfer` log would mean re-executing a past transaction, which no resolver
can do. Those reports carry an evidence transaction hash for a human or an indexer to check, and
the contract records who said it and counts distinct reporters — and deliberately does not
pretend to have verified anything.

Verified against a live local deployment:

```
isLookalike(poisoned, alice)  = true
isLookalike(unrelated, alice) = false

a false lookalike claim  -> rejected by the resolver: NotALookalike
a true lookalike claim   -> accepted, verified = 1
a planter report         -> accepted, verified = 0
```

## The griefing problem, and the cap

Attesting is permissionless. It has to be — a registry only one party can write to is that
party's blocklist, not a community's. But that also means **anyone can report anyone**, including
a legitimate address, and a hundred "independent" reporters costs a hundred fresh addresses.

A registry that could condemn an address by itself would be a griefing tool pointed at exactly the
people this project exists to protect. So the scoring refuses to let it be one:

| | |
| --- | --- |
| A proven report | 25, plus 4 per extra reporter |
| An unproven report | 14, plus 4 per extra reporter |
| **Any number of reports, with nothing else** | **capped one point below `danger`** |

The cap holds over the *combination*, not one finding. Capping the report's own weight would not
be enough: a brand-new address also carries `no-history-at-all`, and report-plus-baseline would
clear the threshold between them — which, since "never seen before" is the default state of every
address a user has not paid, would mean a handful of attestations could condemn any address at
all.

So when nothing but reports and baseline findings are present, the total is held below `danger`.
Any genuine signal alongside them — a lookalike in the user's own history, a fabricated record, an
empty transfer — lifts the cap, because then the reports are corroborating something rather than
standing alone.

`packages/engine/test/risk.test.ts` holds the line, including over a million reporters.

What would lift the cap is identity or cost behind a report: a stake that can be slashed, or
attestations from reporters who are themselves attested. Neither exists yet, so neither is
assumed.

## The schema

```
address subject, uint8 role, address imitates, bytes32 evidence
```

| Field | |
| --- | --- |
| `subject` | Who is being reported. Cannot be the reporter. |
| `role` | `1` planter, `2` lookalike. `0` is refused. |
| `imitates` | Required for `lookalike`, and **refused** for `planter` — a planter report naming an imitated address would read as though the pairing had been checked, and nothing here can check it. |
| `evidence` | A transaction anyone can go and look at. Recorded, never checked. |

Reports are revocable. A count that only ever grows stops meaning anything, so a reporter who was
wrong can take it back, and the resolver decrements on revocation.

## Counting

The resolver publishes three numbers per subject: total live `reports`, distinct `reporters`, and
how many were `verified`.

**Distinct reporters is the one worth weighting by.** One address can attest as many times as it
likes; the tally counts it once, and `test_repeatedReportsFromOneAddressCountAsOneReporter` says
so. That does not solve sybils — nothing cheap does — which is why the cap above exists on top.

## Deploying

EAS is already on mainnet and Sepolia, so only the resolver is deployed and the schema registered:

```bash
forge script script/RegisterSchema.s.sol --account truesend-deployer --rpc-url sepolia --broadcast
```

The EAS addresses in that script were confirmed on chain, not copied from documentation: calling
`getSchemaRegistry()` on each EAS instance returns exactly the registry address used beside it, on
both networks. One call, and this project has already been caught out once by trusting a
remembered address.

A local chain has no EAS, so `LocalEas.s.sol` stands the whole stack up at once:

```bash
anvil
```

```bash
forge script script/LocalEas.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```

## Tests

Seventeen, in `contracts/test/PoisonRegistry.t.sol`, driven through a **real EAS deployment**
rather than a mock. The one thing this contract does that cannot be checked anywhere else is
reject an attestation, and a rejection that does not actually reach EAS is not a rejection.

One of them exists to keep two codebases in step: `MIN_AFFIX_NIBBLES` on chain and
`MIN_AFFIX_MATCH` in `packages/engine` are the same rule in two languages, and if either moves
without the other the registry starts accepting claims the app will not show, or rejecting ones it
will.
