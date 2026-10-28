import { GetObjectCommand } from "@aws-sdk/client-s3";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  integrationsFeishuUploadInitContract,
  integrationsLarkUploadInitContract,
  integrationsGithubUploadInitContract,
  integrationsPhoneUploadInitContract,
  integrationsTeamsUploadInitContract,
  integrationsTelegramUploadInitContract,
} from "@okouai/api-contracts/contracts/integrations";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { integrationsFeishuFileRoutes } from "../integrations-feishu-files";
import { integrationsGithubUploadInitRoutes } from "../integrations-github-upload-init";
import { integrationsPhoneUploadInitRoutes } from "../integrations-phone-upload-init";
import { integrationsTeamsUploadInitRoutes } from "../integrations-teams-upload-init";
import { integrationsTelegramUploadInitRoutes } from "../integrations-telegram-upload-init";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { webFileUrlRoutes } from "../web-file-url";
import { createBddApi } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const integrations = [
  {
    name: "Feishu",
    contract: integrationsFeishuUploadInitContract,
    routes: integrationsFeishuFileRoutes,
  },
  {
    name: "Lark",
    contract: integrationsLarkUploadInitContract,
    routes: integrationsFeishuFileRoutes,
  },
  {
    name: "GitHub",
    contract: integrationsGithubUploadInitContract,
    routes: integrationsGithubUploadInitRoutes,
  },
  {
    name: "Phone",
    contract: integrationsPhoneUploadInitContract,
    routes: integrationsPhoneUploadInitRoutes,
  },
  {
    name: "Teams",
    contract: integrationsTeamsUploadInitContract,
    routes: integrationsTeamsUploadInitRoutes,
  },
  {
    name: "Telegram",
    contract: integrationsTelegramUploadInitContract,
    routes: integrationsTelegramUploadInitRoutes,
  },
] as const;

test.each(integrations)(
  "$name uploads stay private through completion",
  async ({ contract, routes }) => {
    const actor = createBddApi(context).user();
    if (!actor.orgId) {
      throw new Error("Expected organization");
    }
    const flagActor = { ...actor, orgId: actor.orgId };
    await updateFeatureSwitchesForUser(context, flagActor, {
      [FeatureSwitchKey.LarkIntegration]: true,
    });
    installSharedThreadStorage(context);
    const headers = { authorization: "Bearer clerk-session" };
    const initialized = await setupApp({ context, routes })(contract).init({
      headers,
      body: { filename: "notes.txt", contentType: "text/plain", length: 12 },
    });
    expect(initialized.status).toBe(200);
    if (initialized.status !== 200) {
      throw new Error("Expected an initialized private upload");
    }
    const { uploadId, uploadUrl, fileUrl } = initialized.body;
    expect(uploadUrl).toContain("/test-private-artifacts/private-artifacts/");
    expect(fileUrl).toMatch(
      /^https?:\/\/[^/]+\/artifacts\/[a-z0-9]{10}\.txt$/u,
    );
    expect(
      (await fetch(uploadUrl, { method: "PUT", body: "upload bytes" })).status,
    ).toBe(200);
    const api = setupApp({
      context,
      routes: [...uploadsCompleteRoutes, ...webFileUrlRoutes],
    });
    const completed = await accept(
      api(uploadsContract).complete({ headers, body: { id: uploadId } }),
      [200],
    );
    expect(completed.body.url).toBe(fileUrl);
    const preview = await accept(
      api(webFilesContract).fileUrl({ headers, query: { file_id: uploadId } }),
      [200],
    );
    expect(preview.body.publicUrl).toBeNull();
    const signed = context.mocks.s3.getSignedUrl.mock.calls.at(-1)?.[1];
    expect(signed).toBeInstanceOf(GetObjectCommand);
    expect(signed).toMatchObject({
      input: {
        Bucket: "test-private-artifacts",
      },
    });
    createRouteMocks(context).clerk.session(actor.userId, "another-org");
    await accept(
      api(webFilesContract).fileUrl({
        headers,
        query: { file_id: uploadId },
      }),
      [404],
    );
  },
);
