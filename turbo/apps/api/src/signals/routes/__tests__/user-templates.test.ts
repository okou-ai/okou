import { randomUUID } from "node:crypto";
import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { userTemplatesRoutes } from "../user-templates";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signedInMember() {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:member",
  );
  return setupApp({ context, routes: userTemplatesRoutes })(
    userTemplatesContract,
  );
}

describe("user template owner routes", () => {
  it("user-templates-001 lists an empty catalog for a member with no templates", async () => {
    const api = signedInMember();

    const response = await accept(api.list({ headers }), [200]);

    expect(response.body).toStrictEqual([]);
  });

  it("user-templates-002 does not expose an unknown template through owner routes", async () => {
    const api = signedInMember();
    const templateId = randomUUID();
    const expected = {
      error: {
        code: "NOT_FOUND",
        message: `User template not found: ${templateId}`,
      },
    };

    const read = await accept(
      api.get({ headers, params: { templateId } }),
      [404],
    );
    const renamed = await accept(
      api.update({
        headers,
        params: { templateId },
        body: { title: "Renamed" },
      }),
      [404],
    );
    const deleted = await accept(
      api.delete({ headers, params: { templateId }, body: undefined }),
      [404],
    );

    expect(read.body).toStrictEqual(expected);
    expect(renamed.body).toStrictEqual(expected);
    expect(deleted.body).toStrictEqual(expected);
  });
});
