import { createHmac } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Both jobs already use the same test instance. Scope the fixture key to this
// workflow run. Retrying only the failed job must reuse the deployed key.
export function previewClerkWebhookKey(): string {
  const {
    CLERK_SECRET_KEY: testKey,
    GITHUB_REPOSITORY_ID: repo,
    GITHUB_RUN_ID: run,
    GITHUB_EVENT_NAME: event,
    JOB_REF: preview,
  } = process.env;
  if (
    !testKey?.startsWith("sk_test_") ||
    !repo ||
    !/^\d+$/.test(repo) ||
    !run ||
    !/^\d+$/.test(run) ||
    !preview ||
    !/^pr-[1-9]\d*$/.test(preview) ||
    (event !== "pull_request" && event !== "merge_group")
  ) {
    throw new Error(
      "Clerk fixture requires an isolated PR preview and a test instance",
    );
  }
  const context = JSON.stringify([
    "okou-ci/preview-clerk-webhook/v1",
    repo,
    preview,
    run,
  ]);
  return (
    "whsec_" + createHmac("sha256", testKey).update(context).digest("base64")
  );
}

export function configurePreviewClerkWebhook(envFile: string): void {
  const contents = readFileSync(envFile, "utf8");
  const field = /^CLERK_WEBHOOK_SIGNING_SECRET=.*$/m;
  if (!field.test(contents)) {
    throw new Error(
      "Missing Clerk webhook setting in rendered API environment",
    );
  }
  const key = previewClerkWebhookKey();
  console.log(`::add-mask::${key}`);
  writeFileSync(
    envFile,
    contents.replace(field, `CLERK_WEBHOOK_SIGNING_SECRET=${key}`),
  );
}
