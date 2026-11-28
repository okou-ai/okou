import {
  chatThreadMetadataContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { chatThreadCreateRoutes } from "../chat-threads-create";
import { chatThreadGetRoutes } from "../chat-threads-get";
import { createBddApi } from "./helpers/api-bdd";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

describe("model identity new writes", () => {
  it("model-identity-writes-003 resolves an omitted creation model from the member's personal preference", async () => {
    const actor = createBddApi(context).user();
    await createRunsApi(context).ensurePersonalSubscriptionModel(actor, {
      model: "claude-sonnet-5-5",
    });
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );

    const created = await accept(
      setupApp({ context, routes: chatThreadCreateRoutes })(
        chatThreadsContract,
      ).create({ headers, body: {} }),
      [201],
    );
    const metadata = await accept(
      setupApp({ context, routes: chatThreadGetRoutes })(
        chatThreadMetadataContract,
      ).get({ headers, params: { id: created.body.id } }),
      [200],
    );

    expect(created.body.selectedModel).toBe("claude-sonnet-5-5");
    expect(metadata.body.selectedModel).toBe("claude-sonnet-5-5");
  });
});
