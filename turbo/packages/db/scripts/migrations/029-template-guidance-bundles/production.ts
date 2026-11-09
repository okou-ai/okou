import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, parseArgs, promisify } from "node:util";
import postgres from "postgres";
import { array, object, string } from "zod";
import { contentBundleDigest } from "@okouai/core/content-bundle";
import {
  BackfillError,
  inventorySchema,
  planSchema,
  objectConfiguration,
  validateSources,
} from "./plan";
import {
  BRANCH,
  BUCKET,
  ENDPOINT,
  PROJECT,
  censusRowSchema,
  contextSchema,
  metadataSchema,
  resolveTarget,
  validateApply,
  validateCensus,
  verifyPlanOrigin,
  verifyReviewedPlan,
  rolePermissionsSchema,
  validateRolePermissions,
  type Context,
} from "./production-guards";

async function readArguments() {
  const { values } = parseArgs({
    options: {
      operation: { type: "string" },
      context: { type: "string" },
      credentials: { type: "string" },
      request: { type: "string" },
      output: { type: "string" },
      reviewed: { type: "string" },
      "github-output": { type: "string" },
    },
  });
  if (!values.context || !values.credentials)
    throw new BackfillError("ProductionContextRequired");
  const context = contextSchema.parse(
    JSON.parse(await readFile(values.context, "utf8")),
  );
  validateApply(context);
  const credentials = object({ neon: string().min(1), github: string().min(1) })
    .strict()
    .parse(JSON.parse(await readFile(values.credentials, "utf8")));
  if (values.operation === "verify-origin") {
    if (!values["github-output"] || context.mode !== "apply-guidance")
      throw new BackfillError("ApplyOriginArgumentsRequired");
    return {
      operation: "verify-origin" as const,
      context,
      credentials,
      githubOutput: values["github-output"],
    };
  }
  if (
    values.operation !== "run" ||
    !values.request ||
    !values.output ||
    !values.reviewed
  )
    throw new BackfillError("ProductionArgumentsRequired");
  return {
    operation: "run" as const,
    context,
    credentials,
    output: values.output,
    request: values.request,
    reviewed: values.reviewed,
  };
}

async function readReviewed(
  context: Context,
  directory: string,
  token: string,
  inventory: ReturnType<typeof inventorySchema.parse>,
  inputBytes: Buffer,
  endpointId: string,
) {
  if (
    !isDeepStrictEqual((await readdir(directory)).sort(), [
      "inventory.json",
      "metadata.json",
      "plan.json",
    ])
  )
    throw new BackfillError("ReviewedArtifactFilesRejected");
  const origin = await verifyPlanOrigin(context, token);
  const bytes = await readFile(join(directory, "plan.json"));
  const reviewed = planSchema.parse(JSON.parse(bytes.toString("utf8")));
  const meta = metadataSchema.parse(
    JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")),
  );
  verifyReviewedPlan(
    context,
    meta,
    reviewed,
    inventory,
    contentBundleDigest(bytes),
    contentBundleDigest(inputBytes),
    origin.runAttempt,
  );
  if (meta.endpointId !== endpointId)
    throw new BackfillError("ProductionEndpointChanged");
  return reviewed;
}

async function main() {
  const values = await readArguments();
  const { context, credentials } = values;
  if (values.operation === "verify-origin") {
    const origin = await verifyPlanOrigin(context, credentials.github);
    await appendFile(
      values.githubOutput,
      `artifact-name=${origin.artifactName}\n`,
    );
    return;
  }
  const output = values.output;
  await mkdir(output, { mode: 0o700 });
  const privateDirectory = await mkdtemp(
    join(tmpdir(), "template-production-"),
  );
  const cancellation = new AbortController();
  const cancel = () => {
    return cancellation.abort();
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);
  let db: ReturnType<typeof postgres> | undefined;
  try {
    const applying = context.mode === "apply-guidance";
    const inputPath = applying
      ? join(values.reviewed, "inventory.json")
      : join(values.request, "inventory.json");
    const inputBytes = await readFile(inputPath);
    const inventory = inventorySchema.parse(
      JSON.parse(inputBytes.toString("utf8")),
    );
    validateSources(inventory.rows);
    const target = await resolveTarget(context.mode, credentials.neon);
    const objects = objectConfiguration();
    if (
      objects.bucket !== BUCKET ||
      objects.endpoint.origin !== ENDPOINT ||
      !isDeepStrictEqual(inventory.scope, target.scope)
    )
      throw new BackfillError("ProductionScopeRejected");
    const reviewed = applying
      ? await readReviewed(
          context,
          values.reviewed,
          credentials.github,
          inventory,
          inputBytes,
          target.endpointId,
        )
      : undefined;
    cancellation.signal.throwIfAborted();
    const credentialFile = join(privateDirectory, "database-url");
    await writeFile(credentialFile, target.connection, {
      mode: 0o600,
      flag: "wx",
    });
    db = postgres(target.connection, {
      max: 1,
      connect_timeout: 10,
      connection: {
        default_transaction_read_only: true,
        statement_timeout: 30_000,
      },
      onnotice() {},
    });
    const [permissions] = array(rolePermissionsSchema).parse(
      await db`
      SELECT current_user AS role, current_setting('transaction_read_only') = 'on' AS readonly,
        has_table_privilege(current_user, 'public.user_templates', 'SELECT') AS "selectUser",
        has_table_privilege(current_user, 'public.presentation_templates', 'SELECT') AS "selectPresentation",
        (has_table_privilege(current_user, 'public.user_templates', 'INSERT,UPDATE,DELETE,TRUNCATE') OR
          has_any_column_privilege(current_user, 'public.user_templates', 'INSERT,UPDATE')) AS "writableUser",
        (has_table_privilege(current_user, 'public.presentation_templates', 'INSERT,UPDATE,DELETE,TRUNCATE') OR
          has_any_column_privilege(current_user, 'public.presentation_templates', 'INSERT,UPDATE')) AS "writablePresentation"`,
    );
    validateRolePermissions(permissions, target.role, applying);
    const load = async () => {
      const rows = [];
      for (const ownerKind of [
        "user-template",
        "presentation-template",
      ] as const) {
        const table =
          ownerKind === "user-template"
            ? "user_templates"
            : "presentation_templates";
        const values = await db!`
          SELECT t.id, t.xmin::text AS revision, md5((to_jsonb(t) - 'guidance_bundle')::text) AS fingerprint,
            t.org_id AS "orgId", t.owner_user_id AS "ownerUserId", t.updated_at::text AS "updatedAt", t.guidance_bundle AS bundle
          FROM public.${db!(table)} t ORDER BY t.id LIMIT 101`;
        rows.push(
          ...values.map((row) => {
            return censusRowSchema.parse({ ...row, ownerKind });
          }),
        );
      }
      return rows;
    };
    const before = await load();
    validateCensus(before, inventory.rows, reviewed?.rows);
    const write = async (name: string, value: unknown) => {
      return writeFile(
        join(output, name),
        JSON.stringify(value, null, 2) + "\n",
        {
          flag: "wx",
          mode: 0o600,
        },
      );
    };
    if (applying) {
      await copyFile(
        join(values.reviewed, "plan.json"),
        join(output, "plan.json"),
      );
      await write("binding.json", {
        ...context,
        project: PROJECT,
        branch: BRANCH,
        endpointId: target.endpointId,
        scope: target.scope,
        startedAt: new Date().toISOString(),
      });
      await write("owners-before.json", before);
    }
    const planPath = applying
      ? join(values.reviewed, "plan.json")
      : join(output, "plan.json");
    const args = applying
      ? [
          "--migrate",
          "--writers-drained",
          "--plan-file",
          planPath,
          "--expect-plan-sha256",
          context.planSha256,
          "--output",
          join(output, "receipt.ndjson"),
        ]
      : ["--inventory", inputPath, "--output", planPath];
    cancellation.signal.throwIfAborted();
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/migrations/029-template-guidance-bundles/backfill.ts",
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH,
          NODE_OPTIONS: "--max-old-space-size=1536",
          DATABASE_URL_FILE: credentialFile,
          R2_ENDPOINT: objects.endpoint.origin,
          R2_USER_STORAGES_BUCKET_NAME: objects.bucket,
          R2_ACCESS_KEY_ID: objects.credentials.accessKeyId,
          R2_SECRET_ACCESS_KEY: objects.credentials.secretAccessKey,
        },
        timeout: 600_000,
        signal: cancellation.signal,
        maxBuffer: 1024 * 1024,
      },
    );
    process.stdout.write(result.stdout);
    const after = await load();
    if (applying) {
      validateCensus(after, inventory.rows, reviewed!.rows);
      if (
        reviewed!.rows.some((r) => {
          return !isDeepStrictEqual(
            after.find((o) => {
              return (
                o.id === r.source.templateId &&
                o.ownerKind === r.source.ownerKind
              );
            })?.bundle,
            r.bundle,
          );
        })
      )
        throw new BackfillError("ProductionPublicationNotVerified");
      await write("owners-after.json", after);
      await write("summary.json", {
        complete: true,
        planSha256: context.planSha256,
        rows: reviewed!.rows.length,
        nonBundleOwnerFieldsPreserved: true,
        finishedAt: new Date().toISOString(),
        scope: target.scope,
      });
    } else {
      if (!isDeepStrictEqual(before, after))
        throw new BackfillError("ProductionOwnersChangedDuringPlanning");
      const bytes = await readFile(planPath);
      const plan = planSchema.parse(JSON.parse(bytes.toString("utf8")));
      if (
        !plan.complete ||
        plan.failures.length ||
        plan.rows.length !== inventory.rows.length
      )
        throw new BackfillError("IncompleteProductionPlan");
      await writeFile(join(output, "inventory.json"), inputBytes, {
        mode: 0o600,
        flag: "wx",
      });
      await write(
        "metadata.json",
        metadataSchema.parse({
          format: "template-guidance-production-plan-v1",
          commit: context.commit,
          runId: context.runId,
          runAttempt: context.runAttempt,
          actor: context.actor,
          createdAt: new Date().toISOString(),
          project: PROJECT,
          branch: BRANCH,
          endpointId: target.endpointId,
          planSha256: contentBundleDigest(bytes),
          inventorySha256: contentBundleDigest(inputBytes),
        }),
      );
    }
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    try {
      await db?.end({ timeout: 5 });
    } finally {
      await rm(privateDirectory, { recursive: true, force: true });
    }
  }
}
try {
  await main();
} catch (error) {
  process.stderr.write(
    (error instanceof BackfillError
      ? error.message
      : "ProductionGuidanceFailed") + "\n",
  );
  process.exitCode = 1;
}
