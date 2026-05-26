import { createSignal, createEffect, onCleanup, Show } from "solid-js";
import gsap from "gsap";
import { FONT, PURPLE, GREEN, RED } from "../theme";
import type { SummarizerModelInfo } from "../types";
import { Spinner } from "./Spinner";

/** Card row used in every model picker (TTS voices, STT models,
 *  summarizer models). One row per model: label, size/description,
 *  download/use button on the right. While downloading the row paints
 *  a left-to-right progress fill behind the content and pulses its
 *  border via GSAP. Click an inactive downloaded row to make it
 *  active.
 *
 *  Originally named SummarizerCard but reused for all three model
 *  flavors — the name's now ModelCard. */
export function ModelCard(props: {
  model: SummarizerModelInfo;
  isActive: boolean;
  downloadStatus: string | null;
  /** 0..100; undefined when not downloading. */
  downloadProgress?: number;
  onUse: () => void;
  onDownload: () => void;
}) {
  const [loading, setLoading] = createSignal(false);
  let rowRef!: HTMLDivElement;
  let pulseTween: gsap.core.Tween | undefined;

  // Drive the row's border via GSAP while a download is in flight.
  // Same pattern as voice-anchor's iterate pulse: a fixed-color border
  // with a yo-yo-ed alpha. Not CSS keyframes so we can cleanly tear
  // it down when status flips.
  createEffect(() => {
    const downloading = props.downloadStatus === "downloading";
    if (downloading && rowRef) {
      pulseTween?.kill();
      const pulse = { v: 0.45 };
      pulseTween = gsap.to(pulse, {
        v: 1.0,
        duration: 0.85,
        ease: "sine.inOut",
        yoyo: true,
        repeat: -1,
        onUpdate: () => {
          if (rowRef) {
            rowRef.style.borderColor = `rgba(167, 139, 250, ${pulse.v})`;
            rowRef.style.boxShadow = `0 0 ${10 + pulse.v * 14}px rgba(167, 139, 250, ${pulse.v * 0.45})`;
          }
        },
      });
    } else {
      pulseTween?.kill();
      pulseTween = undefined;
      if (rowRef) rowRef.style.boxShadow = "";
    }
  });
  onCleanup(() => pulseTween?.kill());

  const handleUse = async () => {
    setLoading(true);
    props.onUse();
  };

  // Animate when active state changes
  createEffect((prev: boolean | undefined) => {
    const active = props.isActive;
    if (rowRef && prev !== undefined && prev !== active && active) {
      gsap.fromTo(
        rowRef,
        { scale: 0.98, borderColor: "rgba(167,139,250,0)" },
        {
          scale: 1,
          borderColor: "rgba(167,139,250,0.25)",
          duration: 0.3,
          ease: "back.out(2)",
        },
      );
    }
    return active;
  });

  return (
    <div
      ref={rowRef}
      onMouseEnter={() => {
        if (props.model.downloaded && !props.isActive)
          gsap.to(rowRef, { scale: 1.01, duration: 0.15, ease: "power2.out" });
      }}
      onMouseLeave={() =>
        gsap.to(rowRef, { scale: 1, duration: 0.15, ease: "power2.out" })
      }
      onMouseDown={() => {
        if (props.model.downloaded && !props.isActive)
          gsap.to(rowRef, { scale: 0.98, duration: 0.08 });
      }}
      onMouseUp={() => gsap.to(rowRef, { scale: 1, duration: 0.1 })}
      style={{
        display: "flex",
        "align-items": "center",
        "justify-content": "space-between",
        padding: "6px 10px",
        "border-radius": "6px",
        // While downloading, render a horizontal progress fill behind
        // the row content. Percent comes from voice-download-progress
        // events. With 0% the gradient is flat control-bg; with 100%
        // the whole row is filled.
        background:
          props.downloadStatus === "downloading"
            ? `linear-gradient(to right, color-mix(in srgb, ${PURPLE} 30%, var(--control-bg)) ${props.downloadProgress ?? 0}%, var(--control-bg) ${props.downloadProgress ?? 0}%)`
            : props.isActive
              ? `color-mix(in srgb, ${PURPLE} 20%, var(--control-bg))`
              : "var(--control-bg)",
        border: props.isActive
          ? `2px solid color-mix(in srgb, ${PURPLE} 50%, var(--control-border))`
          : "2px solid var(--control-border)",
        transition:
          props.downloadStatus === "downloading"
            ? "background 0.3s linear"
            : "background 0.2s ease, border 0.2s ease",
        cursor:
          props.model.downloaded && !props.isActive ? "pointer" : "default",
        "transform-origin": "center",
      }}
      onClick={() => {
        if (props.model.downloaded && !props.isActive && !loading()) handleUse();
      }}
    >
      {/* Info */}
      <div style={{ flex: "1", "min-width": "0" }}>
        <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
          <span
            style={{
              "font-size": "12px",
              "font-family": FONT,
              color: "var(--text-primary)",
              "font-weight": props.isActive ? "600" : "500",
            }}
          >
            {props.model.label}
          </span>
          <Show when={props.isActive}>
            <span
              style={{
                "font-size": "8px",
                "font-family": FONT,
                color: PURPLE,
                "text-transform": "uppercase",
                "letter-spacing": "0.5px",
                padding: "1px 5px",
                "border-radius": "3px",
                background: "rgba(108,79,208,0.18)",
                border: `1px solid rgba(108,79,208,0.35)`,
              }}
            >
              active
            </span>
          </Show>
        </div>
        <div
          style={{
            "font-size": "10px",
            color: "var(--text-muted)",
            "font-family": FONT,
            "margin-top": "1px",
            "white-space": "nowrap",
            overflow: "hidden",
            "text-overflow": "ellipsis",
          }}
        >
          {props.model.description}
        </div>
      </div>

      {/* Action button */}
      <Show
        when={!loading() && props.downloadStatus !== "downloading"}
        fallback={
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "5px",
              padding: "3px 9px",
              "border-radius": "4px",
              background: `color-mix(in srgb, ${PURPLE} 20%, var(--control-bg))`,
              border: `1px solid color-mix(in srgb, ${PURPLE} 40%, var(--control-border))`,
              color: PURPLE,
              "font-size": "10px",
              "font-weight": "600",
              "font-family": FONT,
              overflow: "hidden",
              position: "relative",
            }}
          >
            <Spinner />
            <span>
              {props.downloadStatus === "downloading"
                ? typeof props.downloadProgress === "number" &&
                  props.downloadProgress > 0
                  ? `${Math.round(props.downloadProgress)}%`
                  : "Downloading"
                : "Loading"}
            </span>
          </div>
        }
      >
        <Show when={props.model.downloaded}>
          <Show
            when={!props.isActive}
            fallback={
              <span
                style={{
                  "font-size": "10px",
                  "font-weight": "600",
                  "font-family": FONT,
                  color: GREEN,
                  padding: "3px 9px",
                  "border-radius": "4px",
                  background: `color-mix(in srgb, ${GREEN} 20%, var(--control-bg))`,
                  border: `1px solid color-mix(in srgb, ${GREEN} 40%, var(--control-border))`,
                }}
              >
                ✓ Ready
              </span>
            }
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                handleUse();
              }}
              style={{
                padding: "3px 10px",
                "border-radius": "4px",
                border: "1px solid var(--control-border)",
                background: "var(--control-bg)",
                color: "var(--text-primary)",
                "font-size": "10px",
                "font-weight": "600",
                "font-family": FONT,
                cursor: "pointer",
                outline: "none",
                "box-shadow": "inset 0 1px 0 var(--edge-highlight)",
                transition: "all 0.15s ease",
              }}
            >
              Use
            </button>
          </Show>
        </Show>
        <Show when={!props.model.downloaded}>
          <Show
            when={props.downloadStatus !== "error"}
            fallback={
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDownload();
                }}
                style={{
                  padding: "3px 10px",
                  "border-radius": "4px",
                  border: `1px solid color-mix(in srgb, ${RED} 50%, var(--control-border))`,
                  background: `color-mix(in srgb, ${RED} 25%, var(--control-bg))`,
                  color: RED,
                  "font-size": "10px",
                  "font-weight": "600",
                  "font-family": FONT,
                  cursor: "pointer",
                  outline: "none",
                }}
              >
                Retry
              </button>
            }
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                props.onDownload();
              }}
              style={{
                padding: "3px 10px",
                "border-radius": "4px",
                border: "1px solid var(--control-border)",
                background: "var(--control-bg)",
                color: "var(--text-secondary)",
                "font-size": "10px",
                "font-weight": "600",
                "font-family": FONT,
                cursor: "pointer",
                outline: "none",
                "box-shadow": "inset 0 1px 0 var(--edge-highlight)",
                transition: "all 0.15s ease",
              }}
            >
              Download
            </button>
          </Show>
        </Show>
      </Show>
    </div>
  );
}
