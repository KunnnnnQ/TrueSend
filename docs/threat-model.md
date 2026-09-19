# Threat model

This document says what TrueSend defends against, what it does not, and where each claim is
pinned down by a test. It is written to be argued with. A security tool whose limits are vague is
worse than one with narrow, stated limits, because users calibrate their behaviour to what they
think it covers.

## The attack

Address poisoning works on the gap between the address a user *checks* and the address they
*use*.

There are two variants, and the second is the dangerous one.

1. The victim pays someone — often a deliberate small "test transfer" first, because that is the
   advice everyone gives.
2. A bot watching the chain sees the payment and grinds out an address whose leading and trailing
   hex characters match the real recipient's. Vanity grinding at this length is cheap and fast.
3. The bot sends a zero-value or dust transfer from that address to the victim, frequently using
   a token whose symbol renders as `USDT` but is not spelled with those letters. The transfer now
   sits in the victim's history looking like a real counterparty.
4. Later the victim copies the recipient from their history, sees `0xAb58c4…0e93`, and it matches
   what they remember. They send the real amount to the attacker.

The cruelty of it is that step 1 is the safety advice. Doing the recommended thing is what creates
the opening.

**The second variant does not wait for step 1 — it fabricates it.** Anyone can call a contract
that emits a `Transfer` log naming someone else as the sender. No approval, no signature, no
cooperation from the victim. Their history then shows an outgoing payment to the attacker's
address that they never made, and a wallet built by believing logs renders it as a payment they
did make.

That is what happened in the May 2024 case that cost 1155 WBTC. The victim did not make a test
transfer; a third party fabricated the record of one on a token contract whose symbol is `ETH`,
73 minutes before the victim sent the real funds. Every step of that is re-derived from chain and
asserted by `analysis/src/verify-wbtc-case.mjs`.

It is also not rare. In one 1200-block window of mainnet USDT, 7,592 of 7,601 zero-value
transfers — 99.88% — were signed by somebody other than the address they name as the sender, and
5,121 distinct addresses had a fabricated payment planted in their history. See
`analysis/README.md`.

A test transfer never verified that an address is *correct*. It only ever verified that an
address is *reachable*.

## What TrueSend actually changes

Two independent mechanisms, because either alone is defeatable.

**A revocable hold on chain.** A transfer to a recipient the account has not trusted is queued
rather than settled. During the hold, the owner or a guardian can drop it. The protection does not
depend on the user noticing anything at the moment they sign — it buys back the time the attack
relies on them not having.

**A fingerprint a person can actually check.** Four BIP-39 words and a symmetric glyph derived
from the address. The attacker's address and the real one render identically in every wallet;
their phrases do not. This is the part that lets a user *decide* during the hold.

The detection engine sits alongside both, scoring and explaining. It is the least load-bearing
piece on purpose: heuristics can be evaded, and a design that rests on them is a design that fails
quietly when they are.

## Defended

| Threat | Mechanism | Pinned by |
| --- | --- | --- |
| Paying a ground-out lookalike copied from history | Cooldown; fingerprint mismatch; `lookalike-of-known-payee` | `test_sendToUnknownRecipient_isQueuedNotSettled`, `risk.test.ts` |
| An impulsive or coerced transfer | Cooldown plus guardian veto | `test_cancelQueued_byGuardian` |
| Attacker adds themselves to the contact list, then sends | Trust only activates after `trustDelay` | `test_addTrusted_doesNotTakeEffectDuringDelay` |
| Attacker disables the cooldown and drains in one transaction | Loosening a policy is itself queued behind the current cooldown | `test_setCooldown_cannotBeLoweredWithoutWaiting` |
| Attacker front-runs `initialize` on a freshly delegated EOA | Only a self-call may initialize | `test_initializeCannotBeFrontRun` |
| Guardian turns hostile and holds the account hostage | Guardian cannot move funds and cannot veto its own replacement | `test_guardianCannotBlockItsOwnReplacement`, `test_guardianCannotMoveFunds` |
| A future delegate corrupting this one's storage | ERC-7201 namespacing, asserted against slot writes | `test_writesStayInsideTheNamespace` |
| Fake `USDT` used to plant the address | Homoglyph, mixed-script and invisible-character checks | `tokens.test.ts` |
| A fabricated outgoing payment planted in the history | `spoofed-outgoing-transfer`, the highest-weighted rule and the only one that is a fact rather than an inference | `risk.test.ts`, `analysis/src/evaluate-engine.mjs` |
| A token contract impersonating the native currency | `impersonates-native-asset` | `tokens.test.ts` |
| A recipient contract reentering during settlement | Transient-storage reentrancy guard | `test_reentrantRecipientCannotReplayATransfer` |

The strongest single statement is the invariant: across arbitrary orderings of sends, cancels,
trust changes, cooldown changes and waiting, **every wei that left the vault either went to a
recipient whose trust delay had fully elapsed, or sat in the queue until its unlock time.**
(`invariant_everyPayoutWasTrustedOrWaitedOutItsCooldown`.)

## Not defended

### The EIP-7702 mode is a safe default path, not a lock

This is the most important limitation and the easiest one to overstate in a pitch.

EIP-7702 changes what happens when someone **calls** the EOA. It does not remove the key's ability
to **originate** an ordinary transaction. A key holder can still sign a plain
`token.transfer(attacker, amount)` straight from the address, and it never touches the delegate.

No delegate can prevent this. It is a property of the EIP, not a gap in this implementation.

So the scoped claim for `GuardedAccount` is: every payment routed through the account interface —
which is what this app, the extension, and any integrating wallet do — is subject to the cooldown,
the guardian veto and the alerts. Users who want the policy to be unbypassable by construction use
`SafeVault`, where the funds sit behind the policy rather than beside it.

Two tests assert the limitation directly rather than leaving it to prose:
`test_documentedLimitation_rawTransferBypassesThePolicy` and its native-ETH twin. If a future
change ever made them fail, that would be a finding worth investigating, not a win.

### A stolen key buys time, not safety

If an attacker has the key, they can queue transfers, queue a guardian removal, wait, and drain.
The guardian can veto individual transfers and the queued removal is visible, so the owner has
roughly two cooldown periods to react — but if the legitimate owner cannot move the funds faster
than the attacker, nothing here saves them. Key compromise is out of scope; the cooldown converts
an instant loss into a window.

The guardian was deliberately *not* given the power to block its own replacement. That would
defend the stolen-key case slightly better at the cost of letting a guardian hold the account
hostage forever. Griefing by a chosen guardian was judged the worse failure.

### The user can re-delegate

A 7702 account can sign a new authorization pointing anywhere, including to a contract with no
policy. TrueSend cannot prevent that and does not try. Mitigation belongs at the wallet layer,
which is why "an authorization translator that explains what a delegation grants" is listed as
future work rather than claimed as solved.

### The fabrication rule depends on the indexer

`spoofed-outgoing-transfer` fires on a fact — a transfer log naming the user as sender in a
transaction the user did not sign — but only an indexer that resolves `tx.from` can supply that
fact. An indexer that believes logs reports the fabrication as a genuine payment, and the engine
then has nothing to go on: replayed against the WBTC case, it scores `safe` with no findings at
all. `AddressSighting.spoofedOutgoingCount` is a required field precisely so that this cannot be
skipped by accident, but a wrong value silently disarms the strongest rule in the set.

### Heuristics are evadable

The scoring rules are public and an attacker can read them. An address that has never sent dust,
never appeared right after a payment, and is not yet reported will score low. That is why the
cooldown does not consult the score: a transfer to an unknown recipient is held regardless of what
the engine thinks of it. The score changes what the user is *told*, never what the contract
*allows*.

### Not audited

Tested, linted, fuzzed and invariant-checked, but not reviewed by a third party. Branch coverage
is around 65%, which is the weakest number in the repo and the honest place to point a reviewer
first.

## Assumptions

- The chain orders transactions honestly; proposer timestamp drift is bounded at a few seconds,
  which is irrelevant against cooldowns measured in hours.
- The user can reach *some* interface during the hold — the app, an alert, or a guardian. A
  cooldown nobody watches still helps, because the transfer does not settle on its own, but the
  guardian and the notification path are what turn it from a delay into a defence.
- ERC-20 tokens behave like ERC-20 tokens. Fee-on-transfer and rebasing tokens will deliver less
  than the queued amount; the policy does not currently model that.
