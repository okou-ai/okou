import { randomUUID } from "node:crypto";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { uploadsContract } from "@okouai/api-contracts/contracts/uploads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { createAppWithRoutes } from "../../../app-factory-core";
import { artifactCatalogRoutes } from "../artifact-catalog";
import { featureSwitchesRoutes } from "../feature-switches";
import { uploadsCompleteRoutes } from "../uploads-complete";
import { uploadsPrepareRoutes } from "../uploads-prepare";
import { createRouteMocks } from "./helpers/route-test";
import { installSharedThreadStorage } from "./helpers/shared-thread-storage";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const routes = Object.freeze([
  ...artifactCatalogRoutes,
  ...featureSwitchesRoutes,
  ...uploadsPrepareRoutes,
  ...uploadsCompleteRoutes,
]);
const client = () => {
  return setupApp({ context, routes });
};

async function enableLibrary(enabled = true) {
  await accept(
    client()(featureSwitchesContract).update({
      headers,
      body: { switches: { [FeatureSwitchKey.ArtifactLibrary]: enabled } },
    }),
    [200],
  );
}

async function standaloneArtifact() {
  const prepared = await accept(
    client()(uploadsContract).prepare({
      headers,
      body: {
        filename: "imported.txt",
        contentType: "text/plain",
        size: 4,
        purpose: "artifact",
      },
    }),
    [200],
  );
  if (!("uploadUrl" in prepared.body)) {
    throw new Error("Expected a single-part artifact upload");
  }
  const uploaded = await fetch(prepared.body.uploadUrl, {
    method: "PUT",
    headers: prepared.body.uploadHeaders,
    body: "file",
  });
  expect(uploaded.status).toBe(200);
  await accept(
    client()(uploadsContract).complete({
      headers,
      body: { id: prepared.body.id },
    }),
    [200],
  );
  const catalog = await accept(
    client()(artifactCatalogContract).list({ headers }),
    [200],
  );
  const artifact = catalog.body.artifacts[0];
  if (!artifact) {
    throw new Error("Expected the uploaded artifact in the catalog");
  }
  return artifact.id;
}

beforeEach(() => {
  mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
  installSharedThreadStorage(context);
});

describe("artifact creation source access", () => {
  it("gates the endpoint and returns an uncached neutral source for an outside-Run upload", async () => {
    const artifactId = await standaloneArtifact();
    const params = { artifactId };
    await enableLibrary(false);
    await accept(
      client()(artifactCatalogContract).creationSource({ headers, params }),
      [403],
    );
    await enableLibrary();
    const source = await accept(
      client()(artifactCatalogContract).creationSource({ headers, params }),
      [200],
    );
    expect(source.body).toStrictEqual({ source: null });
    expect(source.headers.get("cache-control")).toBe("private, no-store");
    await enableLibrary(false);
    await accept(
      client()(artifactCatalogContract).creationSource({ headers, params }),
      [403],
    );
  });

  it("does not disclose missing, deleted, other-user or other-organization artifact sources", async () => {
    const userId = `user_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    mocks.clerk.session(userId, orgId);
    const artifactId = await standaloneArtifact();
    await enableLibrary();
    const missing = await accept(
      client()(artifactCatalogContract).creationSource({
        headers,
        params: { artifactId: randomUUID() },
      }),
      [404],
    );
    expect(missing.body).toStrictEqual({
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
    for (const [viewerId, viewerOrg] of [
      [`user_${randomUUID()}`, orgId],
      [userId, `org_${randomUUID()}`],
    ] as const) {
      mocks.clerk.session(viewerId, viewerOrg);
      await enableLibrary();
      const denied = await accept(
        client()(artifactCatalogContract).creationSource({
          headers,
          params: { artifactId },
        }),
        [404],
      );
      expect(denied.body).toStrictEqual({
        error: { code: "NOT_FOUND", message: "Artifact not found" },
      });
    }
    mocks.clerk.session(userId, orgId);
    await accept(
      client()(artifactCatalogContract).delete({
        headers,
        params: { artifactId },
      }),
      [200],
    );
    await accept(
      client()(artifactCatalogContract).creationSource({
        headers,
        params: { artifactId },
      }),
      [404],
    );
  });

  it("requires authentication", async () => {
    context.mocks.clerk.authenticateRequest.mockResolvedValue({
      isAuthenticated: false,
      toAuth: () => {
        return { userId: null, orgId: null, orgRole: null };
      },
    });
    const unauthenticated = await accept(
      client()(artifactCatalogContract).creationSource({
        params: { artifactId: randomUUID() },
      }),
      [401],
    );
    expect(unauthenticated.body).toStrictEqual({
      error: { code: "UNAUTHORIZED", message: "Not authenticated" },
    });
    expect(unauthenticated.headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("does not disguise an authentication provider failure as an unavailable source", async () => {
    const artifactId = await standaloneArtifact();
    await enableLibrary();
    context.mocks.clerk.authenticateRequest.mockRejectedValue(
      new Error("Clerk unavailable"),
    );
    const response = await createAppWithRoutes({
      signal: context.signal,
      routes,
    }).request(`/api/artifacts/catalog/${artifactId}/creation-source`, {
      headers,
    });
    expect(response.status).toBe(500);
  });
});
