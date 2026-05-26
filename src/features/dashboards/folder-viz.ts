import gsap from "gsap";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface FolderNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  status: "added" | "modified" | "deleted" | "untracked" | "clean" | "ignored";
  children: FolderNode[];
  size: number;
}

interface FolderSummary {
  root: FolderNode;
  total_files: number;
  total_dirs: number;
  added: number;
  modified: number;
  deleted: number;
  untracked: number;
  description: string;
}

const STATUS_COLORS: Record<string, string> = {
  added: "#6ee7a0",
  untracked: "#6ee7a0",
  modified: "#fcd34d",
  deleted: "#fca5a5",
  clean: "rgba(255,255,255,0.55)",
  ignored: "rgba(255,255,255,0.25)",
};

const TEXT_SHADOW = "0 0 10px rgba(0,0,0,1), 0 0 20px rgba(0,0,0,1), 0 0 30px rgba(0,0,0,0.8)";
const CARD_FILTER = "drop-shadow(0 0 10px rgba(0,0,0,1)) drop-shadow(0 0 20px rgba(0,0,0,1)) drop-shadow(0 0 40px rgba(0,0,0,0.9))";

/**
 * Single persistent folder viz.
 * Shows root, then GSAP animates folders opening along the path to changed files.
 * New files flash in. Deleted files flash red and collapse out.
 * Reuses the same card — new changes animate into it.
 */
export class FolderViz {
  private parent: HTMLElement;
  private card: HTMLDivElement | null = null;
  private treeEl: HTMLDivElement | null = null;
  private headerEl: HTMLDivElement | null = null;
  private unlisteners: UnlistenFn[] = [];
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private shownPaths = new Set<string>(); // tracks what's already visible

  constructor(parent: HTMLElement) {
    this.parent = parent;
  }

  async init() {
    this.unlisteners.push(
      await listen<{
        path: string;
        max_depth?: number;
        speak?: string;
        added_files?: string[];
        removed_files?: string[];
      }>("folder-viz-show", (e) => {
        this.show(
          e.payload.path,
          e.payload.max_depth,
          e.payload.speak,
          e.payload.added_files,
          e.payload.removed_files,
        );
      }),
    );
  }

  async show(
    path: string,
    maxDepth?: number,
    customSpeech?: string,
    addedFiles?: string[],
    removedFiles?: string[],
  ) {
    let data: FolderSummary;
    try {
      data = await invoke<FolderSummary>("scan_folder", { path, maxDepth: maxDepth ?? 4 });
    } catch (e) {
      console.error("scan_folder failed:", e);
      return;
    }

    // Reset hide timer
    if (this.hideTimer) clearTimeout(this.hideTimer);

    // Create card if it doesn't exist
    if (!this.card) {
      this.card = document.createElement("div");
      Object.assign(this.card.style, {
        position: "fixed",
        top: "30px",
        right: "30px",
        pointerEvents: "none",
        zIndex: "99998",
        opacity: "0",
        filter: CARD_FILTER,
        maxWidth: "500px",
      });

      this.headerEl = document.createElement("div");
      Object.assign(this.headerEl.style, {
        fontFamily: "'SF Pro Display', -apple-system, system-ui, sans-serif",
        fontSize: "18px",
        fontWeight: "700",
        color: "rgba(255,255,255,0.95)",
        marginBottom: "12px",
        textShadow: TEXT_SHADOW,
      });
      this.card.appendChild(this.headerEl);

      this.treeEl = document.createElement("div");
      Object.assign(this.treeEl.style, {
        fontFamily: "'SF Mono', 'Menlo', monospace",
        fontSize: "13px",
        lineHeight: "2",
        textShadow: TEXT_SHADOW,
      });
      this.card.appendChild(this.treeEl);

      this.parent.appendChild(this.card);
      this.shownPaths.clear();

      gsap.set(this.card, { opacity: 0, y: 20 });
      gsap.to(this.card, { opacity: 1, y: 0, duration: 0.5, ease: "power2.out" });
    }

    this.headerEl!.textContent = data.root.name;

    // Find paths that have changes and animate the tree open to them
    const changedPaths = this.findChangedPaths(data.root);
    this.animateTreeOpen(data.root, changedPaths, removedFiles || []);

    // Only speak if custom speech provided — don't auto-speak from viz
    if (customSpeech) {
      this.speak(customSpeech);
    }

    // Auto-hide after 4s
    this.hideTimer = setTimeout(() => this.fadeOut(), 4000);
  }

  /** Find all directory paths that lead to changed files */
  private findChangedPaths(node: FolderNode, prefix = ""): Set<string> {
    const paths = new Set<string>();
    const fullPath = prefix ? `${prefix}/${node.name}` : node.name;

    if (node.kind === "file" && node.status !== "clean" && node.status !== "ignored") {
      // Add all parent dirs
      const parts = fullPath.split("/");
      let p = "";
      for (const part of parts) {
        p = p ? `${p}/${part}` : part;
        paths.add(p);
      }
    }

    for (const child of node.children) {
      for (const p of this.findChangedPaths(child, fullPath)) {
        paths.add(p);
      }
    }

    return paths;
  }

  /** Animate the tree: only show folders along the path to changes, files that changed */
  private animateTreeOpen(
    node: FolderNode,
    changedPaths: Set<string>,
    removedFiles: string[],
    depth = 0,
    prefix = "",
  ) {
    const treeEl = this.treeEl!;
    let delay = 0;

    for (const child of node.children) {
      const fullPath = prefix ? `${prefix}/${child.name}` : child.name;
      const isOnChangedPath = changedPaths.has(fullPath);
      const isChanged = child.status !== "clean" && child.status !== "ignored";

      // Skip files/dirs not on the path to changes
      if (!isOnChangedPath && !isChanged) continue;

      // Skip if already shown
      if (this.shownPaths.has(fullPath) && child.kind === "file") continue;

      if (child.kind === "dir") {
        // Show folder opening
        if (!this.shownPaths.has(fullPath)) {
          this.shownPaths.add(fullPath);
          const row = this.createRow(child, depth, delay);
          treeEl.appendChild(row);
          delay += 0.2;
        }
        // Recurse into children
        this.animateTreeOpen(child, changedPaths, removedFiles, depth + 1, fullPath);
      } else {
        // Show file appearing
        this.shownPaths.add(fullPath);
        const row = this.createRow(child, depth, delay);
        treeEl.appendChild(row);

        // Flash effect for new/modified files
        const nameEl = row.querySelector(".viz-name") as HTMLElement;
        if (nameEl && isChanged) {
          const glowColor = child.status === "added" || child.status === "untracked"
            ? "0 0 15px rgba(110,231,160,0.6)"
            : child.status === "modified"
            ? "0 0 15px rgba(252,211,77,0.5)"
            : "none";
          gsap.to(nameEl, {
            textShadow: `${TEXT_SHADOW}, ${glowColor}`,
            duration: 0.4,
            delay: delay + 0.3,
            yoyo: true,
            repeat: 3,
          });
        }
        delay += 0.15;
      }
    }

    // Show removed files
    if (depth === 0 && removedFiles.length > 0) {
      for (const filePath of removedFiles) {
        const fileName = filePath.split("/").pop() || filePath;
        const row = document.createElement("div");
        Object.assign(row.style, {
          display: "flex",
          alignItems: "baseline",
          gap: "8px",
          paddingLeft: "20px",
          color: "#fca5a5",
          fontSize: "13px",
          fontFamily: "'SF Mono', 'Menlo', monospace",
          textShadow: TEXT_SHADOW,
          textDecoration: "line-through",
          opacity: "0",
          overflow: "hidden",
        });
        row.innerHTML = `<span>🗑️</span> <span>${fileName}</span>`;
        treeEl.appendChild(row);

        // Fade in, then collapse out
        gsap.to(row, { opacity: 1, duration: 0.3, delay: delay });
        gsap.to(row, {
          opacity: 0,
          height: 0,
          marginTop: 0,
          marginBottom: 0,
          x: -20,
          duration: 0.5,
          delay: delay + 2.5,
          ease: "power2.in",
          onComplete: () => row.remove(),
        });
        delay += 0.15;
      }
    }
  }

  private createRow(node: FolderNode, depth: number, delay: number): HTMLDivElement {
    const row = document.createElement("div");
    const color = STATUS_COLORS[node.status] || STATUS_COLORS.clean;
    const isDir = node.kind === "dir";

    Object.assign(row.style, {
      display: "flex",
      alignItems: "baseline",
      gap: "6px",
      paddingLeft: `${depth * 20}px`,
      opacity: "0",
      whiteSpace: "nowrap",
    });

    // Connector
    if (depth > 0) {
      const conn = document.createElement("span");
      conn.textContent = "├─";
      conn.style.color = "rgba(255,255,255,0.25)";
      conn.style.textShadow = TEXT_SHADOW;
      row.appendChild(conn);
    }

    // Icon
    const icon = document.createElement("span");
    icon.style.fontSize = "12px";
    icon.textContent = isDir ? "📂" : "📄";
    row.appendChild(icon);

    // Name
    const name = document.createElement("span");
    name.className = "viz-name";
    Object.assign(name.style, {
      color,
      fontWeight: isDir ? "700" : "400",
      fontSize: isDir ? "14px" : "13px",
      textShadow: TEXT_SHADOW,
    });
    name.textContent = node.name;
    row.appendChild(name);

    // Status badge for changed files
    if (!isDir && node.status !== "clean" && node.status !== "ignored") {
      const badge = document.createElement("span");
      Object.assign(badge.style, {
        fontSize: "10px",
        fontWeight: "700",
        color,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        textShadow: TEXT_SHADOW,
      });
      badge.textContent = node.status === "untracked" ? "new" : node.status;
      row.appendChild(badge);

      // Size hint
      if (node.size > 0) {
        const size = document.createElement("span");
        size.style.color = "rgba(255,255,255,0.3)";
        size.style.fontSize = "10px";
        size.style.textShadow = TEXT_SHADOW;
        size.textContent = `${(node.size / 1024).toFixed(1)}kb`;
        row.appendChild(size);
      }
    }

    // Animate in: slide from left
    gsap.set(row, { opacity: 0, x: -15 });
    gsap.to(row, {
      opacity: 1,
      x: 0,
      duration: 0.35,
      delay,
      ease: "power2.out",
    });

    return row;
  }

  private buildSpeech(data: FolderSummary): string {
    const p: string[] = [];
    if (data.added + data.untracked > 0) p.push(`${data.added + data.untracked} new.`);
    if (data.modified > 0) p.push(`${data.modified} modified.`);
    if (data.deleted > 0) p.push(`${data.deleted} deleted.`);
    if (p.length === 0) p.push("No changes.");
    return p.join(" ");
  }

  private async speak(text: string) {
    try {
      await fetch("http://127.0.0.1:9876/speak", { method: "POST", body: text });
    } catch {}
  }

  private fadeOut() {
    if (!this.card) return;
    const el = this.card;
    this.card = null;
    this.treeEl = null;
    this.headerEl = null;
    this.shownPaths.clear();
    gsap.to(el, {
      opacity: 0,
      y: -10,
      duration: 0.5,
      ease: "power2.in",
      onComplete: () => el.remove(),
    });
  }

  hide() {
    if (this.hideTimer) { clearTimeout(this.hideTimer); this.hideTimer = null; }
    if (this.card) {
      gsap.killTweensOf(this.card);
      this.card.remove();
      this.card = null;
      this.treeEl = null;
      this.headerEl = null;
      this.shownPaths.clear();
    }
  }

  async destroy() {
    for (const u of this.unlisteners) u();
    this.unlisteners = [];
    this.hide();
  }
}
