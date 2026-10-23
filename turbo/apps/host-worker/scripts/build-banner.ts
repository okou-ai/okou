import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { build } from "esbuild";

const directory = fileURLToPath(new URL("../", import.meta.url));
const ui = fileURLToPath(new URL("../../../packages/ui/", import.meta.url));
const source = `${ui}src/styles/globals.css`;
const input =
  (await readFile(source, "utf8")).replace(
    '@import "tailwindcss";',
    '@import "tailwindcss" source(none);',
  ) +
  `\n@source "${ui}src/components/ui/artifact-banner.tsx";\n@source "${ui}src/components/ui/button.tsx";\n@source "${ui}src/components/ui/button-base.tsx";`;
const result = await postcss([tailwind({ base: ui, optimize: true })]).process(
  input,
  { from: source },
);
const bundle = await build({
  entryPoints: [`${directory}src/site-banner-client.ts`],
  bundle: true,
  write: false,
  minify: true,
  format: "iife",
  platform: "browser",
});
// Shadow DOM still resolves rem against the publisher's document root. Keep
// the App's 16px design baseline without changing the publisher's typography.
function designPixels(value: string) {
  return value.replace(/(-?\d*\.?\d+)rem\b/gu, (_, amount: string) => {
    return `${Number(amount) * 16}px`;
  });
}
result.root.walkDecls((declaration) => {
  declaration.value = designPixels(declaration.value);
});
result.root.walkAtRules((rule) => {
  if (rule.name === "media" || rule.name === "container")
    rule.params = designPixels(rule.params);
});
// Root design tokens are scoped to the isolated brand bar, not the publisher DOM.
const css = result.root.toString().replaceAll(":root", ":host");
const generated =
  JSON.stringify({ css, script: bundle.outputFiles[0]!.text }, null, 2) + "\n";
const output = `${directory}src/site-banner-assets.json`;
if (process.argv.includes("--check")) {
  if ((await readFile(output, "utf8")) !== generated)
    throw new Error("Site banner assets are stale; run pnpm build:banner");
} else {
  await writeFile(output, generated);
}
