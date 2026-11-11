import { parseArgs } from "node:util";
import { readPrivate } from "./execution-model";
import { packageKey, openExecutionDirectory } from "./production-package";
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
    throw new PlanningError("UseOpenWithInputOutputMetadataAndPrivateKeyFile");
  const key = packageKey(
    (await readPrivate(values["key-file"])).toString("utf8").trim(),
  );
  if (positionals[0] === "open" && values.metadata) {
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
  } else throw new PlanningError("UseOpenWithMetadata");
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
