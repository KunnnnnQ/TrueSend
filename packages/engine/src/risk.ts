import {normalizeAddress, toChecksumAddress, type Address} from "./address.js";
import {fingerprint, sharedPrefixLength, sharedSuffixLength} from "./fingerprint.js";
import type {AddressSighting, Finding, RiskAssessment, RiskInput, RiskLevel} from "./types.js";

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
 * This is the signature of the attack this project is named for: the victim makes a small test
 * transfer, a bot watching the mempool sees it, and a lookalike address is planted in their
 * history within minutes. A day is generous — real cases cluster inside an hour — but a wide
 * window costs only a caution, while a narrow one would miss a slow attacker.
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
  lookalikeBase: 40,
  /** Added per hex character matched beyond the floor, across both ends, up to `lookalikeMax`. */
  lookalikePerExtraChar: 2,
  lookalikeMax: 60,
  appearedRightAfterPayment: 25,
  zeroValueInbound: 25,
  dustInbound: 12,
  communityReported: 45,
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
  if (report) {
    findings.push({
      code: "community-reported",
      weight: WEIGHTS.communityReported,
      message: report.imitating
        ? `Someone has publicly attested that this address is impersonating ` +
          `${toChecksumAddress(report.imitating)}.`
        : `Someone has publicly attested that this address is used for impersonation.`,
      evidence: {uid: report.uid, imitating: report.imitating, reportedAt: report.reportedAt},
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
  const score = Math.min(
    100,
    findings.reduce((sum, f) => sum + f.weight, 0),
  );

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

function plural(n: number, noun: string): string {
  return n === 1 ? `1 ${noun}` : `${n} ${noun}s`;
}

export type {Address};
