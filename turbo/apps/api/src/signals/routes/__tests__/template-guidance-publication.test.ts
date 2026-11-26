import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userTemplatesRoutes } from "../user-templates";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import {
  installS3Fixture,
  tarGz,
  uploadTemplateFile,
} from "./helpers/template-publish-fixture";

const context = testContext();
const bdd = createBddApi(context);

const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PNG = "image/png";
const GZIP = "application/gzip";

describe("POST /api/user-templates", () => {
  it("template-guidance-publication-027 rejects conflicting file and directory names before publication", async () => {
    const fixture = installS3Fixture(context);
    const member = bdd.user();

    const sourceFileId = await uploadTemplateFile(
      context,
      member,
      fixture,
      { filename: "deck.pptx", contentType: PPTX },
      Buffer.from("deck"),
    );
    const pageFileId = await uploadTemplateFile(
      context,
      member,
      fixture,
      { filename: "page-1.png", contentType: PNG },
      Buffer.from("png-1"),
    );
    const packageFileId = await uploadTemplateFile(
      context,
      member,
      fixture,
      { filename: "package.tar.gz", contentType: GZIP },
      tarGz([
        { path: "SKILL.md", content: "# Deck guidance" },
        { path: "design-system.md", content: "Use the brand palette." },
        { path: "assets", content: "conflicting file" },
        { path: "assets/logo.png", content: Buffer.from("png-logo") },
      ]),
    );

    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );
    const response = await accept(
      setupApp({ context, routes: userTemplatesRoutes })(
        userTemplatesContract,
      ).publish({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          kind: "presentation",
          title: "Conflicting package",
          sourceFileId,
          pageFileIds: [pageFileId],
          packageFileId,
        },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "Invalid template guidance package",
    );
  });
});
