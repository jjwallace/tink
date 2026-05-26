import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { FONT, ACTIVE_COLOR } from "../theme";

/** Custom dropdown that replaces native <select>.
 *
 *  Why custom: native <select> on macOS WebKit pops its options through
 *  the OS-chrome NSMenu, which uses the system font regardless of any
 *  CSS — reads visibly different from the rest of the panel. This
 *  component renders the list through our own DOM so the typography
 *  stays inside the theme.
 *
 *  Closes on click-outside, Escape, scroll, or window resize. The
 *  popover is fixed-positioned (escaping SectionBox's overflow:hidden);
 *  scroll closes the dropdown to avoid stale positions. No keyboard
 *  navigation (arrow keys) — user clicks to pick. */
export function Dropdown(props: {
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
  minWidth?: string;
  align?: "left" | "right";
}) {
  const [open, setOpen] = createSignal(false);
  // Rect captured at open-time — used to position the fixed popover so
  // it escapes the SectionBox's overflow:hidden + any scroll container
  // clipping.
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  let buttonRef!: HTMLButtonElement;
  let popoverRef: HTMLDivElement | null = null;

  const currentLabel = () =>
    props.options.find((o) => o.value === props.value)?.label ?? props.value;

  const openDropdown = () => {
    if (props.disabled) return;
    if (buttonRef) setRect(buttonRef.getBoundingClientRect());
    setOpen(true);
  };

  onMount(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!open()) return;
      const t = e.target as Node;
      if (buttonRef?.contains(t) || popoverRef?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (open() && e.key === "Escape") setOpen(false);
    };
    const onScroll = () => {
      if (open()) setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    // Capture-phase so we catch scroll events on any ancestor container.
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    });
  });

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        ref={buttonRef}
        type="button"
        disabled={props.disabled}
        onClick={() => {
          if (props.disabled) return;
          if (open()) setOpen(false);
          else openDropdown();
        }}
        style={{
          "font-family": FONT,
          "font-size": "12px",
          "font-weight": "500",
          "letter-spacing": "0.1px",
          color: "var(--text-primary)",
          background: "var(--control-bg)",
          border: "2px solid var(--control-border)",
          "border-radius": "4px",
          padding: "3px 22px 3px 8px",
          "min-width": props.minWidth ?? "120px",
          cursor: props.disabled ? "default" : "pointer",
          outline: "none",
          "text-align": props.align === "right" ? "right" : "left",
          position: "relative",
          opacity: props.disabled ? 0.5 : 1,
          "line-height": "1.4",
        }}
      >
        {currentLabel()}
        <span
          style={{
            position: "absolute",
            right: "7px",
            top: "50%",
            transform: "translateY(-50%)",
            "font-size": "8px",
            color: "var(--text-secondary)",
            "pointer-events": "none",
          }}
        >
          ▾
        </span>
      </button>
      <Show when={open() && !props.disabled && rect()}>
        <div
          ref={(el) => (popoverRef = el)}
          style={{
            position: "fixed",
            top: `${rect()!.bottom + 2}px`,
            ...(props.align === "right"
              ? { right: `${window.innerWidth - rect()!.right}px` }
              : { left: `${rect()!.left}px` }),
            "min-width": `${rect()!.width}px`,
            background: "var(--panel-bg)",
            border: "2px solid var(--control-border)",
            "border-radius": "4px",
            "z-index": "100002",
            overflow: "hidden",
            "font-family": FONT,
            "box-shadow": "0 6px 16px rgba(0,0,0,0.3)",
          }}
        >
          <For each={props.options as readonly { value: string; label: string }[]}>
            {(opt) => {
              const isSel = () => props.value === opt.value;
              return (
                <div
                  onClick={() => {
                    props.onChange(opt.value);
                    setOpen(false);
                  }}
                  onMouseEnter={(e) => {
                    if (!isSel())
                      e.currentTarget.style.background = "rgba(127,127,127,0.1)";
                  }}
                  onMouseLeave={(e) => {
                    if (!isSel()) e.currentTarget.style.background = "transparent";
                  }}
                  style={{
                    padding: "5px 10px",
                    "font-size": "12px",
                    "font-weight": isSel() ? "600" : "500",
                    "letter-spacing": "0.1px",
                    color: isSel() ? ACTIVE_COLOR : "var(--text-primary)",
                    cursor: "pointer",
                    "white-space": "nowrap",
                    background: isSel()
                      ? `color-mix(in srgb, ${ACTIVE_COLOR} 15%, transparent)`
                      : "transparent",
                    "line-height": "1.4",
                  }}
                >
                  {opt.label}
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
