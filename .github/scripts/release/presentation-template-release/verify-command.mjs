import path from "node:path";

import { verifyBundle } from "./bundle.mjs";
import { requiredOption } from "./options.mjs";

const args = process.argv.slice(2);
await verifyBundle(path.resolve(requiredOption(args, "--output-dir")));
