import path from "node:path";

import { requiredOption } from "./options.mjs";
import { publishBundle } from "./publisher.mjs";

const args = process.argv.slice(2);
await publishBundle(path.resolve(requiredOption(args, "--output-dir")));
