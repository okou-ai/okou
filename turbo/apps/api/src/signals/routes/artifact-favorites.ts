import { command, computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { artifactFavoritesContract } from "@okouai/api-contracts/contracts/artifact-favorites";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactFavorites } from "@okouai/db/schema/artifact-favorite";
import {
  badRequestMessage,
  notFound,
  resourceUnavailable,
} from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { bodyResultOf, pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import {
  favoriteArtifactIdFromUrl$,
  readFavoriteArtifact$,
} from "../services/artifact-favorite-access.service";
import {
  artifactFavoriteStatus,
  createArtifactFavorite$,
  listArtifactFavorites$,
  removeArtifactFavorite$,
} from "../services/artifact-favorites.service";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";

const favoritesEnabled$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "private, no-store");
  const auth = get(organizationAuthContext$);
  const context = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  signal.throwIfAborted();
  return (
    isFeatureEnabled(FeatureSwitchKey.ArtifactLibrary, context) &&
    isFeatureEnabled(FeatureSwitchKey.Star, context)
  );
});

const statusInput$ = computed((get) => {
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(artifactFavoritesContract.status));
  return {
    orgId: auth.orgId,
    userId: auth.userId,
    artifactIds: query.artifactIds.split(","),
  };
});
const status$ = artifactFavoriteStatus(statusInput$);

const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(favoritesEnabled$, signal))) {
    return resourceUnavailable("Favorites are not available");
  }
  const auth = get(organizationAuthContext$);
  const parsed = await get(bodyResultOf(artifactFavoritesContract.create));
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.data;
  const artifactId =
    "artifactId" in body
      ? body.artifactId
      : await set(favoriteArtifactIdFromUrl$, body.url, signal);
  signal.throwIfAborted();
  if (
    !artifactId ||
    !(await set(readFavoriteArtifact$, { ...auth, artifactId }, signal))
  ) {
    return notFound("Artifact not found");
  }
  const result = await set(
    createArtifactFavorite$,
    { orgId: auth.orgId, userId: auth.userId, artifactId },
    signal,
  );
  return { status: 200 as const, body: result };
});

const remove$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(favoritesEnabled$, signal))) {
    return resourceUnavailable("Favorites are not available");
  }
  const auth = get(organizationAuthContext$);
  const { artifactId } = get(pathParamsOf(artifactFavoritesContract.remove));
  const result = await set(
    removeArtifactFavorite$,
    { orgId: auth.orgId, userId: auth.userId, artifactId },
    signal,
  );
  return { status: 200 as const, body: result };
});

const list$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(favoritesEnabled$, signal))) {
    return resourceUnavailable("Favorites are not available");
  }
  const auth = get(organizationAuthContext$);
  const query = get(queryOf(artifactFavoritesContract.list));
  const result = await set(
    listArtifactFavorites$,
    { orgId: auth.orgId, userId: auth.userId, ...query },
    signal,
  );
  signal.throwIfAborted();
  return result
    ? { status: 200 as const, body: result }
    : badRequestMessage("Favorite cursor does not match this query");
});

const readStatus$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(favoritesEnabled$, signal))) {
    return resourceUnavailable("Favorites are not available");
  }
  const favorites = await get(status$);
  signal.throwIfAborted();
  return { status: 200 as const, body: { favorites } };
});

const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(favoritesEnabled$, signal))) {
    return resourceUnavailable("Favorites are not available");
  }
  const auth = get(organizationAuthContext$);
  const { url } = get(queryOf(artifactFavoritesContract.resolve));
  const artifactId = await set(favoriteArtifactIdFromUrl$, url, signal);
  signal.throwIfAborted();
  if (
    !artifactId ||
    !(await set(readFavoriteArtifact$, { ...auth, artifactId }, signal))
  ) {
    return notFound("Artifact not found");
  }
  const [favorite] = await get(db$)
    .select({ artifactId: artifactFavorites.artifactId })
    .from(artifactFavorites)
    .where(
      and(
        eq(artifactFavorites.orgId, auth.orgId),
        eq(artifactFavorites.userId, auth.userId),
        eq(artifactFavorites.artifactId, artifactId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: { artifactId, favorited: favorite !== undefined },
  };
});

const get$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!(await set(favoritesEnabled$, signal))) {
    return resourceUnavailable("Favorites are not available");
  }
  const auth = get(organizationAuthContext$);
  const { artifactId } = get(pathParamsOf(artifactFavoritesContract.get));
  const artifact = await set(
    readFavoriteArtifact$,
    { ...auth, artifactId },
    signal,
  );
  signal.throwIfAborted();
  return artifact
    ? { status: 200 as const, body: artifact.detail }
    : notFound("Artifact not found");
});

export const artifactFavoritesRoutes: readonly RouteEntry[] = [
  {
    route: artifactFavoritesContract.create,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "artifact:write",
      },
      create$,
    ),
  },
  {
    route: artifactFavoritesContract.remove,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "artifact:write",
      },
      remove$,
    ),
  },
  {
    route: artifactFavoritesContract.list,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "artifact:read",
      },
      list$,
    ),
  },
  {
    route: artifactFavoritesContract.status,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "artifact:read",
      },
      readStatus$,
    ),
  },
  {
    route: artifactFavoritesContract.resolve,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "artifact:read",
      },
      resolve$,
    ),
  },
  {
    route: artifactFavoritesContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        missingOrganizationStatus: 401,
        requiredCapability: "artifact:read",
      },
      get$,
    ),
  },
];
