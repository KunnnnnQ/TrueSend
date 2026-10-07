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
│   Scan · Send · Pending                                              │
├──────────────────────────────────────────────────────────────────────┤
│ Indexer      hold watcher → alerts to owner and guardian,            │
│              with a one-click cancel link · risk API                 │
├──────────────────────────────────────────────────────────────────────┤
│ @truesend/chain    transfer history WITH SIGNER RESOLUTION ·         │
│                    policy reads. Fetches, never decides.             │
├──────────────────────────────────────────────────────────────────────┤
│ @truesend/engine   fingerprints · heuristics · explainable scoring.  │
│                    Pure. Decides, never fetches.                     │
├──────────────────────────────────────────────────────────────────────┤
│ GuardedAccount (EIP-7702)      SafeVault (custodial)                 │
│              └── GuardedBase ── PolicyLib ──┘                        │
│ PoisonRegistry — an EAS resolver. Proves what it can, counts the     │
│                  rest, and decides nothing.                          │
└──────────────────────────────────────────────────────────────────────┘
```

The split between the two packages is load-bearing. The engine is pure, so the same verdict and
the same wording reach the app, the extension and the API. `@truesend/chain` holds everything that
needs a node — above all the signer resolution described below, which exists in exactly one place
because two implementations of "check who signed it" is one implementation that eventually
forgets to.

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

**It must resolve who signed each transaction.** A `Transfer` log naming an address as the sender
is not evidence that address sent anything — anyone can call a contract that emits one, and in
practice almost everyone does: 99.88% of zero-value USDT transfers in a sampled window were signed
by somebody other than the address they name. Counting those as payments does not merely lose a
signal, it inverts one, because a fabricated outgoing record makes an attacker look like a payee
the user already trusts. Resolving `tx.from` is therefore a requirement of this layer rather than
an optimisation, and `analysis/` measures what it costs to get it wrong.

**And it must say when it could not.** Resolving a signer is a request per transaction, and public
endpoints refuse some of them under load. A transfer whose signer or block time never comes back,
even when asked again one at a time, is returned as `unchecked` and folded in as `uncheckedCount`:
neither a payment nor a fabrication, but enough to make its address a caution and the whole scan
"incomplete". Dropping it instead, as this layer once did, let one refused lookup turn the May 2024
attacker into "Looks fine". Where an endpoint puts each block's time on its logs, the scan does not
ask for blocks at all.

The alerting path is what turns a cooldown from a delay into a defence. A queued transfer is only
useful if someone learns about it while it is still queued, and the person may not be at their
computer — so a queued transfer notifies the owner and the guardian with a one-click cancel link
that lands on that transfer.

The watcher polls rather than subscribing. A dropped websocket reconnects at the head and silently
skips whatever happened while it was away; a cursor on disk resumes exactly where it stopped, and
for a component whose job is to not miss one event, resumability beats latency. Alerts are keyed
on `(chain, policy, transfer, channel)`, so a delivered one is never repeated and a failed one is
retried — missing an alert is the failure that matters, a duplicate is merely annoying.

Per-user history is built on demand rather than indexed globally. Logs are filtered by the user's
address on the node, so it is a few requests; a global index of every ERC-20 transfer is real
infrastructure and claiming one would be architecture theatre. `apps/indexer/README.md` is explicit
about what is and is not there.

## Address book

`forge script script/Deploy.s.sol` writes `contracts/deployments/<chainid>.json`, which the app
and the indexer read directly. No address is ever transcribed by hand between the contracts and
the frontend.

## What is built

See the status table in the [README](../README.md): every layer above is built and tested, and none
of it is audited.
