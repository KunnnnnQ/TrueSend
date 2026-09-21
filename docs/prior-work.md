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
"57.5% of sampled wallets saw nothing" alongside the detection rate. A detection number on its
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

## Changes this suggests

Recorded here rather than made, because `docs/threat-model.md` and `README.md` are shared with a
parallel session and editing them would clobber its work.

1. **`docs/threat-model.md` should gain a section on the delegation-signing habit**, citing
   arXiv:2512.12174 and pointing at `SafeVault` as the no-delegation path. This is the most
   important of the three: it is a risk the project's own design introduces.
2. **`README.md`'s framing of the problem should cite arXiv:2508.12107's "only three of 53
   wallets warn"**, next to the existing claim about what wallets display. It is a stronger and
   more checkable statement than the current one and it is not mine.
3. **`analysis/README.md`'s concentration paragraph should note the CCS'24 four-entity/92%-profit
   finding** as independent corroboration of the planter-keyed registry design, with the
   granularity caveat. That file is mine and the change is made in the same commit as this
   document.
