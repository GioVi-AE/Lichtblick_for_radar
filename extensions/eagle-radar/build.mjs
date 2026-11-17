// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary
// Bundles the extension into a single CommonJS file understood by Lichtblick's extension loader.
import { build } from "esbuild";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2020",
  minify: true,
  sourcemap: false,
  logLevel: "info",
  loader: { ".css": "text" },
  // Lichtblick only provides react / react-dom; we use neither (vanilla DOM panels).
  external: ["react", "react-dom"],
});

// Manifest consumed by the built-in extension loader (see packages/suite-web BuiltinExtensionLoader).
writeFileSync(
  "dist/manifest.json",
  JSON.stringify(
    {
      extensions: [
        {
          id: `${pkg.publisher.toLowerCase()}.${pkg.name}`,
          name: pkg.name,
          qualifiedName: pkg.name,
          displayName: pkg.displayName,
          description: pkg.description,
          publisher: pkg.publisher,
          version: pkg.version,
          license: pkg.license,
          homepage: pkg.homepage,
          keywords: pkg.keywords,
          bundle: "extension.js",
        },
      ],
    },
    null,
    2,
  ),
);
