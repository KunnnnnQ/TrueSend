"use client";

import {fingerprint, type AddressFingerprint} from "@truesend/engine";

import {useScramble} from "@/lib/motion";

/**
 * The glyph, drawn from the cells the engine derived.
 *
 * Rendered as real elements rather than an image so it inherits the page's colours and stays
 * crisp at any size. The middle column takes the accent colour, which gives the shape a spine and
 * makes two glyphs easier to tell apart at a glance than pure symmetry would.
 */
export function Identicon({
  address,
  size = 40,
  fp,
}: {
  address?: string;
  size?: number;
  fp?: AddressFingerprint;
}) {
  const print = fp ?? fingerprint(address!);
  const cell = size / 5;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Address fingerprint ${print.phrase}`}
      className="shrink-0 rounded-[3px]"
    >
      <rect width={size} height={size} fill="var(--color-raised)" />
      {print.identicon.cells.map((filled, i) =>
        filled ? (
          <rect
            key={i}
            x={(i % 5) * cell}
            y={Math.floor(i / 5) * cell}
            width={cell}
            height={cell}
            fill={i % 5 === 2 ? print.identicon.accent : print.identicon.foreground}
          />
        ) : null,
      )}
    </svg>
  );
}

/**
 * An address, always in the same three parts: glyph, truncated hex, fingerprint phrase.
 *
 * The truncated hex is deliberately kept — it is what every wallet shows and what the attacker
 * spent money matching, so removing it would hide the thing the user needs to stop trusting. The
 * phrase sits directly underneath so the contrast is unavoidable: identical above, different
 * below.
 */
export function AddressCard({
  address,
  label,
  emphasis = "normal",
  highlightWords,
  delay = 0,
}: {
  address: string;
  label?: string;
  emphasis?: "normal" | "strong";
  /** Word positions to mark as differing from a comparison address. */
  highlightWords?: readonly number[];
  /** Milliseconds before the phrase starts resolving, to follow a list's order. */
  delay?: number;
}) {
  const print = fingerprint(address);

  return (
    <div className="flex min-w-0 items-start gap-3">
      <Identicon fp={print} size={emphasis === "strong" ? 44 : 36} />
      <div className="min-w-0">
        {label ? <div className="text-sm font-medium text-text">{label}</div> : null}
        <div
          className={`tabular truncate ${
            emphasis === "strong" ? "text-base text-text" : "text-sm text-muted"
          }`}
          title={print.address}
        >
          {print.short}
        </div>
        {/* Wraps between words on a narrow screen; the words sit flush, so nothing else would. */}
        <div className="tabular mt-0.5 flex flex-wrap text-sm">
          {/* The true phrase for assistive technology; the resolving letters are only for the eye. */}
          <span className="sr-only">{print.phrase}</span>
          {print.words.map((word, i) => (
            <Word
              key={i}
              word={word}
              delay={delay + i * 70}
              className={
                highlightWords?.includes(i)
                  ? "mr-1.5 rounded bg-danger/15 px-1 text-danger"
                  : "mr-1.5 text-faint"
              }
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/** One fingerprint word, resolving out of noise into itself. Always ends exact; see useScramble. */
function Word({word, delay, className}: {word: string; delay: number; className: string}) {
  const shown = useScramble(word, {delay, duration: 420});
  return (
    <span aria-hidden className={className}>
      {shown}
    </span>
  );
}
