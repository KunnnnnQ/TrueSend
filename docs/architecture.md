# Architecture

## The organising rule

**The guarantee lives on chain. The judgement lives off chain.**

The contracts hold a transfer to an untrusted recipient and let it be cancelled. That is a small,
auditable state machine with no opinions about whether any particular address is suspicious. The
detection engine forms opinions, ranks them and explains them, and its output never reaches the
contract.

This split is what makes the system fail safely. If the indexer is down, the API is wrong, the
extension is uninstalled and the frontend is served by an attacker, the hold still happens and the
cancel button still works, because neither depends on anything off chain. Conversely, an attacker
who evades every heuristic gains nothing at the contract layer: an unknown recipient is held
regardless of score.

A design where the contract consulted a risk oracle would invert this. It would make the oracle a
single point of failure for funds, and it would make every heuristic a consensus-critical
decision.

## Layers

```
┌──────────────────────────────────────────────────────────────────────┐
│ Web app (Next.js)          Browser extension (clipboard guard)       │
│   Scan · Send · Pending · Contacts · Report · Upgrade                │
├──────────────────────────────────────────────────────────────────────┤
│ Risk API + alerts          ← queued transfer? tell the owner and     │
│                              the guardian, with a cancel link        │
├──────────────────────────────────────────────────────────────────────┤
│ Indexer     ERC-20 Transfer (incl. zero-value) · policy events       │
│             · community attestations                                 │
├──────────────────────────────────────────────────────────────────────┤
│ @truesend/engine    fingerprints · heuristics · explainable scoring  │
│                     pure functions, identical in all three consumers │
├──────────────────────────────────────────────────────────────────────┤
│ GuardedAccount (EIP-7702)      SafeVault (custodial)                 │
│              └── GuardedBase ── PolicyLib ──┘                        │
└──────────────────────────────────────────────────────────────────────┘
```

## Contracts

`PolicyLib` holds the storage layout and the pure rules. `GuardedBase` implements the state
machine against a `Policy storage` pointer and two hooks — where the policy lives, and who the
owner is. Two concrete modes fill those in:

- **`GuardedAccount`** is the code an EOA delegates to under EIP-7702. `_owner()` is
  `address(this)`, so every owner-gated call is a self-call from the EOA. Zero migration.
- **`SafeVault`** is an ordinary contract that holds the funds, deployed as a minimal-proxy clone.
  `_owner()` is a stored address. The policy is unbypassable because the funds are behind it.

One state machine, two custody models. `SafeVault` also serves as the fallback demo path: it needs
nothing from the delegation tooling and works on any EVM chain.

### Why the asymmetry rule is everywhere

Every setter follows one rule: **tightening applies immediately, loosening is queued behind the
current cooldown.** Raising the cooldown, lowering a daily cap, revoking trust and appointing a
first guardian all take effect now. Lowering the cooldown, raising a cap and replacing or removing
a guardian all wait.

Without it, the cooldown is decorative — `setCooldown(0)` followed by `send()` in the same
transaction would defeat the entire design. With it, the shortest path from a compromised key to
drained funds is two full cooldown periods, and both are visible on chain as events the guardian
and the alerting path can act on.

### 7702-specific care

Three things a delegate gets wrong easily:

**Storage.** The delegate's slots are written into the user's own account. A layout starting at
slot 0 would collide with any other delegate the user ever installs. Storage is ERC-7201
namespaced, the constant is re-derived and asserted in a test, and another test records every slot
written during real operations and fails if anything lands near the bottom of the space.

**Initialization.** A 7702 authorization is public the moment it lands. Anyone could race to call
`initialize` with a one-second cooldown and a guardian they control. Only a self-call may
initialize; in practice the wallet sends the authorization and the call in one transaction.

**Staying an EOA.** An address that has worked for years must keep accepting inbound value and
must not start reverting on calls with unfamiliar calldata. `GuardedAccount` keeps a payable
`receive` and `fallback`. Breaking someone's incoming payments would be a worse outcome than the
attack being defended against.

The reentrancy guard uses transient storage rather than a persistent slot, so the guard itself
writes nothing into the user's account.

## `@truesend/engine`

Pure functions. No clock — `now` is an input. No network, no storage. That is what lets the same
code run in the Next.js app, inside the extension's content script and behind the API, so a user
warned by the extension and then opening the app sees the same verdict *and the same wording*,
because it is literally the same function deciding.

Three pieces:

- **Fingerprints.** `keccak256(address)` → 44 bits → four BIP-39 words, plus a 5×5 mirrored glyph
  and two colours from separate bytes of the same hash. The glyph exists because hue alone has
  only 360 values; a pair the user is being asked to tell apart is the worst place for a colour
  collision.
- **Heuristics.** Affix matching against addresses the user has *actually paid*, zero-value and
  dust inbounds, the timing tell of an address appearing right after a payment, and homoglyph /
  invisible-character checks on token symbols.
- **Scoring.** A weighted rule table. Weights and thresholds are exported constants so a reviewer
  can disagree with a specific number, and so `analysis/` can retune them against real cases
  without touching the detection logic. Thresholds are calibrated so a first payment to a
  genuinely new address stays quiet — a tool that cries wolf gets switched off, and then it
  protects nobody.

Every finding carries a sentence written for the person about to sign, naming the contact being
imitated and both phrases.

## Indexer and API

The indexer folds a user's history down to one `AddressSighting` per address: how many times they
paid it, how many zero-value and dust transfers it sent them, when it first appeared. That summary
is small enough to hand to a browser extension that has to decide in the time it takes someone to
paste an address.

The alerting path is what turns a cooldown from a delay into a defence. A queued transfer is only
useful if someone learns about it while it is still queued, and the person may not be at their
computer — so a queued transfer notifies the owner and the guardian with a one-click cancel link.

## Address book

`forge script script/Deploy.s.sol` writes `contracts/deployments/<chainid>.json`, which the app
and the indexer read directly. No address is ever transcribed by hand between the contracts and
the frontend.

## What is built

See the status table in the [README](../README.md). Contracts and engine are complete and tested;
the app, indexer and extension are not yet started.
