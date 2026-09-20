"use client";

import {compareFingerprints, type RiskAssessment, type RiskLevel} from "@truesend/engine";

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
