/**
 * Creature settings — simplified port from telemorph. No GUI, no persistence.
 * Values are module-level mutable singletons read every frame by the renderer.
 * To tune, either mutate S directly or add fields to the native SettingsPanel.
 */

export interface Settings {
  headRadius: number;
  tentacles: number;
  thickness: number;
  length: number;
  gravity: number;
  wind: number;
  friction: number;
  uniform: boolean;
  uniformRadius: number;
  uniformSpacing: number;
  hue: number;
  saturation: number;
  lightness: number;
  glowAmount: number;
  particleSize: number;
  particlePool: number;
  particleRate: number;
  interactive: boolean;
  notifyEdge: "left" | "right" | "up" | "down";
  companions: boolean;
  companionCount: number; // 0-3; how many tinks are currently revealed
  anticipation: boolean;
  pursuit: boolean;
  gestureChunking: boolean;
}

const DEFAULTS: Settings = {
  headRadius: 3.63533094,
  tentacles: 12,
  thickness: 2.3686,
  length: 12.286,
  gravity: 0,
  wind: 0,
  friction: 0.181,
  uniform: false,
  uniformRadius: 1.8157670193979998,
  uniformSpacing: 0.1,
  hue: 360,
  saturation: 1,
  lightness: 1,
  glowAmount: 0,
  particleSize: 1,
  particlePool: 300,
  particleRate: 5,
  interactive: false,
  notifyEdge: "up" as const,
  companions: true,
  companionCount: 0,
  anticipation: true,
  pursuit: true,
  gestureChunking: true,
};

export const S: Settings = { ...DEFAULTS };

export function save(): void { /* noop in native */ }
