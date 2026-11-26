import { chatThreadsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, startPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findButton } from "./chat-run-test-fixtures.ts";
const context = testContext();
test("shared-database-browser-002 The connected workspace uses its cached Clerk session token scoped to the worker's workspace", async () => {
  const authorization = context.mocks.deferred<string | null>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    chatThreadsContract.indicators,
    async ({ request, respond }) => {
      if (!authorization.settled()) {
        authorization.resolve(request.headers.get("authorization"));
      }
      await release.promise;
      return respond(200, { threads: {}, unreadAt: {} });
    },
  );
  const cached = "local-default-session-token";
  mockedClerk.sessionGetToken.mockImplementation((options) => {
    const cachedForWorker =
      options?.organizationId === "local-group" && !options.skipCache;
    return Promise.resolve(cachedForWorker ? cached : "page-session-token");
  });
  const page = await startPage({
    context,
    path: "/workflows",
    auth: {
      user: { id: "local-clerk-reader", fullName: "Local member" },
      session: { token: cached },
      organization: {
        activeOrg: { id: "local-group", name: "Local group" },
        memberships: [{ id: "local-group" }],
      },
    },
    sharedWorkerTestTransport: "message-port",
  });
  await page.content;
  click(await findButton("Open chat list menu"));
  await expect(authorization.promise).resolves.toBe("Bearer " + cached);
  release.resolve();
  await page.ready;
  await expect(
    screen.findByRole("heading", { name: "Workflows" }),
  ).resolves.toBeVisible();
});
