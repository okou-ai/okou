import { randomUUID } from "node:crypto";
import { BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES } from "@okouai/api-contracts/contracts/browser-user-actions";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupRawAppRequest } from "../../../__tests__/test-helpers";
import { browserUserActionRoutes } from "../browser-user-actions";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

/** A signed-in member posts raw bytes to the Browser input apply endpoint. */
async function apply(body: string, headers: Record<string, string> = {}) {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:member",
  );
  return await setupRawAppRequest({ context, routes: browserUserActionRoutes })(
    `/api/browser/user-actions/${randomUUID()}/apply`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer clerk-session",
        "content-type": "application/json",
        ...headers,
      },
      body,
    },
  );
}

describe("Browser input request body policy", () => {
  it("browser-body-policy-001 rejects a declared body above the limit before JSON parsing", async () => {
    const response = await apply("{", {
      "content-length": String(BROWSER_USER_ACTION_MAX_APPLY_BODY_BYTES + 1),
    });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      error: { message: "Browser input request is too large" },
    });
  });
});
