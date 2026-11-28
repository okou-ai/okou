import { randomUUID } from "node:crypto";

import { integrationsGithubDownloadFileContract } from "@okouai/api-contracts/contracts/integrations";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsGithubDownloadFileRoutes } from "../integrations-github-download-file";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();

const sessionHeaders = Object.freeze({ authorization: "Bearer clerk-session" });

/** A signed-in workspace admin (the URL resolver reads no installation). */
function signedInAdmin(): void {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:admin",
  );
}

function downloadUrlClient() {
  return setupApp({
    context,
    routes: integrationsGithubDownloadFileRoutes,
  })(integrationsGithubDownloadFileContract);
}

describe("GitHub file integration routes", () => {
  it("integrations-github-files-001 returns download metadata for a GitHub attachment", async () => {
    signedInAdmin();
    const url =
      "https://raw.githubusercontent.com/okou-ai/okou/main/report%20final.csv";

    const response = await accept(
      downloadUrlClient().fileUrl({
        headers: sessionHeaders,
        query: { url },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      downloadUrl: url,
      filename: "report final.csv",
      contentType: "text/csv",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("integrations-github-files-003 keeps a signed GitHub URL intact and sanitizes the filename hint", async () => {
    signedInAdmin();
    const url =
      "https://private-user-images.githubusercontent.com/123/file?jwt=signed!";

    const response = await accept(
      downloadUrlClient().fileUrl({
        headers: sessionHeaders,
        query: { url, filename: "../report.pdf" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({
      downloadUrl: url,
      filename: ".._report.pdf",
      contentType: "application/pdf",
    });
  });
});
