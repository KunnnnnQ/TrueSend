# Prior work

This project is a hackathon entry and the rules require original work. Naming the prior work is
not in tension with that — it is how you tell original work from work that reinvents a wheel
badly. Everything in this repository was written from scratch during the contest; several of the
rules in it turned out to restate a published standard, and one measurement turned out to
corroborate a peer-reviewed finding I had not read. Both are worth saying out loud.

## What was actually verified

I read **abstracts**, fetched from the publishers and quoted below — plus the **full text** of
arXiv:2501.16681, which §2 needed and which changed what §2 says. I have **not** read the full
texts. Everything attributed to a paper here appears in its abstract; nothing is attributed on
the strength of a search-result snippet, and there are figures floating around in snippets —
"14 million phishing transfers", "1.44 million benign addresses" — that are plausibly from these
papers' bodies and are deliberately not cited, because I did not see them in a source.

This matters for exactly one claim later on, about timing, and it is flagged where it appears.

---

## 1. Characterizing Ethereum Address Poisoning Attack

Shixuan Guan and Kai Li. ACM CCS 2024, pp. 986–1000. [doi:10.1145/3658644.3690277](https://dl.acm.org/doi/10.1145/3658644.3690277)

The first comprehensive measurement of the attack. Their detector, Poison-Hunter, ran over
Ethereum blocks from **Nov 2022 to Feb 2024**. From the abstract:

> over 1,800 victim addresses have lost crypto assets, with a potential financial loss of up to
> $144 million US dollars. Among them, about $90 million of loss are confirmed by this work.

Two findings in that abstract bear directly on decisions already made in this repository.

**"the sender of legitimate transfers was the primary target of this attack."** This is the same
observation that `analysis/` arrived at from the other direction. The victim is not a passive
address that happened to be scraped — it is an address that *just made a real payment*, and the
attack is timed to that payment. `false-positives.mjs` samples wallets from exactly that
population for the same reason, and the README says so under "What these numbers are not":
sampling active payers is an upper bound, not a typical figure.

**"98% of phishing addresses are controlled by four entities, which collected nearly 92% of the
total profits."** This is the one that matters most. The measurement in `analysis/README.md` —
18 planter addresses accounting for all 7,592 fabricated records in a 1,200-block window, one of
them alone for 86% — is a much smaller window at a different granularity (addresses, not
clustered entities), so the numbers are not comparable. The *shape* is the same, and it was found
independently before I read this.

That shape is the entire argument for `PoisonRegistry` being keyed on the **planter** rather than
on each lookalike. Lookalike addresses are disposable and effectively unlimited; the entity
signing the transactions that plant them is not. A registry that enumerates lookalikes is a losing
race, and a registry of a handful of planters covers most of the attack surface. I had one 4-hour
window as evidence for that design. A peer-reviewed 15-month measurement reaching the same
conclusion is considerably better evidence, and it is not mine.

## 2. Blockchain Address Poisoning

Taro Tsuchiya, Jin-Dong Dong, Kyle Soska, Nicolas Christin. USENIX Security 2025.
[arXiv:2501.16681](https://arxiv.org/abs/2501.16681), 28 January 2025.

Two years, Ethereum and BSC. From the abstract: **270 million on-chain attacks**, **17 million
victims**, **6,633 successful attacks**, at least **$83.8 million** lost.

The ratio is the interesting part and it is easy to read past. Roughly **0.04%** of targeted
victims actually lose funds. This is a low-yield, essentially free, industrially-automated attack
— which explains both why it is ubiquitous and why wallets have been slow to treat it as urgent.
It also sets the bar for any defence: at that base rate, a detector that cries wolf will be
switched off long before it ever encounters the one transfer that mattered. That is why
`analysis/` measures the quiet case at all, and why `evaluate-engine.mjs --check` gates on
"52.5% of sampled wallets saw nothing" alongside the detection rate. A detection number on its
own would be meaningless against a 0.04% base rate.

**On timing — settled, and not in this project's favour.** I flagged this as open and then read
the full text. Section 4.1 defines the detection window:

> we focus on the 20 minutes following the original transfer, which corresponds to blocks n+1 to
> n+m+1 where m=100 and 400 for Ethereum and BSC, respectively

and Section 5.2 defends it: doubling to 200 blocks "captures 1,363 (0.17%) more poisoning
transfers". So the paper does quantify the interval — as a parameter with evidence behind it. No
figure or table I could find plots the delay itself, but Figure 10's caption does mention
"timing" and I could not read the figure, so I am not claiming the distribution is absent.

`analysis/` measures one: median **26 blocks** (~5 minutes), 90th percentile 146, 82% within 50
blocks. That is where `RECENT_PAYMENT_WINDOW_SECONDS` comes from. It is no longer offered as a
contribution.

**The two also disagree, which is worth more than the claim would have been.** If a tenth of
plants really land beyond 146 blocks, widening a 100-block window to 200 should pick up several
percent — not 0.17%. The likeliest reason is that the numbers are anchored differently: their
window opens after *any* transfer the victim makes, so a lookalike planted 300 blocks after one
payment usually falls within 100 blocks of a later one and is already counted. Mine measures to
the specific payment the lookalike imitates. On top of that my scan window is 1,200 blocks, which
truncates long gaps outright — the "longest observed 1,125" is pressed against that edge and is
not a real maximum. I have not resolved it. A reader should treat my percentiles as describing my
sampling frame rather than the attack.

**Concentration, independently, a third time.** Section 5.3 finds **49 attack groups** with more
than one lookalike address, accounting for **97.4%** of poisoning transactions, the top seven or
eight dominating, and Group 1 alone responsible for 1.39 million lookalike addresses. Three
measurements — this, CCS'24's four entities, and this repository's 18 planter addresses in a
four-hour window — agree about where the attack comes from, having been made three different ways.

**What the attackers spend, which sets the bar for the lookalike rule.** Section 7.2 estimates
Group 1 burned "3.0×10^7 CPU-days or 27,093 GPU-days" grinding addresses, reaching a maximum
20-digit match where other groups reach 14. TrueSend's lookalike rule triggers on four leading
plus four trailing hex characters — eight. Real attackers routinely produce more than twice that,
so the threshold sits comfortably below what it has to catch, and a matched pair is even less
likely to be coincidence than the 32-bit arithmetic in `analysis/README.md` suggests.

## 3. Ethereum Crypto Wallets under Address Poisoning: How Usable and Secure Are They?

Shixuan Guan and Kai Li. [arXiv:2508.12107](https://arxiv.org/abs/2508.12107), 16 August 2025.

53 popular Ethereum wallets, evaluated against simulated poisoning. This is the paper that most
directly justifies the project existing, and it is worth quoting at length:

> our evaluation also shows that 16 wallets pose a high risk to their users due to displaying
> fake token phishing transfers. Moreover, our further analysis suggests that most wallets rely
> on transaction activity providers to filter out phishing transfers. However, their phishing
> detection capability varies. Finally, we found that only three wallets throw an explicit
> warning message when users attempt to transfer to the phishing address

**Three of fifty-three.** And a separate finding — 12 wallets have communication failures with
their activity provider and cannot download history at all — says something further: the
filtering is not merely outsourced, it is outsourced to a dependency that is sometimes simply
down.

"Most wallets rely on transaction activity providers to filter out phishing transfers" is the
naive-indexer problem, named from the outside. A wallet that renders whatever its provider
returns is showing the user a history assembled from `Transfer` logs. The central claim in
`analysis/README.md` is that a log naming you as sender is not evidence you sent anything, and
that resolving `tx.from` inverts the signal rather than merely sharpening it: believing the log
makes a fabricated record look like a payee you have already trusted. This paper establishes,
empirically and across the ecosystem, that the layer where that resolution would have to happen
is the layer wallets have delegated away.

That is the gap the project sits in. It is not a claim that nobody has noticed the attack —
clearly they have, three times over — it is that the defence is absent in deployed software, for
a structural reason.

## 4. Unicode Technical Standard #39, Unicode Security Mechanisms

Revision 34, 2026-08-27. [unicode.org/reports/tr39](https://www.unicode.org/reports/tr39/)

The token symbol rules in `packages/engine/src/tokens.ts` were rewritten after three fake USDT
contracts, found by sampling real wallets, defeated a hand-written homoglyph table. The
replacement rested on the observation that a real ticker is plain ASCII. That is not an insight,
it is a restatement of a restriction level the Unicode Consortium published years ago:

> **ASCII-Only:** All characters in the string are in the ASCII range.

Aligning with the standard rather than merely noticing the coincidence found two real faults,
both now fixed and committed:

- **The confusable test folded one side.** The standard says *"X and Y are defined to be
  confusable if and only if skeleton(X) = skeleton(Y)"* — both operands. The code compared a
  folded candidate against a raw canonical entry, which happens to work when every canonical
  ticker is ASCII and is not the rule it claimed to be.
- **The restriction level was computed from a list of three scripts.** Asking "Latin? Cyrillic?
  Greek?" and counting the yeses reported one of the real fakes — a Yi radical spliced into
  `U+A4A4 5 D T` — as single-script, because the only script it could see was the `DT`. That is
  the homoglyph table's mistake one level up: any enumeration of scripts is missing the one the
  attacker reached for. It now counts characters it cannot name, which needs no table.

Findings now carry the restriction level and name the standard, because "this is not ASCII-Only
under UTS #39" is a claim a reviewer can check and "this looks suspicious to me" is not.

**Two deliberate departures**, recorded so they read as decisions rather than bugs:

1. The standard's `skeleton()` normalises with **NFD**, which does not fold fullwidth `ＵＳＤＴ`.
   This code uses **NFKC**, which does. A ticker has no legitimate fullwidth form.
2. The standard defines six restriction levels; this code collapses to three. The middle three —
   Highly, Moderately and Minimally Restrictive — exist to let real identifiers in human languages
   through. A four-letter ticker does not have that problem. Collapsing them would be wrong for a
   username or a domain name and is right here.

## 5. EIP-7702 Phishing Attack

Minfeng Qi, Qin Wang, Ruiqiang Li, Tianqing Zhu, Shiping Chen.
[arXiv:2512.12174](https://arxiv.org/abs/2512.12174), 13 December 2025.

This one is not about address poisoning. It is here because it is about the mechanism this
project's defence is built on, and leaving it out would be the dishonest choice. From the
abstract:

> instead of deceiving users into signing individual transactions, an attacker can induce a
> victim to sign a single authorization tuple that grants unconditional and persistent execution
> control over the account.

`GuardedAccount` installs a cooldown on an existing EOA via exactly that mechanism: the user signs
an EIP-7702 authorization tuple delegating their account to code. The paper describes a phishing
class whose primitive is *getting a user to sign an EIP-7702 authorization tuple*.

So a user who has been taught to sign a delegation to protect themselves has been taught the
habit the attack needs. This is a real cost of the design and it is not fully mitigable by the
contracts — it is a property of the mechanism. What the repository can honestly say:

- `SafeVault` exists as a custodial alternative that requires no delegation at all, so the
  protection does not *require* accepting this risk.
- The delegate uses ERC-7201 namespaced storage precisely because its slots live in the user's own
  account, and the threat model already treats that storage as contested.
- Nothing in this repository asks a user to sign an authorization tuple they did not initiate.

It does not dissolve the tension, and the tension should be stated in the threat model rather than
here. See "Changes this suggests", below.

---

## 6. What Etherscan already does

Not a paper. **Observed**, on 2026-09-26, on the token-transfer page of one account that was being
poisoned at the time (`0x0bcf1545…dc8675`), in a real browser with a real click. Nothing here is
from documentation; if Etherscan documents it differently, the page is what I saw, and it is
recorded because the argument this project makes in its README is wrong without it.

**A copy-time confirmation.** Clicking the copy icon beside one of the attacker's addresses opened a
dialog titled *Before You Copy*:

> The transaction for this token transfer was made by a different address than the sender of the
> token. Verify that this is the address you intend to interact with.

with *Don't show this for 30 days* and *Understand, Copy Address*, and the copy did not happen
until the second. That is this project's central insight — `tx.from` is not the log's `from` —
implemented in the interface of the explorer where most victims copy the address they later pay.
The markup carries a second message on other rows: *a token transfer of low value, which is a
potential sign of an address poisoning attack*. Etherscan is the transaction-activity provider that
paper 3 says wallets depend on, and it already does part of what paper 3 says is missing.

**Labels on addresses it knows.** One of the three lookalikes on that page was displayed as
`Fake_Phishing7859477` rather than as hex.

**Counterfeit-token transfers hidden by default.** A lookalike from this repository's own committed
data (`0x7916cdb1…41c0`) was in the same account's token transfers on Blockscout and absent from
Etherscan's first page; the rows it sat in involve counterfeit USDT contracts. That is an
inference from one account, not something I confirmed from documentation.

### What that changes

The sentence this project leaned on — that the layer where signer resolution has to happen is one
wallets have delegated away — stays true of *wallets*. It must not be widened to explorers, and an
earlier draft of the README's opening read as if it were.

What remains, stated as narrowly as it can be:

1. **The protection is at one site's copy button.** A user who selects the text by hand, or copies
   from a wallet's history view, another explorer or a phone, goes around it. On Blockscout the same
   account's page drew three different attacker addresses as `0x79...41C0`, unlabelled, with no
   warning on the rows I captured. (I did not click through Blockscout's controls; a warning I did
   not see is not proof there is none.)
2. **It is a dialog with a thirty-day dismissal.** It says something about a row. It does not say
   *which address you actually pay* this one imitates, and it cannot be present once the address has
   left the page.
3. **Labels cover what Etherscan already knows.** Of **30** planted lookalike addresses, spread
   across the committed sample and about a week old, **1** carried a label (`analysis/src/etherscan-labels.mjs`,
   with the instrument checked first against a labelled and an unlabelled page). With a sample
   that small the honest range for the true share is roughly 0.6% to 17%, not 3%. It is one
   protection, measured; Etherscan's copy dialog and its hiding of counterfeit tokens are others
   and are not in that number.
4. **None of it can stop a payment.** A dialog is advice.

So this project is not the first to notice the signer mismatch and should not be presented as if it
were. What is left is everything outside one site's copy button — wallets, other explorers, phones —
and the one layer that does not depend on anybody reading a dialog: the hold on chain.

## What is prior art and what is not

Stated plainly, because a hackathon judge should not have to work it out.

**Prior art. Not claimed by this project:**

- That address poisoning exists, is large-scale, and is automated. (CCS'24, USENIX'25)
- That victims are drawn from addresses that just made a legitimate transfer. (CCS'24)
- That the attack is concentrated in a small number of entities. (CCS'24)
- That deployed wallets largely fail to warn, and outsource filtering. (arXiv:2508.12107)
- That ASCII-only is a sound restriction for identifiers, and how to compare confusables.
  (UTS #39)
- The EIP-7702 delegation phishing class. (arXiv:2512.12174)
- **Warning at copy time that a transfer was signed by a different address than the sender**, and
  a low-value-transfer warning, and labels on known attackers. (Etherscan, observed 2026-09-26; §6)

**What this repository adds, as far as I can tell from abstracts:**

- **An implementation, in the layer where it is missing.** Three of 53 wallets warn. This is a
  working signer-aware indexer, detector and UI, with the resolution done rather than delegated.
- **`spoofedOutgoingCount` as a required field.** The fabricated-record signal is not just
  weighted highest, it is structurally impossible for an integrator to omit by accident: an
  indexer that does not resolve signers must write `0` deliberately. This came from the engine
  scoring the verified WBTC case **0/100, `safe`** before the rule existed.
- ~~A measured timing distribution.~~ **Withdrawn.** Reading the full text showed USENIX'25
  quantifies the interval as a 100-block window with evidence for it, and my percentiles disagree
  with theirs for reasons I cannot resolve. See §2. The window in the code is still set from a
  measurement rather than from intuition; it is not a finding.
- **The solver objection, settled against the chain.** A `Transfer` log naming you as sender in
  someone else's transaction is also exactly what a legitimate settlement looks like. The first
  discriminator for this was wrong: it asked whether the wallet had ever *signed* a transfer of
  the token, and receiving a token needs no signature, so it filed every gasless-permit seller
  under "impossible" and returned a clean zero. Replaced by reconciling each record against the
  token's own balances. Of **1,746** unsigned records across 59 wallets, 1,736 were fabrications
  and **ten were not** — seven of those settled through CoW Protocol's settlement contract. The
  engine had been scoring them 71/100 danger, the same score it gives the WBTC attacker, and no
  longer does. I did not find this failure mode discussed in any of the abstracts, which is weak
  evidence of anything; it is here because it would have sunk the headline number if left alone.
- **An on-chain defence.** All three papers characterise or evaluate. None of the abstracts
  describes a contract that holds a first transfer to an unknown recipient. The detector can be
  wrong; the cooldown does not consult it, which is why an unknown recipient is held regardless of
  score.

**What is honestly uncertain:** whether the reconciliation discriminator is novel. That would need
the full texts to settle and it is not load-bearing either way. The timing question is settled,
and it went against this project — see §2.

## Changes this suggested, and where they went

These were recorded rather than made while `docs/threat-model.md` and `README.md` were shared with
a parallel session. That session has finished and all of them are in:

1. **The delegation-signing habit** — `docs/threat-model.md`, "Teaching people to sign
   delegations is teaching them the habit an attack needs", citing arXiv:2512.12174 and pointing
   at `SafeVault` as the path that takes no delegation at all.
2. **"Only three of 53 wallets warn"** — `README.md`'s opening, which it also corrected. The old
   line said *every* wallet renders a fabricated transfer as a payment. The paper that supports
   the argument says 16 of 53 did while most filter through a provider, so the measured version
   is both more accurate and stronger than the sweeping one.
3. **The cry-wolf figures** — `README.md` now quotes the re-measurement, and says the facts behind
   it are checked against the chain rather than asserted.
4. **The CCS'24 concentration finding** — `analysis/README.md`, made at the time.

## A gap this opened, one that closed, and one my own first fix opened wider

Found while measuring the solver false positives, and this section has now been wrong twice in two
different directions — recorded in the order it actually happened, because the sequence is the
point: a fix that looked complete because its own tests were green, was not.

**A smart account's payments are all submitted by somebody else.** An ERC-4337 account's user
operations reach the chain inside a bundler's transaction, so `tx.from` is the bundler and never
the account. The EntryPoint at `0x0000000071727de22e5e9d8baf0edac6f37da032` moved tokens for 85
distinct accounts in one twelve-minute window.

The consequence was worse than this section first said. `assessAddress` builds its payee set from
`outgoingCount > 0` and the lookalike rule only compares against that set, so for these users the
rule could not fire at all. Not a weakened signal — an absent one, and a test now shows it scoring
a lookalike of a real payee as `no-history-at-all`.

**An earlier version of this section had it backwards about this project's own accounts.** It said
`GuardedAccount`, by putting code on a user's account, produces "exactly the shape described
above". It does not. A 7702 delegation leaves an EOA that still signs, and the designator says so.
The real risk for `GuardedAccount` users was the *opposite* mistake: reading "has code" as "is a
contract" and dropping the signer test for an account that does sign. On live mainnet 16% of the
addresses sending USDT and USDC are delegated EOAs, so that would not have been a corner case. The
classifier matches the designator exactly for that reason, and `account-kinds.mjs` fails if it
ever stops finding them. That part was right and stays.

**What it was paired with was not.** The first fix read the owner's code once per scan and, where
the signer test could not pass, credited a value-moving unsigned record as a genuine payment —
reasoning that a contract's balance only moves when its own code moves it. That reasoning has the
project's own central claim as its counterexample: a `Transfer` log is not evidence of anything a
token contract didn't choose to claim, including the log that says a token arrived. `held` —
whether the account "has" a token — is read from exactly such a log, with no signature anywhere in
the check.
Two entries on an attacker-owned token — one wei in, some larger amount back out, nobody real
signing either — and the account's own address would be credited as having genuinely paid the
attacker. Not a weakened signal this time either: `outgoingCount > 0` is what silences the baseline
"never seen before" suspicion in `risk.ts`, so the forged pair did not just avoid a danger score, it
would have made the attacker's address read as fully, cleanly trusted. Worse than the fabrication
being defended against, which at least scores danger.

Found by asking whether the fix was actually safe rather than trusting that its own tests were
green — the two tests that shipped with it exercised a real payment and a real fabrication, and
never tried the forged pair. Fixed by removing the special case entirely: a contract account now
gets exactly the treatment a solver already gets against an EOA, a value-moving unsigned record
landing in `authorisedOutgoingCount` and never in `outgoingCount`, which needs no per-account flag
because a contract structurally can never be `tx.from` in the first place. Pinned as a permanent
regression test — `packages/engine/test/history.test.ts`,
`describe("the exact hole this used to have")` — that reproduces the two-log forgery and asserts
the baseline suspicion survives it.

The account classification in `packages/chain/src/account.ts` was never the problem and is still
used: it is correct, checked against live mainnet code, and worth having on its own. What it cannot
safely be used for is manufacturing trust for an account that cannot sign — there is no way, from
logs and a signer alone, to tell "the account's own logic authorised this" apart from "a token
contract claimed it did." The lookalike rule's blindness for smart-account payees is therefore not
closed. It is a real, open limitation, recorded plainly in `docs/threat-model.md` rather than
patched with something that only looked like a fix.
