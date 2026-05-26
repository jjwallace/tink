import { onMount } from "solid-js";
import gsap from "gsap";
import { PURPLE } from "../theme";

/** Tiny spinning circle used inside download buttons. GSAP-driven
 *  rather than CSS @keyframes so we can stay consistent with the rest
 *  of the panel's animation stack. */
export function Spinner() {
  let ref!: HTMLSpanElement;
  onMount(() => {
    gsap.to(ref, {
      rotation: 360,
      duration: 0.8,
      repeat: -1,
      ease: "none",
    });
  });
  return (
    <span
      ref={ref}
      style={{
        display: "inline-block",
        width: "12px",
        height: "12px",
        border: "2px solid rgba(255,255,255,0.2)",
        "border-top-color": PURPLE,
        "border-radius": "50%",
        "vertical-align": "middle",
        "flex-shrink": "0",
      }}
    />
  );
}
