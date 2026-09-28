// Bundles vendor/freellmapi's server into dist/freellmapi/server.mjs and
// stages its built dashboard into dist/freellmapi/client-dist — same
// recipe as vendor/freellmapi/desktop/scripts/bundle-server.mjs (built
// FROM the entry point that file's own bundle-server.mjs targets,
// desktop/src/server-host.ts), run against the vendored source directly
// rather than duplicating that script's logic by hand.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function buildFreellmapiBundle(repoRoot) {
  const vendorDir = path.join(repoRoot, "vendor", "freellmapi");
  const outDir = path.join(repoRoot, "dist", "freellmapi");
  fs.mkdirSync(outDir, { recursive: true });

  // The dashboard: vendor/freellmapi's own client workspace, built with its
  // own toolchain (tsc -b && vite build per client/package.json), then
  // copied into dist/freellmapi/client-dist — same "stage it, don't
  // reference it across a relative ../ boundary" reasoning as their own
  // desktop/scripts/stage-client.mjs, which exists specifically because a
  // reached-above-the-app-dir path broke electron-builder on Windows.
  execFileSync("npm", ["ci"], { cwd: vendorDir, stdio: "inherit" });
  execFileSync("npm", ["run", "build", "-w", "client"], { cwd: vendorDir, stdio: "inherit" });
  const clientSrc = path.join(vendorDir, "client", "dist");
  const clientDest = path.join(outDir, "client-dist");
  fs.rmSync(clientDest, { recursive: true, force: true });
  fs.cpSync(clientSrc, clientDest, { recursive: true });

  // The server: identical esbuild options to vendor/freellmapi's own
  // desktop/scripts/bundle-server.mjs (entry point, external, target,
  // banner for express's runtime `require` under ESM) - see that file for
  // why each option is there; not re-explained here to avoid the two
  // drifting out of sync in prose while the actual options do.
  await build({
    entryPoints: [path.join(vendorDir, "desktop", "src", "server-host.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: path.join(outDir, "server.mjs"),
    external: ["better-sqlite3"],
    banner: {
      js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    },
    logLevel: "info",
  });
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  await buildFreellmapiBundle(repoRoot);
  console.log("[build] wrote dist/freellmapi/server.mjs and dist/freellmapi/client-dist/");
}
