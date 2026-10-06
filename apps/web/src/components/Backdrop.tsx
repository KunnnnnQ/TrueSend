"use client";

import {useEffect, useRef} from "react";

/**
 * The page's backdrop: a dot grid, and a soft light that follows the pointer.
 *
 * Decorative only - it sits behind everything, takes no input and carries no information. The
 * light moves by updating two CSS variables once per frame at most, so it costs nothing while the
 * pointer is still, and it stays put for anyone who asks the system for reduced motion.
 */
export function Backdrop() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let frame = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      frame = 0;
      ref.current?.style.setProperty("--spot-x", `${x}px`);
      ref.current?.style.setProperty("--spot-y", `${y}px`);
    };
    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    window.addEventListener("pointermove", onMove, {passive: true});
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={ref} aria-hidden className="backdrop" />;
}
