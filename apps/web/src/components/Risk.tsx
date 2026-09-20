"use client";

import {
  compareFingerprints,
  type PoisonReport,
  type RiskAssessment,
  type RiskLevel,
} from "@truesend/engine";

import {AddressCard} from "./Fingerprint";

const LEVEL_STYLE: Record<RiskLevel, {chip: string; label: string}> = {
  safe: {chip: "bg-safe/12 text-safe border-safe/25", label: "Looks fine"},
  caution: {chip: "bg-caution/12 text-caution border-caution/25", label: "Worth a look"},
  danger: {chip: "bg-danger/12 text-danger border-danger/30", label: "Do not send"},
};

export function RiskChip({level, score}: {level: RiskLevel; score?: number}) {
  const style = LEVEL_STYLE[level];
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${style.chip}`}
    >
      {style.label}
      {score === undefined ? null : <span className="tabular opacity-60">{score}</span>}
    </span>
  );
}

/**
 * The findings, in the engine's order.
 *
 * Every one is a full sentence written for the person about to sign, not a rule name with a
 * number next to it. A score on its own asks to be trusted; a reason can be checked against what
 * the user already knows, which is the only part of this that catches what the rules miss.
 */
export function Findings({assessment}: {assessment: RiskAssessment}) {
  if (assessment.findings.length === 0) {
    return (
      <p className="text-sm text-muted">
        Nothing stands out about this address. Check the fingerprint against what the recipient
        told you — that is the part no detector can do for you.
      </p>
    );
  }

  return (
    <ul className="space-y-2.5">
      {assessment.findings.map((finding) => (
        <li key={finding.code} className="flex gap-2.5 text-sm leading-relaxed">
          <span
            aria-hidden
            className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${
              finding.weight >= 40 ? "bg-danger" : finding.weight >= 18 ? "bg-caution" : "bg-faint"
            }`}
          />
          <span className="text-text/90">{finding.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * A report, shown as a report.
 *
 * Two rules from `docs/registry.md` decide the wording. Attesting is permissionless, so this can
 * never read as a verdict — it says who said it and whether anything checked it. And a planter
 * report is unprovable by construction, so it never gets a badge that could be mistaken for proof.
 *
 * Lives here rather than on one screen because Scan and Send have to say the same thing about the
 * same attestation; a second copy of this paragraph is a second place for the wording to drift,
 * and the whole point of the sentence is that it is precise about what was and was not checked.
 */
export function ReportLine({report}: {report: PoisonReport}) {
  const who = report.reporters === 1 ? "1 reporter" : `${report.reporters} reporters`;

  return (
    <div
      className={`rounded-md border px-3 py-2.5 text-sm leading-relaxed ${
        report.verified ? "border-caution/25 bg-caution/8" : "border-line bg-ink"
      }`}
    >
      <span className={report.verified ? "text-caution" : "text-muted"}>
        {who} reported this address{" "}
        {report.role === "planter"
          ? "for signing transactions that plant fabricated payment records."
          : "for imitating another address."}
      </span>
      <span className="mt-1 block text-xs text-faint">
        {report.verified
          ? "The registry checked the lookalike claim on chain and it held: the two addresses really do share the characters a wallet shows."
          : "Nothing on chain can verify this. The resolver records who said it and counts distinct reporters; it does not pretend to have proved anything."}{" "}
        Any number of reports, from any number of reporters, is capped below the level that stops a
        payment.
      </span>
    </div>
  );
}

export function ReportChip({report}: {report: PoisonReport}) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-1 text-xs font-medium ${
        report.verified
          ? "border-caution/30 bg-caution/12 text-caution"
          : "border-line bg-ink text-muted"
      }`}
      title={
        report.verified
          ? "Reported, and the lookalike claim was proved on chain"
          : "Reported, and nothing on chain could check it"
      }
    >
      reported
      <span className="tabular ml-1.5 opacity-60">{report.reporters}</span>
    </span>
  );
}

/**
 * The comparison that makes a poisoning attempt obvious.
 *
 * Side by side, the two addresses share the characters a wallet shows and share nothing else.
 * Showing them apart, or showing only the suspicious one, loses exactly the contrast that makes
 * this legible without reading 40 hex characters.
 */
export function LookalikeComparison({assessment}: {assessment: RiskAssessment}) {
  const resembles = assessment.resembles;
  if (!resembles) return null;

  const comparison = compareFingerprints(resembles.address, assessment.address);

  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <div className="mb-3 text-xs uppercase tracking-wide text-faint">
        Shares the first {resembles.sharedPrefix} and last {resembles.sharedSuffix} characters with
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-medium text-safe">You have paid this one</div>
          <AddressCard address={resembles.address} {...(resembles.label ? {label: resembles.label} : {})} />
        </div>
        <div>
          <div className="mb-2 text-xs font-medium text-danger">This is the one in front of you</div>
          <AddressCard
            address={assessment.address}
            emphasis="strong"
            highlightWords={comparison.differingWordPositions}
          />
        </div>
      </div>
    </div>
  );
}
