import path from "node:path";

import { verifyBundle } from "./bundle.mjs";
import {
  outputFormatOption,
  requiredOption,
  validateOptions,
} from "./options.mjs";

const args = process.argv.slice(2);
validateOptions(args, ["--format", "--output-dir"]);
await verifyBundle(
  path.resolve(requiredOption(args, "--output-dir")),
  outputFormatOption(args),
);
