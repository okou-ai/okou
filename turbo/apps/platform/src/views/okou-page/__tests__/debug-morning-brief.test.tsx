import { orgContract } from "@okouai/api-contracts/contracts/org-routes";
import { debugMorningBriefContract } from "@okouai/api-contracts/contracts/debug-morning-brief";

import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findFastControl } from "./chat-message-experience-test-helpers.ts";
const context = testContext();
async function openDebug(role: "member" | "admin") {
  const org = { id: "org_test", name: "Debug workshop" };
  context.mocks.api(orgContract.get, ({ respond }) => {
    return respond(200, { ...org, role });
  });
  await setupPage({
    context,
    path: "/?settings=debug",
    host: "app.okou.ai",
    featureSwitches: { [FeatureSwitchKey.OkouDebug]: true },
    auth: {
      user: { id: "user_harbor", fullName: "Harbor reader" },
      organization: {
        activeOrg: org,
        memberships: [{ id: org.id, role: "org:" + role }],
      },
    },
  });
}

function briefs(status: "failed" | "completed") {
  const ids = new Map<string, string>();
  context.mocks.api(debugMorningBriefContract.run, ({ body, respond }) => {
    const thread = crypto.randomUUID();
    ids.set(thread, body.requestId);
    return respond(200, {
      requestId: body.requestId,
      chatThreadId: thread,
      runId: null,
      status,
    });
  });
  return ids;
}
async function displayedRequest(ids: Map<string, string>) {
  const chat = await findFastControl("link", "Open chat");
  const thread = chat.getAttribute("href")?.split("/").at(-1);
  const request = ids.get(thread ?? "");
  expect(request).toBeDefined();
  return request;
}
test("debug-morning-brief-001 a member can run separate briefs without changing the daily schedule", async () => {
  const ids = briefs("completed");
  await openDebug("member");
  click(await findFastControl("button", "Run Morning Brief"));
  await screen.findByText("Morning Brief completed.");
  expect(
    screen.getByText(/Your daily schedule stays unchanged/),
  ).toBeInTheDocument();
  const first = await displayedRequest(ids);
  click(await findFastControl("button", "Run another Morning Brief"));
  await waitFor(async () => {
    await expect(displayedRequest(ids)).resolves.not.toBe(first);
  });
});
test("debug-morning-brief-003 a failed brief links its conversation and allows a new attempt", async () => {
  const ids = briefs("failed");
  await openDebug("member");
  click(await findFastControl("button", "Run Morning Brief"));
  await screen.findByText("Morning Brief failed. Open the chat for details.");
  await displayedRequest(ids);
  await expect(
    findFastControl("button", "Run another Morning Brief"),
  ).resolves.toBeEnabled();
});
