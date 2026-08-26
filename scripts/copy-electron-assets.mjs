// Copies the electron files tsc doesn't compile (static HTML/CSS, the
// hand-written CommonJS preload) next to the compiled main.ts/renderer.ts
// output, so everything Electron loads lives together under dist/electron/.
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererSrc = path.join(root, "src", "electron", "renderer");
const rendererDist = path.join(root, "dist", "electron", "renderer");
const fontPkg = path.join(root, "node_modules", "@fontsource", "jetbrains-mono", "files");

mkdirSync(path.join(rendererDist, "fonts"), { recursive: true });

cpSync(path.join(rendererSrc, "index.html"), path.join(rendererDist, "index.html"));
cpSync(path.join(rendererSrc, "styles.css"), path.join(rendererDist, "styles.css"));
cpSync(path.join(rendererSrc, "icon-512.png"), path.join(rendererDist, "icon-512.png"));
cpSync(path.join(root, "src", "electron", "preload.cjs"), path.join(root, "dist", "electron", "preload.cjs"));

for (const file of ["jetbrains-mono-latin-400-normal.woff2", "jetbrains-mono-latin-500-normal.woff2"]) {
  cpSync(path.join(fontPkg, file), path.join(rendererDist, "fonts", file));
}
