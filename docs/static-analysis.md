# Static analysis

Slither 0.11.6 over `contracts/`. The deliverable is not a clean report — it is a considered
response to every finding, including the ones that are wrong and the ones the tool cannot see.

```bash
cd contracts && slither . --compile-force-framework foundry \
  --config-file ../slither.config.json --fail-pedantic
```

Exit code 0 means every detector that fired is triaged below. `--fail-pedantic` fails the run on
*any* result, including informational, so a detector that starts firing tomorrow fails CI rather
than appearing in a log nobody reads. `slither.config.json` is the only filter list.

## What is in scope, and why

`filter_paths: "lib/|test/|script/"`.

Unscoped, Slither reports 86 results over 29 contracts; scoped to `src/`, 2 — both false positives,
both now suppressed in the code. Everything filtered out comes from `lib/openzeppelin-contracts`
and `lib/eas-contracts`, which are vendored, pinned, unaudited by this project and, in the case of
EAS, not ours to change: `contracts/foundry.toml` pins solc to 0.8.28 specifically because EAS pins exactly
that, and a finding inside a dependency there is not actionable here.

Scoping to `src/` is also the only way to get a signal that means anything. An unscoped run is
dominated by `Math.mulDiv`'s Newton–Raphson loop being read as divide-before-multiply (eight
separate reports) and by 30-odd assembly sites inside OpenZeppelin. A report that is mostly noise
gets skimmed, and a skimmed report is worse than none.

## Findings in our code

Both are `incorrect-equality`, both in `PolicyLib`, both suppressed inline with the reasoning next
to the line rather than here.

| Detector | Site | Disposition |
| --- | --- | --- |
| `incorrect-equality` | `PolicyLib.spentToday` — `s.day == today()` | False positive. Suppressed in code. |
| `incorrect-equality` | `PolicyLib.tryConsumeAllowance` — `s.day == day` | False positive. Suppressed in code. |

**Why they are false positives.** `Spend.day` is written in exactly one place —
`tryConsumeAllowance` — and always as `today()` at that moment. It is therefore always either the
current day or an earlier one; there is no third state, and no interval between two day numbers for
a value to land in. Equality means "same day", inequality means "the stored total is from a previous
day and no longer counts", and the branch that fails the comparison resets the total to zero. The
detector's general concern — a strict comparison against a value that moves — would apply if `day`
could hold a *later* day than `today()`, which it cannot.

Suppressed at the line rather than by adding `incorrect-equality` to the config, because a
project-wide disable would also silence a genuine instance anywhere else in `src/`. That is the
difference between triage and a filter.

## Detectors excluded project-wide

Each of these fires on the whole codebase for a structural reason, so the reason is recorded once
here and the detector is off in `slither.config.json`.

### `timestamp` — 8 sites, and the mechanism itself

`block.timestamp` is compared in `executeQueued`, `applyCooldownChange`, `applyGuardianChange`,
`applyDailyLimitChange`, `isTrustedActive`, `spentToday`, `wouldSettleInstantly` and
`tryConsumeAllowance`. This is not incidental: the cooldown *is* a timestamp comparison, and a
detector that fires on every line of the policy's core mechanism is telling us what the contract is
for.

Drift is bounded at a few seconds; the shortest cooldown the contracts accept is one second and the
intended values are hours. The same reasoning is already written in `contracts/foundry.toml`'s
`exclude_lints = ["block-timestamp"]`, which keeps the two linters from disagreeing about the same
line.

### `assembly` — 2 sites, the ERC-7201 namespace

`GuardedAccount._policy()` and `SafeVault._vault()` set a storage pointer to a constant slot. That
is what ERC-7201 namespacing *is*, and there is no Solidity syntax for it. Both carry a comment
explaining that these slots are written into the user's own account under 7702, and
`test_writesStayInsideTheNamespace` records every slot written during real operations and fails if
anything lands near the bottom of the space. The risk the detector names — hand-written assembly
being unauditable — is covered by a test that asserts the property directly.

### `low-level-calls` and `arbitrary-send-eth` — 2 findings, 1 site

`GuardedBase._moveOut` uses `payable(to).call{value: amount}("")` for the native path. Both
detectors point at line 400.

`low-level-calls` is unavoidable: there is no other way to send native value, and the alternative
(`transfer`) is capped at 2300 gas and would break recipients with a `receive` that logs. The
codebase already carries a `forge-lint: disable-next-line(arbitrary-send-eth)` with its reasoning —
only the owner can reach this, and the policy has already cleared the recipient.

One distinction worth stating because it cuts the other way: `arbitrary-send-eth` treats "arbitrary
destination" as the risk. Here the destination *is* attacker-chosen in the sense that a recipient is
a user-supplied address, and that is the feature. What makes it safe is that reaching the call at
all requires clearing `onlyOwner` **and** the trust delay **and** the daily allowance, or else a
full cooldown period. The invariant campaign
(`invariant_everyPayoutWasTrustedOrWaitedOutItsCooldown`) is the real evidence, and no static
analyser can supply it.

### `locked-ether` — 1 site, inherited from EAS

`PoisonRegistry` has payable functions and no way to withdraw ether. All of them are inherited from
EAS's own `SchemaResolver`: `attest`, `multiAttest`, `revoke`, `multiRevoke` and `receive`. This
codebase's contribution is `onAttest`/`onRevoke`, neither of which is payable and neither of which
touches `msg.value`.

The consequence is bounded and not a loss of user funds in any real sense: EAS forwards a value
attached to an attestation to the resolver, and a sender who attaches one by mistake leaves it
there. `AttestationRequestData.value` exists precisely so that this is an explicit instruction
rather than an accident, and the Report screen sends `0` deliberately. Adding a sweep function would
mean a permissionless resolver with a withdrawal path, which is a worse contract than one that
cannot hold anything by accident.

## What Slither cannot see here

This section is the point of the exercise. Three of these are places where a clean report would be
misread as a safety claim.

### It does not know about EIP-7702, so `GuardedAccount` is analysed as an ordinary contract

Under 7702 the delegate's code runs *as* the EOA, so `_owner()` is `address(this)`, `onlyOwner`
resolves to `msg.sender == address(this)`, and the wallet installs the delegation and calls
`initialize` in one transaction. Slither sees an ordinary deployed contract with a virtual
`_owner()`, no delegation, and no way to reason about "the account can call itself". It also cannot
see the property that matters most about this mode: the key can still sign a raw transfer that never
reaches the delegate. That limitation is asserted by two named tests, not by static analysis, and it
is the reason `docs/threat-model.md` scopes the claim to payments routed through the account
interface.

The one place this showed up in the output is `_initializePolicy`, where the `forge` linter — not
Slither — wanted the event emitted before the `_owner()` read, because it conservatively treats a
virtual call as external. Both implementations resolve to a storage read or `address(this)`.

### Its reentrancy detector does not recognise `ReentrancyGuardTransient`

**This is the finding of this task, and it is a finding about the tool.**

`GuardedBase` inherits OpenZeppelin's `ReentrancyGuardTransient` and every external entry point that
moves funds carries `nonReentrant`. Slither's four reentrancy detectors report nothing on `src/`.
That looks like confirmation. It is not, and the difference was established by experiment rather
than assumed:

A probe contract was added under `src/` — temporarily, and removed again — inheriting the real
`GuardedBase` and exposing two external functions with identical bodies: one calling `_moveOut` with
no modifier, one with `nonReentrant`. Run with `--detect reentrancy-eth,reentrancy-no-eth,
reentrancy-benign,reentrancy-events`:

```
Reentrancy in ReentrancyProbe.probeUnguarded(address,uint256) (src/_slither_probe/ReentrancyProbe.sol#33-37)
Reentrancy in ReentrancyProbe.probeGuarded(address,uint256) (src/_slither_probe/ReentrancyProbe.sol#40-44)
```

**Both.** The guard that works is reported exactly like the one that does not. Slither recognises
`ReentrancyGuard` — the storage-slot version — by matching its revert string; the transient variant
reverts with a custom error (`ReentrancyGuardReentrantCall`), and the pattern does not match. So for
this codebase the reentrancy detectors are not weak, they are absent, and a green `slither` run says
nothing whatever about reentrancy.

That left a real question, which the probe answered by accident: if Slither cannot see the guard,
why is production clean? **Because of operation ordering, not because of the guard.**
`reentrancy-eth` fires on a state write *after* an external call. In `GuardedBase`:

- `send` returns immediately after `_moveOut`; nothing follows it.
- `executeQueued` sets `status = Executed` and emits, and only then calls `_moveOut` — checks,
  then effects, then interactions.

So there is no state write after the call for the detector to find, and the conclusion happens to be
right for a reason unrelated to the mechanism doing the work. That is exactly the kind of
coincidence that makes a clean report dangerous: it would survive the guard being deleted.

The guard's actual evidence is a test, not a tool: `test_reentrantRecipientCannotReplayATransfer`
drives a recipient contract that reenters during settlement and asserts the replay fails. Anyone
changing this code should treat that test — not the Slither run — as the reentrancy gate.

### It cannot see `SafeVault.initialize`'s real protection

`SafeVault.initialize` binds the owner and switches the policy on, and it is externally callable.
Slither's uninitialized-state and access-control detectors did not fire, which is luck rather than
analysis: what makes it safe is that `SafeVaultFactory.deploy` calls it in the same transaction as
`Clones.cloneDeterministic`, so an uninitialised vault never exists on chain to be raced. A contract
that is never deployed except by that factory is safe because of the factory, and there is nothing in
`SafeVault.sol` for a static analyser to read. This is why `SafeVault` is documented as
factory-deployed rather than as independently deployable.

### It cannot see the cross-language constants

`PoisonRegistry.MIN_AFFIX_NIBBLES` (Solidity) and `MIN_AFFIX_MATCH` (TypeScript, in
`packages/engine`) are the same rule written twice. If one moves without the other, the registry
starts accepting claims the app will not show, or rejecting ones it will.
`test_affixThresholdIsFourCharactersEachEnd` and `test_isLookalikeMatchesTheRuleTheEngineUses` hold
them together. No analyser crosses that boundary, and the Report screen's pre-flight check depends
on the equality.

### It sees none of the off-chain invariants this project rests on

The two claims the whole project rests on are about `tx.from` resolution — 99.88% of zero-value USDT
transfers in a sampled window were signed by someone other than the address they name, and the May
2024 WBTC loss was caused by a *fabricated* test transfer rather than a real one. Those live in
`analysis/`, are verified against chain, and are invisible to any Solidity analyser. Likewise the
scoring cap that keeps a permissionless registry from condemning an address
(`packages/engine/test/risk.test.ts`, over a million reporters) is a TypeScript property.

## Honest summary

| | |
| --- | --- |
| Findings in `src/` | 2, both false positives, both suppressed inline with reasoning |
| Real bugs found | **none** |
| Detectors excluded project-wide | 5, each with a structural reason above |
| Third-party findings filtered | 84 of 86, in `lib/` |
| Detector classes that are effectively absent for this code | reentrancy (see above) |

The honest headline is that Slither found nothing wrong with these contracts, and the most useful
thing it produced was the discovery that its reentrancy analysis is not running in any meaningful
sense. The reentrancy guarantee here comes from a test and from checks-effects-interactions
ordering, and now says so in writing.

The precedent for reading a clean report carefully is already in this repository's history: branch
coverage was 64.6% and read as a pass until a report named the eighteen untaken branches, and every
one turned out to be an error path — the guards that matter most in a contract whose job is refusing
things. A green number is a prompt to look, not a finding.

## Dependencies (`pnpm audit --prod`)

Run on 2026-10-08, it reported eleven advisories against the production dependencies, five of them
high. None reached the live demo, which is a static export: each was in build tooling, in a server
feature a static site does not have, or in a wallet library the app never bundles — the shipped
JavaScript was searched for each one. They were cleared anyway, because a report that always shows
eleven is a report nobody reads on the day it shows twelve.

| Advisory | Where it was | What was done |
| --- | --- | --- |
| postcss, three (two high); source-map-js (high) | Next's CSS build, run on this repository's own CSS | Next's `postcss` raised to ^8.5.23 and `source-map-js` to ^1.2.2 (`pnpm.overrides`) |
| sharp (high) | Next's image optimiser, which a static export never runs; nothing here uses `next/image` | Not installed (`pnpm.ignoredOptionalDependencies`) |
| ws, two (one high) | A copy of viem inside WalletConnect | Raised to ^8.21.0 |
| uuid | The MetaMask SDK | Raised to ^11.1.1 |
| decode-uri-component | `query-string`, inside WalletConnect | **Accepted** (`pnpm.auditConfig.ignoreGhsas`) |

The accepted one has two reasons, and both have to stay true. WalletConnect is never bundled: the
app finds wallets through EIP-6963 and does not import `wagmi/connectors` (see `providers.tsx`). And
the fixed release is ES-module-only, which `query-string` 7 cannot load, since it `require`s it — so
forcing it would break the one code path that uses it, should that path ever ship.

Next itself went from 15.5.25 to 15.5.27. Next 16 carries the fixed postcss itself, but it is a major
version and was not taken for this. After the change: every unit test, both builds, and the browser
tests on the Pages export passed, and `pnpm audit --prod` reports only the accepted advisory.
