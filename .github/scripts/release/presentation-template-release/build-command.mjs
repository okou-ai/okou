import path from "node:path";

import { buildBundle } from "./bundle.mjs";
import {
  outputFormatOption,
  requiredOption,
  validateOptions,
} from "./options.mjs";

const args = process.argv.slice(2);
validateOptions(args, [
  "--format",
  "--source-dir",
  "--source-commit",
  "--output-dir",
]);
await buildBundle({
  sourceDir: path.resolve(requiredOption(args, "--source-dir")),
  outputDir: path.resolve(requiredOption(args, "--output-dir")),
  sourceCommit: requiredOption(args, "--source-commit"),
  outputFormat: outputFormatOption(args),
});
