"use client";

import {useEffect, useLayoutEffect, useState} from "react";

/**
 * Motion that reports a result, never motion that could misreport one.
 *
 * Both effects below end on the exact value they were given and hold it, and both are skipped
 * entirely for anyone whose system asks for reduced motion. The fingerprint words in particular
 * are what a user compares by eye before paying someone, so the animation is short, runs once, and
 * the true text is always what is left on screen - and always what a screen reader is given.
 */

const QUERY = "(prefers-reduced-motion: reduce)";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.(QUERY).matches === true;
}

/** Layout effect in the browser, plain effect where there is no layout (static rendering). */
const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const NOISE = "abcdefghijklmnopqrstuvwxyz";

/**
 * Resolve `text` out of random letters, left to right, over `duration` ms after `delay` ms.
 *
 * Spaces stay spaces, so the word shapes are visible from the first frame and only the letters
 * settle. Returns `text` itself whenever motion is reduced, and always once the animation ends.
 */
export function useScramble(text: string, {duration = 650, delay = 0} = {}): string {
  const [shown, setShown] = useState(text);

  useBrowserLayoutEffect(() => {
    if (prefersReducedMotion()) {
      setShown(text);
      return;
    }

    const at = (progress: number) => {
      const settled = Math.floor(progress * text.length);
      let out = "";
      for (let i = 0; i < text.length; i++) {
        const char = text[i]!;
        out += i < settled || char === " " ? char : NOISE[Math.floor(Math.random() * NOISE.length)];
      }
      return out;
    };

    // The first frame is set here, before the browser paints, so the true text never flashes up
    // once and then dissolves.
    setShown(at(0));
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      setShown(progress < 1 ? at(progress) : text);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const settle = settleAfter(delay + duration, () => {
      cancelAnimationFrame(frame);
      setShown(text);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [text, duration, delay]);

  return shown;
}

/** Count from 0 up to `value` over `duration` ms, easing out. Exact at the end, and when reduced. */
export function useCountUp(value: number, {duration = 700, delay = 0} = {}): number {
  const [shown, setShown] = useState(value);

  useBrowserLayoutEffect(() => {
    if (prefersReducedMotion() || value === 0) {
      setShown(value);
      return;
    }

    setShown(0); // before the first paint, as in useScramble
    let frame = 0;
    const start = performance.now() + delay;
    const tick = (now: number) => {
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - (1 - progress) ** 3;
      setShown(progress < 1 ? Math.round(value * eased) : value);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const settle = settleAfter(delay + duration, () => {
      cancelAnimationFrame(frame);
      setShown(value);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(settle);
    };
  }, [value, duration, delay]);

  return shown;
}

/**
 * Put the true value on screen when the animation should have ended, whether or not it ran.
 *
 * Animation frames are a request, not a promise: a browser stops delivering them to a page it
 * considers hidden - measured in the in-app browser this was built with, where a scan's results
 * sat on their first frame of noise for nearly a second while timers kept firing on time. Timers
 * keep running in hidden pages, so this one guarantees that what is left on screen is the
 * fingerprint, never a frame of noise where a fingerprint should be.
 */
function settleAfter(ms: number, settle: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(settle, ms + 50);
}
