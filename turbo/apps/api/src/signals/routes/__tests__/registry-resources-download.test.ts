import { randomUUID } from "node:crypto";

import { registryResourceDownloadContract } from "@okouai/api-contracts/contracts/registry-resources";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { registryResourceDownloadRoutes } from "../registry-resources-download";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const routeMocks = createRouteMocks(context);

function authHeaders() {
  const userId = `user_${randomUUID()}`;
  const orgId = `org_${randomUUID()}`;
  routeMocks.clerk.session(userId, orgId, "org:admin");
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: registryResourceDownloadRoutes })(
    registryResourceDownloadContract,
  );
}

describe("registry resource download", () => {
  it("keeps non-presentation resources off the current-template route", async () => {
    const response = await accept(
      client().downloadPresentationTemplate({
        headers: authHeaders(),
        query: { id: "image-style:vm0-illustration" },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects an unpublished presentation registry digest through the route", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: {
          id: "template:html-ppt-schoolhouse-runbook",
          expectedSha256:
            "9bd19af256dfb6f17073ec9af52ed0163a5f432a3d143eb82f1fa67aaf8b015e",
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("rejects a reverse-template digest that was never published", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: {
          id: "skill:presentation-reverse-template",
          expectedSha256: "0".repeat(64),
        },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message:
          'Registry resource "skill:presentation-reverse-template" is not private-pullable',
      },
    });
  });

  it("rejects registry resources that are not in the private archive allowlist", async () => {
    const response = await accept(
      client().download({
        headers: authHeaders(),
        query: { id: "template:dashboard", expectedSha256: "0".repeat(64) },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
