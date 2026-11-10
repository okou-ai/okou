import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { inventory } from "./inventory";
import { plan } from "./plan";
import { parseSnapshot, PlanningError } from "./snapshot";

const help = `Read-only Single Agent migration preparation

inventory --org-id <id> --target <label> --output <new-private-file>
  Read one org using DATABASE_URL with database-enforced read-only access.
plan --org-id <id> --inventory <file> --output <new-private-file>
  Generate an offline, non-executable dry-run plan. Exit 2 reports blockers.

No apply, publication, feature activation or recovery command is implemented.`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      "org-id": { type: "string" },
      target: { type: "string" },
      output: { type: "string" },
      inventory: { type: "string" },
    },
  });
  if (values.help) {
    console.log(help);
    return;
  }
  const [command] = positionals;
  const orgId = values["org-id"];
  if (
    positionals.length !== 1 ||
    !orgId?.trim() ||
    !values.output ||
    (command !== "inventory" && command !== "plan") ||
    (command === "inventory"
      ? !values.target?.trim() || values.inventory
      : !values.inventory || values.target)
  ) {
    throw new PlanningError(
      "UseInventoryOrPlanWithExplicitOrgAndNewOutputFile; use --help",
    );
  }
  let result: unknown;
  let blocked = false;
  if (command === "inventory") {
    const connection = process.env.DATABASE_URL;
    if (!connection) throw new PlanningError("DATABASE_URLRequired");
    result = await inventory(connection, orgId, values.target!);
  } else {
    const bytes = await readFile(values.inventory!);
    const snapshot = parseSnapshot(JSON.parse(bytes.toString("utf8")));
    const planned = plan(
      snapshot,
      orgId,
      createHash("sha256").update(bytes).digest("hex"),
    );
    result = planned;
    blocked = planned.blockers.length > 0;
  }
  const bytes = Buffer.from(JSON.stringify(result, null, 2) + "\n");
  const output = await open(values.output, "wx", 0o600);
  try {
    await output.writeFile(bytes);
  } finally {
    await output.close();
  }
  console.log(
    JSON.stringify({
      command,
      output: values.output,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      blocked,
      executable: false,
    }),
  );
  if (blocked) process.exitCode = 2;
}

main().catch((error: unknown) => {
  // Raw database/validation errors can contain source content or connection data.
  console.error(
    error instanceof PlanningError
      ? error.message
      : error instanceof Error
        ? error.name
        : "PreparationFailed",
  );
  process.exitCode = 1;
});
