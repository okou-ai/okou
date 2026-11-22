import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { expectClerkTestInstance, signInWithClerkEmailCode } from "./lib/auth";
import { parseClerkTestEmail } from "./lib/clerk-api";
import { seedPreviewBypassCookie } from "./lib/preview-bypass";

async function applyPostmarkPermission() {
  const action = process.argv[2];
  if (action !== "deny" && action !== "allow") {
    throw new Error("Expected an allow or deny action");
  }
  const email = process.env.E2E_RUNNER_MOCK_CLAUDE_EMAIL;
  const organizationId = process.env.E2E_RUNNER_MOCK_CLAUDE_ORG_ID;
  if (
    !email ||
    parseClerkTestEmail(email)?.role !== "runner-mock-claude" ||
    !organizationId
  ) {
    throw new Error("Expected the mock Runner workspace member");
  }
  const credential: { appUrl?: unknown; apiUrl?: unknown } = JSON.parse(
    await readFile("/tmp/e2e-api-credentials-runner-mock-claude.json", "utf8"),
  );
  if (
    typeof credential.appUrl !== "string" ||
    typeof credential.apiUrl !== "string"
  ) {
    throw new Error("Expected the mock Runner preview URLs");
  }
  const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await seedPreviewBypassCookie(context, credential.appUrl, bypass);
    const page = await context.newPage();
    const token = await signInWithClerkEmailCode(
      page,
      email,
      credential.appUrl,
      {
        activeOrganizationId: organizationId,
      },
    );
    await expectClerkTestInstance(page);
    const headers = new Headers({
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    });
    if (bypass) {
      headers.set("x-vercel-protection-bypass", bypass);
    }
    const response = await fetch(
      new URL("/api/connector-permissions", credential.apiUrl),
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          target: { kind: "builtin", connectorSlug: "postmark" },
          mode: "patch",
          grants: [
            {
              permission: "templates.manage",
              action,
              ...(action === "allow" ? { expiresIn: "1h" } : {}),
            },
          ],
        }),
      },
    );
    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(
        `Postmark permission update failed with HTTP ${response.status}`,
      );
    }
  } finally {
    await browser.close();
  }
}

void applyPostmarkPermission().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "Permission update failed",
  );
  process.exitCode = 1;
});
