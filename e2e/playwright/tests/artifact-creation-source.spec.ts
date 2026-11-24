import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  request as playwrightRequest,
  type APIResponse,
  type Locator,
} from "@playwright/test";
import { Webhook } from "standardwebhooks";
import { CURRENT_CHAT_EVENT_SCHEMA_VERSION } from "../../../turbo/packages/api-contracts/src/contracts/chat-event-schema-version";
import { FeatureSwitchKey } from "../../../turbo/packages/core/src/feature-switch-key";
import { previewClerkWebhookKey } from "../../scripts/preview-clerk-webhook-key";
import { resolveApiBackendUrl } from "../api-backend-url";
import { expect, test } from "../fixtures";
import {
  refreshClerkSessionToken,
  signInWithClerkEmailCode,
} from "../lib/auth";
import {
  createOrganizationRecord,
  createUser,
  generateTestEmail,
} from "../lib/clerk-api";
import {
  authHeadersForToken,
  completePromptOnboarding,
} from "../lib/onboarding";
import { deriveAppUrl } from "../playwright.config";

// Credential-bearing traces stay out of downloadable acceptance evidence.
// The existing trusted CI fixture owns Clerk and preview credentials.
test.use({ trace: "off", screenshot: "off" });
test.describe.configure({ retries: 0 });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an API object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("Expected a nonempty API string");
  }
  return value;
}

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected an API array");
  }
  return value.map(record);
}

async function json(response: APIResponse, status = 200) {
  expect(response.status(), "Public API response status").toBe(status);
  return record(await response.json());
}

function publisherPrompt(
  apiUrl: string,
  prefix: string,
  revision: number,
): string {
  const config = JSON.stringify({ apiUrl, prefix, revision });
  return `Execute this deterministic fixture publisher once with bash. Do not generate images, install dependencies, ask questions, or print credentials, signed URLs, or API response bodies. Use the Run's injected short-lived OKOU_TOKEN; never resolve a provider or platform service key. Report only FIXTURES_READY after successful execution.\n\nnode --input-type=module <<'SOURCE_QA_SCRIPT'\nconst config = ${config};\nconst token = process.env.OKOU_TOKEN;\nif (!token) throw new Error("Run-scoped API identity unavailable");\nasync function request(path, body) {\n  const response = await fetch(new URL(path, config.apiUrl), {\n    method: "POST", redirect: "error",\n    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },\n    body: JSON.stringify(body)\n  });\n  if (response.status !== 200) throw new Error("Fixture API returned HTTP " + response.status);\n  return await response.json();\n}\nfor (const [suffix, artifactKind] of [["website", "hosted-site"], ["slides", "presentation-html"]]) {\n  const html = "<!doctype html><html><body><main data-slide>Creation source QA " + suffix + " revision " + config.revision + "</main></body></html>";\n  const bytes = new TextEncoder().encode(html);\n  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");\n  const prepared = await request("/api/host/deployments/prepare", {\n    site: config.prefix + "-" + suffix, title: config.prefix + "-" + suffix, artifactKind, spaFallback: false,\n    files: [{ path: "/index.html", size: bytes.length, sha256: digest, contentType: "text/html" }]\n  });\n  const upload = prepared.uploads.find(value => value.path === "/index.html");\n  if (!upload) throw new Error("Hosted fixture upload missing");\n  const uploaded = await fetch(upload.uploadUrl, { method: "PUT", redirect: "error", headers: { "Content-Type": "text/html" }, body: bytes });\n  if (!uploaded.ok) throw new Error("Hosted fixture upload failed");\n  await request("/api/host/deployments/" + prepared.deploymentId + "/complete", {});\n}\nif (config.revision === 1) {\n  const prepared = await request("/api/uploads/prepare", { filename: config.prefix + "-report.txt", contentType: "text/plain", size: 4, purpose: "artifact" });\n  const uploaded = await fetch(prepared.uploadUrl, { method: "PUT", redirect: "error", headers: prepared.uploadHeaders, body: "file" });\n  if (!uploaded.ok) throw new Error("File fixture upload failed");\n  await request("/api/uploads/complete", { id: prepared.id });\n}\nconsole.log("FIXTURES_READY");\nSOURCE_QA_SCRIPT`;
}

test("resolve authenticated artifact sources through publication, navigation and deletion", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.GITHUB_EVENT_NAME !== "pull_request" ||
      process.env.RUN_ARTIFACT_SOURCE_ACCEPTANCE !== "true",
    "Opt in with the acceptance:creation-source PR label; uses two real Runs in trusted CI",
  );
  test.setTimeout(600_000);
  const apiUrl = resolveApiBackendUrl();
  const appUrl = deriveAppUrl(apiUrl);
  expect(new URL(apiUrl).hostname.startsWith("pr-")).toBe(true);
  const email = generateTestEmail("playwright");
  const userId = await createUser(email, undefined, { firstName: "Source QA" });
  const organization = await createOrganizationRecord(
    "Artifact source QA",
    userId,
    "playwright",
  );
  const orgId = organization.id;
  const webhookId = randomUUID();
  const timestamp = new Date();
  const webhookBody = JSON.stringify({
    object: "event",
    type: "organization.created",
    data: {
      id: orgId,
      name: "Artifact source QA",
      created_at: organization.created_at,
      created_by: userId,
    },
  });
  const delivered = await fetch(new URL("/api/webhooks/clerk", apiUrl), {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      "svix-id": webhookId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": new Webhook(previewClerkWebhookKey()).sign(
        webhookId,
        timestamp,
        webhookBody,
      ),
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET
        ? {
            "x-vercel-protection-bypass":
              process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
          }
        : {}),
    },
    body: webhookBody,
  });
  expect(delivered.status).toBe(200);
  await signInWithClerkEmailCode(page, email, appUrl, {
    activeOrganizationId: orgId,
  });

  const request = async (path: string, method = "GET", data?: unknown) => {
    const token = await refreshClerkSessionToken(page, {
      activeOrganizationId: orgId,
    });
    return await page.request.fetch(new URL(path, apiUrl).href, {
      method,
      maxRedirects: 0,
      headers: {
        ...authHeadersForToken(token),
        "X-Chat-Event-Schema-Version": String(
          CURRENT_CHAT_EVENT_SCHEMA_VERSION,
        ),
      },
      ...(data === undefined ? {} : { data }),
    });
  };
  await expect
    .poll(
      async () => {
        const balance = await json(
          await request("/api/billing/usage-pack-credits"),
        );
        return balance.bonusCredits;
      },
      { timeout: 60_000 },
    )
    .toBeGreaterThan(0);
  await completePromptOnboarding(page, {
    appUrl,
    prompt: "Reply with only the word: SOURCE_QA_READY",
  });
  await expect(
    page.locator('[data-role="assistant"] [data-chat-selection-source]').last(),
  ).toContainText("SOURCE_QA_READY", { timeout: 90_000 });

  const prefix = `source-qa-${randomUUID().slice(0, 8)}`;
  const threadIds = new Set<string>();
  const onboardingThreadId = new URL(page.url()).pathname.match(
    /^\/chats\/([a-f0-9-]+)$/,
  )?.[1];
  if (!onboardingThreadId)
    throw new Error("Expected the actual onboarding Chat route");
  threadIds.add(onboardingThreadId);
  const artifactIds = new Set<string>();
  const appCommit = await page
    .locator('meta[name="okou-app-git-commit-sha"]')
    .getAttribute("content");
  const apiBuild = await json(await request("/api/build-info"));
  expect(appCommit).toBe(process.env.GITHUB_SHA);
  expect(apiBuild.commitSha).toBe(appCommit);
  const evidence: Record<string, unknown> = {
    preview: new URL(appUrl).origin,
    api: new URL(apiUrl).origin,
    buildCommitSha: appCommit,
    authenticatedApiBuild: "200",
  };
  const evidenceDirectory = path.resolve(
    testInfo.project.testDir,
    "../acceptance-evidence/artifact-creation-source",
  );
  await mkdir(evidenceDirectory, { recursive: true });
  const screenshot = async (name: string) => {
    const body = await page.screenshot({ animations: "disabled" });
    await writeFile(path.join(evidenceDirectory, `${name}.png`), body);
    await testInfo.attach(name, { body, contentType: "image/png" });
  };
  const sourcePath = (id: string) =>
    `/api/artifacts/catalog/${id}/creation-source`;
  const catalog = async () => {
    const body = await json(await request("/api/artifacts/catalog"));
    expect(
      body.nextCursor,
      "The isolated identity contains only this test's small fixture set",
    ).toBeNull();
    return records(body.artifacts);
  };
  const source = async (id: string) => {
    const response = await request(sourcePath(id));
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    return (await json(response)).source;
  };
  const menu = async (id: string) => {
    const row = page.locator(`tr[data-artifact-id="${id}"]`);
    await row
      .getByRole("button", { name: "More artifact actions", exact: true })
      .click();
    return page.getByRole("menu");
  };
  const requireLink = async (container: Locator, href: string) => {
    const item = container.getByRole("menuitem", {
      name: "View creation source",
      exact: true,
    });
    await expect(item).toHaveAttribute("href", href);
    await expect(item).toHaveJSProperty("tagName", "A");
    return item;
  };
  const anonymous = await playwrightRequest.newContext();
  const publish = async (revision: number) => {
    const clientEventId = randomUUID();
    const prompt = publisherPrompt(apiUrl, prefix, revision);
    const sent = await json(
      await request("/api/chat/events", "POST", {
        clientEventId,
        prompt,
        userMessage: { version: 1, parts: [{ type: "text", text: prompt }] },
        hasTextContent: true,
        model: "claude-sonnet-4-6",
        realAgentInPreview: true,
      }),
      201,
    );
    const threadId = string(sent.threadId);
    threadIds.add(threadId);
    let runId: string | undefined;
    let promptId: string | undefined;
    await expect
      .poll(
        async () => {
          const body = await json(
            await request(
              `/api/chat-threads/${threadId}/event-rows?sinceSeqId=0&limit=50`,
            ),
          );
          const rows = records(body.rows);
          const rejected = rows.find(
            (row) =>
              row.eventType === "input.rejected" &&
              row.revokesEventId === clientEventId,
          );
          expect(
            rejected,
            "Fixture publication must be admitted",
          ).toBeUndefined();
          const input = rows.find(
            (row) =>
              row.eventType === "input.prompt" && row.id === clientEventId,
          );
          if (input && typeof input.runId === "string") {
            runId = string(input.runId);
            promptId = string(input.id);
          }
          return Boolean(runId);
        },
        { timeout: 60_000, intervals: [500, 1_000, 2_000] },
      )
      .toBe(true);
    if (!runId || !promptId)
      throw new Error("Fixture Run identity unavailable");
    await expect
      .poll(
        async () => {
          const run = await json(await request(`/api/runs/${runId}`));
          expect(["failed", "cancelled", "timeout"]).not.toContain(run.status);
          return run.status;
        },
        { timeout: 180_000, intervals: [1_000, 2_000, 3_000] },
      )
      .toBe("completed");
    return { threadId, runId, promptId };
  };

  try {
    await page.goto(new URL("/_/lab", appUrl).href);
    const librarySwitch = page.getByRole("switch", {
      name: /Artifact library list/,
    });
    await librarySwitch.check();
    await expect(librarySwitch).toBeChecked();
    const realAgentSwitch = page.getByRole("switch", {
      name: new RegExp(`^${FeatureSwitchKey.RealAgentInPreview}`),
    });
    await realAgentSwitch.check();
    await expect(realAgentSwitch).toBeChecked();
    const effective = record(
      (await json(await request("/api/feature-switches"))).effectiveSwitches,
    );
    expect(effective.artifactLibrary).toBe(true);
    expect(effective[FeatureSwitchKey.RealAgentInPreview]).toBe(true);

    const first = await publish(1);
    let fixtures: Record<string, unknown>[] = [];
    await expect
      .poll(
        async () => {
          fixtures = (await catalog()).filter((item) =>
            string(item.title).startsWith(prefix),
          );
          return fixtures.length;
        },
        { timeout: 30_000 },
      )
      .toBe(3);
    fixtures.forEach((item) => artifactIds.add(string(item.id)));
    const website = fixtures.find((item) => item.kind === "hosted-site");
    const slides = fixtures.find((item) => item.kind === "presentation");
    const file = fixtures.find((item) => item.kind === "file");
    if (!website || !slides || !file)
      throw new Error(
        "Expected the actual website, presentation and file publications",
      );
    const websiteId = string(website.id),
      slidesId = string(slides.id),
      fileId = string(file.id);
    const expectedRun = { chatThreadId: first.threadId, runId: first.runId };
    expect(await source(websiteId)).toEqual(expectedRun);
    expect(await source(slidesId)).toEqual(expectedRun);
    expect(await source(fileId)).toEqual({
      chatThreadId: first.threadId,
      runId: null,
    });
    const firstSite = record(
      (await json(await request(`/api/artifacts/catalog/${websiteId}`))).site,
    );
    const snapshot = await json(
      await request(
        `/api/chat-threads/${first.threadId}/shared-threads`,
        "POST",
        { eventIds: [first.promptId] },
      ),
      201,
    );
    const shareId = string(snapshot.id);
    const shared = (await catalog()).find(
      (item) => item.sharedThreadId === shareId,
    );
    if (!shared)
      throw new Error("Expected the real shared snapshot in the catalog");
    const sharedId = string(shared.id);
    artifactIds.add(sharedId);
    expect(await source(sharedId)).toEqual({
      chatThreadId: first.threadId,
      runId: null,
    });
    const publicRead = async (pathname: string) => {
      const headers: Record<string, string> = process.env
        .VERCEL_AUTOMATION_BYPASS_SECRET
        ? {
            "x-vercel-protection-bypass":
              process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
          }
        : {};
      return await anonymous.get(new URL(pathname, apiUrl).href, {
        headers,
        maxRedirects: 0,
      });
    };
    expect((await publicRead(`/api/shared-threads/${shareId}`)).status()).toBe(
      200,
    );
    expect((await publicRead(sourcePath(sharedId))).status()).toBe(401);

    const standalone = await json(
      await request("/api/uploads/prepare", "POST", {
        filename: `${prefix}-standalone.txt`,
        contentType: "text/plain",
        size: 4,
        purpose: "artifact",
      }),
    );
    const uploaded = await fetch(string(standalone.uploadUrl), {
      method: "PUT",
      redirect: "error",
      headers: Object.fromEntries(
        Object.entries(record(standalone.uploadHeaders)).map(([key, value]) => [
          key,
          string(value),
        ]),
      ),
      body: "file",
    });
    expect(uploaded.status).toBe(200);
    await json(
      await request("/api/uploads/complete", "POST", {
        id: string(standalone.id),
      }),
    );
    const imported = (await catalog()).find(
      (item) => item.title === `${prefix}-standalone.txt`,
    );
    if (!imported)
      throw new Error("Expected the standalone upload in the catalog");
    const importedId = string(imported.id);
    artifactIds.add(importedId);
    expect(await source(importedId)).toBeNull();
    evidence.artifacts = { websiteId, slidesId, fileId, sharedId, importedId };

    await page.goto(new URL("/artifacts", appUrl).href);
    const rowMenu = await menu(websiteId);
    const originalHref = `/chats/${first.threadId}#run-${first.runId}`;
    const originalLink = await requireLink(rowMenu, originalHref);
    expect(
      await rowMenu
        .getByRole("menuitem", { name: "View creation source", exact: true })
        .count(),
    ).toBe(1);
    await screenshot("website-source-row");
    const newTabReady = page.context().waitForEvent("page");
    await originalLink.click({ modifiers: ["ControlOrMeta"] });
    const sourceTab = await newTabReady;
    await expect(sourceTab).toHaveURL(new URL(originalHref, appUrl).href);
    await sourceTab.close();
    await expect(page).toHaveURL(new URL("/artifacts", appUrl).href);
    await expect(rowMenu).toBeHidden();
    await (await requireLink(await menu(websiteId), originalHref)).click();
    await expect(page).toHaveURL(new URL(originalHref, appUrl).href);
    await expect(
      page.locator('[data-role="user"] [data-chat-selection-source]').first(),
    ).toContainText("deterministic fixture publisher");

    await page.goto(new URL("/artifacts", appUrl).href);
    await page
      .locator(`tr[data-artifact-id="${slidesId}"]`)
      .locator("[data-artifact-open]")
      .click();
    const sidebar = page.getByTestId("artifact-sidebar");
    await sidebar
      .getByRole("button", { name: "More artifact actions", exact: true })
      .click();
    await requireLink(page.getByRole("menu"), originalHref);
    await screenshot("presentation-source-sidebar");
    await page.keyboard.press("Escape");
    const fileMenu = await menu(fileId);
    await requireLink(fileMenu, `/chats/${first.threadId}`);
    await page.keyboard.press("Escape");

    await requireLink(await menu(sharedId), `/chats/${first.threadId}`);
    await page.keyboard.press("Escape");
    await page
      .locator(`tr[data-artifact-id="${importedId}"]`)
      .locator("[data-artifact-open]")
      .click();
    await page
      .getByTestId("artifact-sidebar")
      .getByRole("button", { name: "More artifact actions", exact: true })
      .click();
    const importedMenu = page.getByRole("menu");
    await expect(
      importedMenu.getByRole("menuitem", {
        name: "View creation source",
        exact: true,
      }),
    ).toHaveAttribute("aria-disabled", "true");
    await expect(
      importedMenu.getByRole("menuitem", { name: "Delete", exact: true }),
    ).not.toHaveAttribute("aria-disabled", "true");
    await screenshot("standalone-source-neutral-sidebar");
    await page.keyboard.press("Escape");

    const second = await publish(2);
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.runId).not.toBe(first.runId);
    const secondSite = record(
      (await json(await request(`/api/artifacts/catalog/${websiteId}`))).site,
    );
    expect(secondSite.deploymentVersion).not.toEqual(
      firstSite.deploymentVersion,
    );
    expect(await source(websiteId)).toEqual(expectedRun);
    expect(await source(slidesId)).toEqual(expectedRun);
    evidence.original = first;
    evidence.redeployment = second;
    evidence.deployments = {
      before: firstSite.deploymentVersion,
      after: secondSite.deploymentVersion,
    };
    evidence.provenance =
      "Original Run and Chat retained after actual redeployment; generic file is Chat-only";

    await page.goto(new URL("/artifacts", appUrl).href);
    await requireLink(await menu(websiteId), originalHref);
    await screenshot("source-retained-after-redeployment");
    await page.keyboard.press("Escape");
    expect(
      (await request(`/api/chat-threads/${first.threadId}`, "DELETE")).status(),
    ).toBe(204);
    threadIds.delete(first.threadId);
    expect(await source(websiteId)).toBeNull();
    expect(await source(slidesId)).toBeNull();
    expect(await source(fileId)).toBeNull();
    expect(await source(sharedId)).toBeNull();
    expect((await publicRead(`/api/shared-threads/${shareId}`)).status()).toBe(
      200,
    );
    evidence.sharing =
      "Public snapshot remains readable after original Chat deletion, but grants no anonymous creation-source access";
    await page.reload();
    const unavailable = await menu(websiteId);
    const sourceItem = unavailable.getByRole("menuitem", {
      name: "View creation source",
      exact: true,
    });
    await expect(sourceItem).toHaveAttribute("aria-disabled", "true");
    await expect(sourceItem).not.toHaveAttribute("href");
    await expect(sourceItem).toHaveAttribute(
      "title",
      "Creation source unavailable",
    );
    const deleteItem = unavailable.getByRole("menuitem", {
      name: "Delete",
      exact: true,
    });
    await expect(deleteItem).not.toHaveAttribute("aria-disabled", "true");
    await screenshot("unavailable-source-independent-delete");
    await deleteItem.click();
    const dialog = page.getByRole("dialog", {
      name: `Delete ${string(website.title)}?`,
      exact: true,
    });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    const trigger = page
      .locator(`tr[data-artifact-id="${websiteId}"]`)
      .getByRole("button", { name: "More artifact actions", exact: true });
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page
      .getByRole("menu")
      .getByRole("menuitem", { name: "Delete", exact: true })
      .click();
    const deletedResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/artifacts/catalog/${websiteId}` &&
        response.request().method() === "DELETE",
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    expect((await deletedResponse).status()).toBe(200);
    artifactIds.delete(websiteId);
    await expect(
      page.locator(`tr[data-artifact-id="${websiteId}"]`),
    ).toHaveCount(0);
    expect((await request(sourcePath(websiteId))).status()).toBe(404);
    expect(
      (await request(`/api/chat-threads/${second.threadId}`)).status(),
    ).toBe(200);
    expect((await request(`/api/artifacts/catalog/${slidesId}`)).status()).toBe(
      200,
    );
    evidence.deletion =
      "Deleted original Chat disables source without changing independent owner Delete, cancellation or focus; newer Chat and other artifact remain readable";

    await page.goto(new URL("/_/lab", appUrl).href);
    await page.getByRole("switch", { name: /Artifact library list/ }).uncheck();
    await expect(
      page.getByRole("switch", { name: /Artifact library list/ }),
    ).not.toBeChecked();
    const disabledFeatures = record(
      (await json(await request("/api/feature-switches"))).effectiveSwitches,
    );
    expect(disabledFeatures.artifactLibrary).toBe(false);
    let sourceRequests = 0;
    page.on("request", (outgoing) => {
      if (new URL(outgoing.url()).pathname.endsWith("/creation-source"))
        sourceRequests++;
    });
    await page.goto(new URL("/artifacts?tab=file", appUrl).href);
    await page
      .getByRole("button", {
        name: `Preview ${string(file.title)}`,
        exact: true,
      })
      .click();
    await page
      .getByTestId("artifact-sidebar")
      .getByRole("button", { name: "More artifact actions", exact: true })
      .click();
    await expect(page.getByRole("menu").getByRole("menuitem")).toHaveCount(1);
    await expect(
      page
        .getByRole("menu")
        .getByRole("menuitem", { name: "Delete", exact: true }),
    ).toBeVisible();
    expect(sourceRequests).toBe(0);
    evidence.flagOff =
      "Legacy menu has only Delete and issues zero creation-source requests";
    await screenshot("flag-off-legacy-menu");
  } finally {
    await anonymous.dispose();
    for (const id of threadIds) {
      const response = await request(`/api/chat-threads/${id}`, "DELETE");
      expect([204, 404]).toContain(response.status());
    }
    for (const item of await catalog()) {
      if (string(item.title).startsWith(prefix))
        artifactIds.add(string(item.id));
    }
    for (const id of artifactIds) {
      const response = await request(`/api/artifacts/catalog/${id}`, "DELETE");
      expect([200, 404]).toContain(response.status());
      expect((await request(`/api/artifacts/catalog/${id}`)).status()).toBe(
        404,
      );
    }
  }
  evidence.cleanup =
    "Owned publisher Chats and all fixture artifacts deleted through public APIs; CI separately removes recorded Clerk resources";
  const safeEvidence = JSON.stringify(evidence, null, 2);
  await writeFile(
    path.join(evidenceDirectory, "acceptance.json"),
    safeEvidence,
  );
  await testInfo.attach("creation-source-acceptance", {
    body: safeEvidence,
    contentType: "application/json",
  });
});
