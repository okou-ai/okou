import { parseArgs } from "node:util";
import { readPrivate, sha256, writePrivate } from "./execution-model";
import {
  packageKey,
  sealBytes,
  openExecutionDirectory,
} from "./production-package";
import { parseAgentPrefixes } from "./plan-names";
import { productionMetadataSchema } from "./production-model";
import { PlanningError } from "./snapshot";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "key-file": { type: "string" },
      metadata: { type: "string" },
    },
  });
  if (
    positionals.length !== 1 ||
    !values.input ||
    !values.output ||
    !values["key-file"]
  )
    throw new PlanningError(
      "UseSealPrefixesOrOpenWithInputOutputAndPrivateKeyFile",
    );
  const key = packageKey(
    (await readPrivate(values["key-file"])).toString("utf8").trim(),
  );
  if (positionals[0] === "seal-prefixes" && !values.metadata) {
    const bytes = await readPrivate(values.input);
    parseAgentPrefixes(JSON.parse(bytes.toString("utf8")));
    await writePrivate(
      values.output,
      sealBytes(bytes, key, "single-agent-production-prefixes-v1").toString(
        "base64",
      ) + "\n",
    );
    console.log(
      JSON.stringify({
        command: "seal-prefixes",
        output: values.output,
        prefixesSha256: sha256(bytes),
      }),
    );
  } else if (positionals[0] === "open" && values.metadata) {
    const meta = productionMetadataSchema.parse(
      JSON.parse((await readPrivate(values.metadata)).toString("utf8")),
    );
    await openExecutionDirectory(
      values.input,
      values.output,
      key,
      JSON.stringify(meta),
    );
    console.log(
      JSON.stringify({
        command: "open",
        directory: values.output,
        imageSha256: meta.imageSha256,
      }),
    );
  } else throw new PlanningError("UseSealPrefixesOrOpenWithMetadata");
}

await main().catch((error: unknown) => {
  console.error(
    error instanceof PlanningError
      ? error.message
      : error instanceof Error
        ? error.name
        : "ProductionPackageFailed",
  );
  process.exitCode = 1;
});
