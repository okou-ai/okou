import { command } from "ccstate";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import { notFound, resourceUnavailable } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import {
  getArtifactLibraryEntry$,
  listArtifactCatalog$,
  listArtifactCatalogFavorites$,
  setArtifactCatalogFavorite$,
} from "../services/artifact-library.service";
import { ownedGoogleDriveThreadContext$ } from "../services/artifact-google-drive-authorization.service";
import { googleDriveArtifactDetailStatus$ } from "../services/google-drive-artifact-sync.service";
import { deleteArtifact$ } from "../services/artifact-deletion.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

const artifactLibraryEnabled$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const featureContext = await set(
      loadUserFeatureSwitchContext$,
      auth.orgId,
      auth.userId,
      signal,
    );
    return isFeatureEnabled(FeatureSwitchKey.ArtifactLibrary, featureContext);
  },
);

const listArtifactCatalogInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const query = get(queryOf(artifactCatalogContract.list));
    if (
      query.sort !== undefined ||
      query.direction !== undefined ||
      query.starred !== undefined
    ) {
      if (!(await set(artifactLibraryEnabled$, signal))) {
        return resourceUnavailable("Artifact library is not available");
      }
    }
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
        sort: query.sort,
        direction: query.direction,
        starred: query.starred === "true",
      },
      signal,
    );
    signal.throwIfAborted();
    if (!result) {
      return resourceUnavailable("Artifact cursor does not match this query");
    }

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
      getArtifactLibraryEntry$,
      {
        artifactId: params.artifactId,
        sourceKind: query.sourceKind,
        libraryAccess:
          query.access !== "owner" &&
          (await set(artifactLibraryEnabled$, signal)),
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
            {
              ...context,
              artifactId: artifact.id,
            },
            signal,
          );
    signal.throwIfAborted();
    return { status: 200 as const, body: { ...artifact, ...drive } };
  },
);

const deleteArtifactInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const { artifactId } = get(pathParamsOf(artifactCatalogContract.delete));
    return await set(
      deleteArtifact$,
      { artifactId, orgId: auth.orgId, userId: auth.userId },
      signal,
    );
  },
);

const listFavoritesInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    if (!(await set(artifactLibraryEnabled$, signal))) {
      return resourceUnavailable("Artifact library is not available");
    }
    const artifactIds = await set(
      listArtifactCatalogFavorites$,
      get(organizationAuthContext$),
      signal,
    );
    return { status: 200 as const, body: { artifactIds } };
  },
);

const setFavoriteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  if (!(await set(artifactLibraryEnabled$, signal))) {
    return resourceUnavailable("Artifact library is not available");
  }
  const body = await get(bodyResultOf(artifactCatalogContract.setFavorite));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    setArtifactCatalogFavorite$,
    {
      ...get(organizationAuthContext$),
      ...get(pathParamsOf(artifactCatalogContract.setFavorite)),
      starred: body.data.starred,
    },
    signal,
  );
  return result
    ? { status: 200 as const, body: result }
    : notFound("Artifact not found");
});

export const artifactCatalogRoutes: readonly RouteEntry[] = [
  {
    route: artifactCatalogContract.listFavorites,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      listFavoritesInner$,
    ),
  },
  {
    route: artifactCatalogContract.setFavorite,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "chat-event:read",
      },
      setFavoriteInner$,
    ),
  },
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
  {
    route: artifactCatalogContract.delete,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "artifact:write",
      },
      deleteArtifactInner$,
    ),
  },
];
