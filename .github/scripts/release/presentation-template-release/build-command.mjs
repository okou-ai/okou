import path from "node:path";

import { buildBundle } from "./bundle.mjs";
import { requiredOption } from "./options.mjs";

const args = process.argv.slice(2);
await buildBundle({
  sourceDir: path.resolve(requiredOption(args, "--source-dir")),
  outputDir: path.resolve(requiredOption(args, "--output-dir")),
  sourceCommit: requiredOption(args, "--source-commit"),
});
