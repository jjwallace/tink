import { Application, Container } from "pixi.js";

let app: Application | null = null;
let initialized = false;

export async function getPixiApp(container: HTMLElement): Promise<Application> {
  if (app && initialized) return app;

  const canvas = document.createElement("canvas");
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  // z-index:99995 puts the Pixi layer behind the voice anchor root
  // (99998) and the tentacles canvas (99996).
  canvas.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:99995;";

  // Force WebGL context with transparency settings BEFORE Pixi touches it
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: false,
    antialias: true,
    depth: false,
    stencil: false,
  });

  if (!gl) {
    console.error("WebGL2 not available, Pixi VFX disabled");
    container.appendChild(canvas);
    app = new Application();
    await app.init({ canvas, backgroundAlpha: 0, resizeTo: window, resolution: 1 });
    initialized = true;
    return app;
  }

  // Clear to transparent
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  container.appendChild(canvas);

  app = new Application();
  await app.init({
    canvas,
    backgroundAlpha: 0,
    resizeTo: window,
    antialias: true,
    resolution: 1,
    autoDensity: false,
  });

  initialized = true;

  // Quick test — draw a visible element to verify rendering works
  console.log("Pixi app initialized, renderer:", app.renderer.type);

  return app;
}

export function getScreenSize(): { width: number; height: number } {
  if (app) return { width: app.screen.width, height: app.screen.height };
  return { width: window.innerWidth, height: window.innerHeight };
}

export function createLayer(name: string): Container {
  if (!app) throw new Error("Pixi app not initialized");
  const layer = new Container();
  layer.label = name;
  app.stage.addChild(layer);
  return layer;
}

export function destroyPixiApp() {
  if (app) {
    app.destroy(true);
    app = null;
    initialized = false;
  }
}
