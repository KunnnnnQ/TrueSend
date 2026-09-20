import {normalizeAddress, toChecksumAddress, type Address} from "./address.js";
import {fingerprint, sharedPrefixLength, sharedSuffixLength} from "./fingerprint.js";
import type {
  AddressSighting,
  Finding,
  FindingCode,
  RiskAssessment,
  RiskInput,
  RiskLevel,
} from "./types.js";

/**
 * How many leading and trailing hex characters have to match before two addresses count as
 * lookalikes.
 *
 * Four and four is the floor rather than the typical case. Wallets truncate to roughly six and
 * four, so an attack that only matched three characters would not fool anyone; one that matches
 * far more is the norm because grinding is cheap. Setting the floor low and letting the weight
 * rise with the match length means a marginal case shows up as a caution instead of vanishing.
 */
export const MIN_AFFIX_MATCH = 4;

/**
 * How soon after a payment an address has to appear for the timing to be suspicious.
 *
 * A bot watches for a payment and plants a lookalike address right behind it. The window is set
 * from measurement rather than intuition: across 4,076 planted addresses sampled from 1200 blocks
 * of mainnet USDT (`analysis/data/scan-latest.json`), the bait followed the payment it imitated
 * by a median of 26 blocks — about five minutes — with a 90th percentile of 146 blocks and a
 * longest observed gap of 1,125 blocks, under four hours.
 *
 * A day therefore covers everything observed with a wide margin. Erring wide is cheap here: this
 * rule contributes a caution-sized weight and never fires on its own, so a generous window costs
 * little, while a tight one would hand a slower attacker a way to score nothing.
 */
export const RECENT_PAYMENT_WINDOW_SECONDS = 24 * 60 * 60;

/**
 * The scoring table, in one place so it can be argued with.
 *
 * These are judgements, not measurements. They are laid out as named constants rather than buried
 * in the code so that a reviewer can disagree with a specific number, and so `analysis/` can
 * re-tune them against real cases without touching the detection logic.
 */
export const WEIGHTS = {
  /**
   * Enough on its own to reach `danger`, and the only weight here that is not a judgement call.
   *
   * Every other rule in this table is an inference about intent. This one is a fact: a transfer
   * log naming the user as sender, in a transaction the user did not sign, is a record of a
   * payment that did not happen. There is no benign reason for one to exist in a history.
   *
   * It is weighted above the lookalike rule because it does not need a lookalike to work. The
   * May 2024 WBTC case had no comparable address anywhere in the victim's history, so every
   * similarity rule scored it zero — see `analysis/src/evaluate-engine.mjs`.
   */
  spoofedOutgoing: 65,
  lookalikeBase: 40,
  /** Added per hex character matched beyond the floor, across both ends, up to `lookalikeMax`. */
  lookalikePerExtraChar: 2,
  lookalikeMax: 60,
  appearedRightAfterPayment: 25,
  zeroValueInbound: 25,
  dustInbound: 12,
  /**
   * A report the registry proved: the two addresses really do share the characters a wallet
   * shows. Weighted below the engine's own lookalike rule because that one fires against an
   * address the *user* has actually paid, while this is a stranger's claim about an address the
   * user may never have seen.
   */
  communityVerified: 25,
  /**
   * A report nothing could check. Set so that a single one, on an address with no other history,
   * lands exactly on `caution` — visible rather than silent, and nowhere near a verdict.
   */
  communityUnverified: 14,
  /** Added per reporter beyond the first, up to `COMMUNITY_CAP`. */
  communityPerExtraReporter: 4,
  neverPaidBefore: 6,
  noHistoryAtAll: 4,
} as const;

/**
 * Score thresholds.
 *
 * Calibrated so that a first payment to a genuinely new address — which is an ordinary, safe
 * thing people do constantly — stays quiet, while a single strong signal is enough to stop
 * someone. A tool that cries wolf on every new address gets switched off, and then it protects
 * nobody.
 */
export const THRESHOLDS = {danger: 45, caution: 18} as const;

/**
 * The most a community report can ever contribute, deliberately one point below `danger`.
 *
 * Attesting is permissionless, which it has to be for the registry to be worth having — and which
 * means anybody can report anybody, and a hundred "independent" reporters costs a hundred fresh
 * addresses. So no number of reports, from any number of reporters, can produce a "do not send"
 * verdict on its own. They raise a caution, and they can tip something already suspicious over
 * the line. A registry that could condemn an address by itself would be a griefing tool pointed
 * at exactly the people this project is meant to protect.
 *
 * What would lift this cap is identity or cost behind a report — a stake that can be slashed, or
 * attestations from reporters who are themselves attested. Neither exists yet, so neither is
 * assumed. `test_communityReportsAloneNeverReachDanger` holds the line.
 */
export const COMMUNITY_CAP = THRESHOLDS.danger - 1;

export function levelFor(score: number): RiskLevel {
  if (score >= THRESHOLDS.danger) return "danger";
  if (score >= THRESHOLDS.caution) return "caution";
  return "safe";
}

/**
 * Assess one address against the user's own history.
 *
 * Pure: same inputs, same output, no clock and no network. That is what lets the identical code
 * run in the web app, inside the browser extension's clipboard guard and behind the risk API,
 * and it is why `now` is an input rather than a call to `Date.now()`.
 */
export function assessAddress(input: RiskInput): RiskAssessment {
  const to = normalizeAddress(input.to);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const history = input.history ?? [];
  const findings: Finding[] = [];

  const self = history.find((entry) => normalizeAddress(entry.address) === to);
  const payees = history.filter(
    (entry) => entry.outgoingCount > 0 && normalizeAddress(entry.address) !== to,
  );

  // Checked first because it stands alone: it needs no similar address, no timing and no
  // community report, which is precisely the situation the rules below cannot handle.
  if (self && self.spoofedOutgoingCount > 0) {
    findings.push({
      code: "spoofed-outgoing-transfer",
      weight: WEIGHTS.spoofedOutgoing,
      message:
        `Your history shows ${plural(self.spoofedOutgoingCount, "payment")} from you to this ` +
        `address that you never signed. Someone else published ${self.spoofedOutgoingCount === 1 ? "that record" : "those records"} ` +
        `so the address would look like one you had already paid.`,
      evidence: {spoofedOutgoingCount: self.spoofedOutgoingCount, genuineOutgoing: self.outgoingCount},
    });
  }

  const nearest = nearestLookalike(to, payees);

  if (nearest) {
    const extra =
      nearest.sharedPrefix - MIN_AFFIX_MATCH + (nearest.sharedSuffix - MIN_AFFIX_MATCH);
    const weight = Math.min(
      WEIGHTS.lookalikeMax,
      WEIGHTS.lookalikeBase + extra * WEIGHTS.lookalikePerExtraChar,
    );

    const mine = fingerprint(to);
    const theirs = fingerprint(nearest.entry.address);
    const who = nearest.entry.label ? `"${nearest.entry.label}"` : theirs.short;

    findings.push({
      code: "lookalike-of-known-payee",
      weight,
      message:
        `This address matches the first ${nearest.sharedPrefix} and last ${nearest.sharedSuffix} ` +
        `characters of ${who}, which you have paid before — but its fingerprint reads ` +
        `"${mine.phrase}" instead of "${theirs.phrase}".`,
      evidence: {
        resembles: theirs.address,
        label: nearest.entry.label,
        sharedPrefix: nearest.sharedPrefix,
        sharedSuffix: nearest.sharedSuffix,
        thisPhrase: mine.phrase,
        theirPhrase: theirs.phrase,
      },
    });

    // The timing tell. Only meaningful when we know both when they paid and when this address
    // turned up, so an incomplete history degrades to silence rather than to a false accusation.
    const paidAt = nearest.entry.lastOutgoingAt;
    if (self && paidAt !== undefined) {
      const gap = self.firstSeenAt - paidAt;
      if (gap >= 0 && gap <= RECENT_PAYMENT_WINDOW_SECONDS) {
        findings.push({
          code: "appeared-right-after-payment",
          weight: WEIGHTS.appearedRightAfterPayment,
          message:
            `It first appeared in your history ${describeGap(gap)} after you paid ${who}. ` +
            `That is the usual pattern: a bot watches for a payment and plants a lookalike ` +
            `address right behind it.`,
          evidence: {paidAt, firstSeenAt: self.firstSeenAt, gapSeconds: gap},
        });
      }
    }
  }

  if (self && self.outgoingCount === 0 && self.zeroValueIncoming > 0) {
    findings.push({
      code: "zero-value-inbound",
      weight: WEIGHTS.zeroValueInbound,
      message:
        `This address only ever sent you ${plural(self.zeroValueIncoming, "empty transfer")} ` +
        `carrying no value. Those cost an attacker almost nothing and exist to put an address ` +
        `into your history where it looks like a real counterparty.`,
      evidence: {zeroValueIncoming: self.zeroValueIncoming},
    });
  }

  if (self && self.outgoingCount === 0 && self.dustIncoming > 0) {
    findings.push({
      code: "dust-inbound",
      weight: WEIGHTS.dustInbound,
      message:
        `It has sent you ${plural(self.dustIncoming, "dust transfer")} and nothing else. ` +
        `Unsolicited dust is a common way to get an address in front of you.`,
      evidence: {dustIncoming: self.dustIncoming},
    });
  }

  const report = (input.reports ?? []).find((r) => normalizeAddress(r.suspect) === to);
  if (report && report.reporters > 0) {
    const base = report.verified ? WEIGHTS.communityVerified : WEIGHTS.communityUnverified;
    const weight = Math.min(
      COMMUNITY_CAP,
      base + (report.reporters - 1) * WEIGHTS.communityPerExtraReporter,
    );

    const who = plural(report.reporters, "person", "people");
    const message = report.verified
      ? `${who} reported this address for imitating ` +
        `${report.imitating ? toChecksumAddress(report.imitating) : "another one"}, and the ` +
        `registry checked it: the two really do share the characters a wallet shows.`
      : report.role === "planter"
        ? `${who} reported this address for planting fabricated payment records in other ` +
          `people's histories. Nothing on chain can prove that, so treat it as a lead rather ` +
          `than a verdict.`
        : `${who} reported this address for impersonation. The claim has not been checked.`;

    findings.push({
      code: "community-reported",
      weight,
      message,
      evidence: {
        role: report.role,
        verified: report.verified,
        reporters: report.reporters,
        uid: report.uid,
        imitating: report.imitating,
        reportedAt: report.reportedAt,
      },
    });
  }

  if (!self) {
    findings.push({
      code: "no-history-at-all",
      weight: WEIGHTS.noHistoryAtAll,
      message:
        `You have never interacted with this address. That is normal for a first payment — ` +
        `check the fingerprint against what the recipient told you.`,
      evidence: {},
    });
  } else if (self.outgoingCount === 0) {
    findings.push({
      code: "never-paid-before",
      weight: WEIGHTS.neverPaidBefore,
      message: `You have never paid this address before, only received from it.`,
      evidence: {incomingCount: self.incomingCount},
    });
  }

  findings.sort((a, b) => b.weight - a.weight);
  const score = scoreOf(findings);

  const assessment: RiskAssessment = {
    address: toChecksumAddress(to),
    fingerprint: fingerprint(to),
    score,
    level: levelFor(score),
    findings,
  };

  if (nearest) {
    const theirs = fingerprint(nearest.entry.address);
    assessment.resembles = {
      address: theirs.address,
      fingerprint: theirs,
      sharedPrefix: nearest.sharedPrefix,
      sharedSuffix: nearest.sharedSuffix,
      ...(nearest.entry.label === undefined ? {} : {label: nearest.entry.label}),
    };
  }

  // `now` is part of the contract even where no rule currently reads it directly; keeping it in
  // the signature means adding an age-based rule later does not change every call site.
  void now;

  return assessment;
}

/**
 * Findings that describe the absence of information rather than the presence of a problem.
 *
 * Every address a user has not paid before carries one, so they are the floor, not a signal.
 */
const BASELINE_CODES = new Set<FindingCode>(["no-history-at-all", "never-paid-before"]);

/**
 * Sum the findings, holding the community cap over the *combination* rather than one finding.
 *
 * Capping the report's own weight is not enough: a brand-new address also carries
 * `no-history-at-all`, and report-plus-baseline would clear the danger threshold between them.
 * Since "never seen before" is the default state of every address a user has not paid, that would
 * mean a handful of attestations could condemn any address at all — which is the griefing this
 * cap exists to prevent.
 *
 * So when nothing but reports and baseline findings are present, the total is held below danger.
 * Any genuine signal alongside them — a lookalike, a fabricated record, an empty transfer — lifts
 * the cap, because then the reports are corroborating something rather than standing alone.
 */
function scoreOf(findings: readonly Finding[]): number {
  const total = Math.min(
    100,
    findings.reduce((sum, finding) => sum + finding.weight, 0),
  );

  const onlyReportsAndBaseline = findings.every(
    (finding) => finding.code === "community-reported" || BASELINE_CODES.has(finding.code),
  );

  return onlyReportsAndBaseline ? Math.min(total, COMMUNITY_CAP) : total;
}

interface Lookalike {
  entry: AddressSighting;
  sharedPrefix: number;
  sharedSuffix: number;
}

/**
 * The payee this address most resembles, if any resembles it enough to matter.
 *
 * Ties break toward the longest combined match, so when a user has several similar contacts the
 * warning names the one an attacker was most plausibly copying.
 */
export function nearestLookalike(
  candidate: string,
  payees: readonly AddressSighting[],
): Lookalike | undefined {
  const to = normalizeAddress(candidate);
  let best: Lookalike | undefined;

  for (const entry of payees) {
    const other = normalizeAddress(entry.address);
    if (other === to) continue;

    const sharedPrefix = sharedPrefixLength(to, other);
    const sharedSuffix = sharedSuffixLength(to, other);
    if (sharedPrefix < MIN_AFFIX_MATCH || sharedSuffix < MIN_AFFIX_MATCH) continue;

    if (!best || sharedPrefix + sharedSuffix > best.sharedPrefix + best.sharedSuffix) {
      best = {entry, sharedPrefix, sharedSuffix};
    }
  }

  return best;
}

/** Assess a batch — what the Scan screen runs over a whole transaction history. */
export function assessMany(
  addresses: readonly string[],
  shared: Omit<RiskInput, "to">,
): RiskAssessment[] {
  return addresses
    .map((to) => assessAddress({...shared, to}))
    .sort((a, b) => b.score - a.score);
}

function describeGap(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  return `${Math.round(seconds / 3600)} hours`;
}

function plural(n: number, noun: string, plural?: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${plural ?? `${noun}s`}`;
}

export type {Address};
