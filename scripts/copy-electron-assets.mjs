// Copies the electron files tsc doesn't compile (static HTML/CSS, the
// hand-written CommonJS preload) next to the compiled main.ts/renderer.ts
// output, so everything Electron loads lives together under dist/electron/.
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rendererSrc = path.join(root, "src", "electron", "renderer");
const rendererDist = path.join(root, "dist", "electron", "renderer");
const fontsourceDir = path.join(root, "node_modules", "@fontsource");

mkdirSync(path.join(rendererDist, "fonts"), { recursive: true });

cpSync(path.join(rendererSrc, "index.html"), path.join(rendererDist, "index.html"));
cpSync(path.join(rendererSrc, "styles.css"), path.join(rendererDist, "styles.css"));
cpSync(path.join(rendererSrc, "icon-512.png"), path.join(rendererDist, "icon-512.png"));
cpSync(path.join(root, "src", "electron", "preload.cjs"), path.join(root, "dist", "electron", "preload.cjs"));

const fontFiles = [
  ["jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2"],
  ["jetbrains-mono", "jetbrains-mono-latin-500-normal.woff2"],
  ["public-sans", "public-sans-latin-400-normal.woff2"],
  ["public-sans", "public-sans-latin-500-normal.woff2"],
  ["public-sans", "public-sans-latin-600-normal.woff2"],
  ["source-serif-4", "source-serif-4-latin-400-normal.woff2"],
  ["source-serif-4", "source-serif-4-latin-600-normal.woff2"],
];
for (const [pkg, file] of fontFiles) {
  cpSync(path.join(fontsourceDir, pkg, "files", file), path.join(rendererDist, "fonts", file));
}
