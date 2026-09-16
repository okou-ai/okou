import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { randomUUID } from "node:crypto";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { expect } from "vitest";

import { accept, type TestContext } from "../../../../__tests__/test-context";
import { setupApp } from "../../../../__tests__/test-helpers";
import { uploadsCompleteRoutes } from "../../uploads-complete";
import { uploadsPrepareRoutes } from "../../uploads-prepare";
import { sharedThreadRoutes } from "../../shared-threads";
import { artifactShareRoutes } from "../../artifact-shares";
import { updateFeatureSwitchesForUser } from "./feature-switches";
import { createRouteMocks } from "./route-test";
import { installSharedThreadStorage } from "./shared-thread-storage";
import type { ApiTestUser } from "./api-bdd";
import { createHostMapsBddApi } from "./api-bdd-host-maps";
import { createChatFilesBddApi } from "./api-bdd-chat-files";
import { hostedTextFile } from "./api-bdd-host-files";

/** Upload through the same public API as a generated artifact. */
export async function privateIntegrationArtifact(
  context: TestContext,
  actor: ApiTestUser,
) {
  if (!actor.orgId) {
    throw new Error("Expected an organization-scoped artifact owner");
  }
  const storage = installSharedThreadStorage(context);
  const content = "Private integration report bytes";
  const organization = {
    id: actor.orgId,
    name: "Artifact test organization",
    slug: null,
    imageUrl: "",
    hasImage: false,
    createdAt: 0,
  };
  context.mocks.clerk.organizations.getOrganization.mockResolvedValue(
    organization,
  );
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    {
      data: [
        {
          id: `orgmem_${randomUUID()}`,
          role: "org:admin",
          createdAt: 0,
          organization,
          publicUserData: { userId: actor.userId },
        },
      ],
      totalCount: 1,
    },
  );
  await updateFeatureSwitchesForUser(
    context,
    { ...actor, orgId: actor.orgId },
    {
      [FeatureSwitchKey.PrivateArtifacts]: true,
    },
  );
  createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
  const uploads = setupApp({
    context,
    routes: [...uploadsPrepareRoutes, ...uploadsCompleteRoutes],
  })(uploadsContract);
  const headers = { authorization: "Bearer clerk-session" };
  const prepared = await accept(
    uploads.prepare({
      headers,
      body: {
        filename: "report.pdf",
        contentType: "application/pdf",
        size: Buffer.byteLength(content),
        purpose: "artifact",
      },
    }),
    [200],
  );
  if (!("uploadUrl" in prepared.body)) {
    throw new Error("Expected a single artifact upload");
  }
  expect(
    (await fetch(prepared.body.uploadUrl, { method: "PUT", body: content }))
      .status,
  ).toBe(200);
  await accept(
    uploads.complete({ headers, body: { id: prepared.body.id } }),
    [200],
  );
  const url = prepared.body.url;
  const uploadUrl = prepared.body.uploadUrl;
  return {
    ...storage,
    url,
    removeOriginal() {
      storage.removeUpload(uploadUrl);
    },
    async createSite() {
      const host = createHostMapsBddApi(context);
      const files = [
        {
          path: "/index.html",
          content: `<html><img src="./plot.svg"><a href="${url}">Report</a></html>`,
          contentType: "text/html",
        },
        {
          path: "/plot.svg",
          content:
            '<svg xmlns="http://www.w3.org/2000/svg"><text>Snapshot plot</text></svg>',
          contentType: "image/svg+xml",
        },
      ];
      const preparedSite = await host.prepareHostedSite(actor, {
        site: `integration-${randomUUID().slice(0, 8)}`,
        artifactKind: "hosted-site",
        spaFallback: false,
        files: files.map((file) => {
          return hostedTextFile(file.path, file.content, file.contentType);
        }),
      });
      for (const upload of preparedSite.uploads) {
        const file = files.find((entry) => {
          return entry.path === upload.path;
        });
        if (!file) {
          throw new Error("Unexpected hosted upload");
        }
        const uploaded = await fetch(upload.uploadUrl, {
          method: "PUT",
          body: file.content,
        });
        expect(uploaded.status).toBe(200);
      }
      const completed = await host.completeHostedSite(
        actor,
        preparedSite.deploymentId,
      );
      return completed.url;
    },
    async expectDelivered(message: string) {
      expect(message).not.toContain(url);
      const deliveredUrl = message.match(
        /https:\/\/a\.(?:okou|vm0)\.io\/[a-z0-9]+\.pdf/u,
      )?.[0];
      expect(deliveredUrl).toBeDefined();
      const response = await fetch(deliveredUrl!);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe(content);
      const id = storage.snapshotThreadId(deliveredUrl!);
      const shared = setupApp({ context, routes: sharedThreadRoutes })(
        sharedThreadsContract,
      );
      await accept(shared.get({ params: { id } }), [404]);
      await accept(shared.meta({ params: { id } }), [404]);
      createRouteMocks(context).clerk.session(actor.userId, actor.orgId);
      const status = await accept(
        setupApp({ context, routes: artifactShareRoutes })(
          artifactSharesContract,
        ).status({
          headers,
          body: { kind: "file", id: prepared.body.id },
        }),
        [200],
      );
      expect(status.body.audience).toBe("private");
      const catalog = await createChatFilesBddApi(context).listArtifactCatalog(
        actor,
        {
          kind: "shared-thread",
        },
      );
      expect(catalog.artifacts).toStrictEqual([]);
      return deliveredUrl!;
    },
  };
}
