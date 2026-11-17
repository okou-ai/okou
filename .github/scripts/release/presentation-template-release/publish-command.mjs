import path from "node:path";

import {
  outputFormatOption,
  requiredOption,
  validateOptions,
} from "./options.mjs";
import { publishBundle } from "./publisher.mjs";

const args = process.argv.slice(2);
validateOptions(
  args,
  ["--format", "--output-dir"],
  ["--initialize-missing-heads"],
);
await publishBundle(path.resolve(requiredOption(args, "--output-dir")), {
  outputFormat: outputFormatOption(args),
  initializeMissingHeads: args.includes("--initialize-missing-heads"),
});
