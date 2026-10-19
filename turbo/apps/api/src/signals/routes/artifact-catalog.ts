import { command } from "ccstate";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf, queryOf } from "../context/request";
import {
  getArtifactCatalogEntry$,
  listArtifactCatalog$,
} from "../services/artifact-catalog.service";
import { ownedGoogleDriveThreadContext$ } from "../services/artifact-google-drive-authorization.service";
import { googleDriveArtifactDetailStatus$ } from "../services/google-drive-artifact-sync.service";
import type { RouteEntry } from "../route-entry";

const listArtifactCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactCatalogContract.list));
    const result = await set(
      listArtifactCatalog$,
      {
        orgId: auth.orgId,
        userId: auth.userId,
        limit: query.limit,
        cursor: query.cursor,
        kind: query.kind,
        chatThreadId: query.chatThreadId,
        keyword: query.keyword,
      },
      signal,
    );
    signal.throwIfAborted();

    return {
      status: 200 as const,
      body: {
        artifacts: [...result.artifacts],
        nextCursor: result.nextCursor,
      },
    };
  },
);

const getArtifactCatalogEntryInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(pathParamsOf(artifactCatalogContract.get));
    const query = get(queryOf(artifactCatalogContract.get));
    const artifact = await set(
      getArtifactCatalogEntry$,
      {
        artifactId: params.artifactId,
        orgId: auth.orgId,
        userId: auth.userId,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!artifact) {
      return notFound("Artifact not found");
    }

    if (!query.chatThreadId) {
      return { status: 200 as const, body: artifact };
    }
    const context = {
      threadId: query.chatThreadId,
      orgId: auth.orgId,
      userId: auth.userId,
    };
    const ownedContext = await set(
      ownedGoogleDriveThreadContext$,
      context,
      signal,
    );
    signal.throwIfAborted();
    if (!ownedContext) {
      return notFound("Chat thread not found");
    }
    const drive =
      artifact.kind === "shared-thread"
        ? {}
        : await set(
            googleDriveArtifactDetailStatus$,
            { ...context, artifactId: params.artifactId },
            signal,
          );
    signal.throwIfAborted();
    return { status: 200 as const, body: { ...artifact, ...drive } };
  },
);

export const artifactCatalogRoutes: readonly RouteEntry[] = [
  {
    route: artifactCatalogContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      listArtifactCatalogInner$,
    ),
  },
  {
    route: artifactCatalogContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      getArtifactCatalogEntryInner$,
    ),
  },
];
