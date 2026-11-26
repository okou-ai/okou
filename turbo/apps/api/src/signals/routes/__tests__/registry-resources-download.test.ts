import { randomUUID } from "node:crypto";
import { registryResourceDownloadContract } from "@okouai/api-contracts/contracts/registry-resources";

import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { registryResourceDownloadRoutes } from "../registry-resources-download";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const headers = Object.freeze({ authorization: "Bearer clerk-session" });

function signedInAdmin() {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:admin",
  );
  return setupApp({ context, routes: registryResourceDownloadRoutes })(
    registryResourceDownloadContract,
  );
}

describe("registry resource download", () => {
  it("registry-resources-download-002 reports an unpublished native PPTX package without substituting HTML", async () => {
    const api = signedInAdmin();

    const response = await accept(
      api.downloadPresentationTemplate({
        headers,
        query: { id: "template:pptx-schoolhouse-runbook" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        code: "NOT_FOUND",
        message:
          'Current archive for "template:pptx-schoolhouse-runbook" was not found',
      },
    });
  });

  it("registry-resources-download-003 rejects an unpublished presentation registry digest", async () => {
    const api = signedInAdmin();

    const response = await accept(
      api.download({
        headers,
        query: {
          id: "template:html-ppt-schoolhouse-runbook",
          expectedSha256: "ab".repeat(32),
        },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("registry-resources-download-005 rejects resources outside the private archive allowlist", async () => {
    const api = signedInAdmin();

    const response = await accept(
      api.download({
        headers,
        query: { id: "template:dashboard", expectedSha256: "0".repeat(64) },
      }),
      [404],
    );

    expect(response.body.error.code).toBe("NOT_FOUND");
  });
});
