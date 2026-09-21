import path from "node:path";

import { requiredOption } from "../presentation-template-release/options.mjs";
import { prepareBundle, verifyBundle } from "./bundle.mjs";

const [command, ...args] = process.argv.slice(2);
const outputDir = path.resolve(requiredOption(args, "--output-dir"));
if (command === "prepare") {
  await prepareBundle(
    path.resolve(requiredOption(args, "--source-archive")),
    outputDir,
  );
} else if (command !== "verify") {
  throw new Error("Expected prepare or verify.");
}
const publication = await verifyBundle(outputDir);
process.stdout.write(
  `${JSON.stringify({ status: "prepared-only", ...publication }, null, 2)}\n`,
);
