import { parseArgs } from "node:util";
import { digestSchema, STAFF_ORG } from "./production-model";
import { PlanningError } from "./snapshot";

const help = `Single Agent production migration (manual, staff-only)

[target] --org-id <staff-org-id>
  Inspect protected production branch and configured capacity; request no DB credential.
[plan] --org-id <staff-org-id> --agent-prefixes <private-json>
  --directory <new-private-directory> --key-file <private-key> --writers-drained
  Read-only planning is the default. Save an encrypted complete recovery image.
apply|recover --org-id <staff-org-id> --plan-directory <reviewed-plan-directory>
  --expect-plan-sha256 <hash> --expect-image-sha256 <hash>
  --directory <new-private-attempt-directory> --key-file <private-key>
  --writers-drained --migrate
verify --org-id <staff-org-id> --plan-directory <reviewed-plan-directory>
  --expect-plan-sha256 <hash> --expect-image-sha256 <hash>
  --directory <new-private-attempt-directory> --key-file <private-key>

NEON_API_KEY supplies metadata authority, never a connection-URI lookup.
DATABASE_URL_FILE selects an owner-only connection file (RO for plan/verify,
neondb_owner for apply/recover). CLERK_SECRET_KEY and explicit R2 configuration
are required outside target inspection. Use the exact clean reviewed Git checkout.
No GitHub workflow, repository secret, deployment hook or automatic apply is used.`;

type TargetOptions = { mode: "target"; orgId: typeof STAFF_ORG };
type FileOptions = {
  orgId: typeof STAFF_ORG;
  directory: string;
  keyFile: string;
};
export type PlanOptions = FileOptions & { mode: "plan"; prefixesFile: string };
export type ReviewedOptions = FileOptions & {
  mode: "apply" | "verify" | "recover";
  planDirectory: string;
  planSha256: string;
  imageSha256: string;
};
export type OperationOptions = PlanOptions | ReviewedOptions;

function readArguments() {
  return parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      "org-id": { type: "string" },
      directory: { type: "string" },
      "key-file": { type: "string" },
      "agent-prefixes": { type: "string" },
      "plan-directory": { type: "string" },
      "expect-plan-sha256": { type: "string" },
      "expect-image-sha256": { type: "string" },
      "writers-drained": { type: "boolean" },
      migrate: { type: "boolean" },
    },
  });
}

type Arguments = ReturnType<typeof readArguments>["values"];

function readPlanOptions(files: FileOptions, values: Arguments): PlanOptions {
  if (
    !values["agent-prefixes"] ||
    !values["writers-drained"] ||
    values.migrate ||
    values["plan-directory"] ||
    values["expect-plan-sha256"] ||
    values["expect-image-sha256"]
  )
    throw new PlanningError(
      "ReadOnlyPlanRequiresFixedPrefixesAndDrainedWriters",
    );
  return { ...files, mode: "plan", prefixesFile: values["agent-prefixes"] };
}

function readReviewedOptions(
  files: FileOptions,
  values: Arguments,
  mode: ReviewedOptions["mode"],
): ReviewedOptions {
  if (
    !values["plan-directory"] ||
    !digestSchema.safeParse(values["expect-plan-sha256"]).success ||
    !digestSchema.safeParse(values["expect-image-sha256"]).success ||
    values["agent-prefixes"]
  )
    throw new PlanningError("ReviewedPlanDirectoryAndExactHashesRequired");
  if (
    mode === "verify"
      ? values.migrate || values["writers-drained"]
      : !values.migrate || !values["writers-drained"]
  )
    throw new PlanningError(
      "MutationRequiresMigrateAndDrainedWriters; verify accepts neither",
    );
  return {
    ...files,
    mode,
    planDirectory: values["plan-directory"],
    planSha256: digestSchema.parse(values["expect-plan-sha256"]),
    imageSha256: digestSchema.parse(values["expect-image-sha256"]),
  };
}

export function readProductionOptions():
  TargetOptions | OperationOptions | undefined {
  const { values, positionals } = readArguments();
  if (values.help) {
    console.log(help);
    return;
  }
  const [mode = "plan"] = positionals;
  if (
    positionals.length > 1 ||
    values["org-id"] !== STAFF_ORG ||
    !["target", "plan", "apply", "verify", "recover"].includes(mode)
  )
    throw new PlanningError(
      "ExplicitStaffOrgAndValidCommandRequired; use --help",
    );
  if (mode === "target") {
    if (
      Object.entries(values).some(([name, value]) => {
        return name !== "org-id" && value !== undefined;
      })
    )
      throw new PlanningError("TargetInspectionAcceptsOnlyOrgId");
    return { mode, orgId: STAFF_ORG };
  }
  if (!values.directory || !values["key-file"])
    throw new PlanningError("PrivateDirectoryAndKeyFileRequired");
  const files: FileOptions = {
    orgId: STAFF_ORG,
    directory: values.directory,
    keyFile: values["key-file"],
  };
  if (mode === "plan") return readPlanOptions(files, values);
  if (mode !== "apply" && mode !== "verify" && mode !== "recover")
    throw new PlanningError("UnknownProductionCommand");
  return readReviewedOptions(files, values, mode);
}
