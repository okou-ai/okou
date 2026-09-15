import { nowDate } from "../../lib/time";
import { command } from "ccstate";
import { and, eq, isNull } from "drizzle-orm";
import {
  artifactReferencesContract,
  parseArtifactReference,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  hostedSites,
  privateHostedDeployments,
} from "@okouai/db/schema/hosted-site";
import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import { generateArtifactPreviewUrl } from "../external/s3";
import { privateArtifactRecord } from "../services/private-artifact-storage.service";
import { createPrivateHostedPreview$ } from "../services/private-hosted-preview.service";
import { resolveArtifactShare$ } from "../services/artifact-shares.service";
import { artifactShareReference } from "../services/artifact-share-alias.service";
import type { RouteEntry } from "../route-entry";

const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const { reference } = get(pathParamsOf(artifactReferencesContract.resolve));
  const parsed = parseArtifactReference(`/artifacts/${reference}`);
  if (!parsed) {
    return notFound("Artifact unavailable");
  }
  const id = parsed.id;
  if (id === null) {
    const shareId = await get(artifactShareReference(parsed.hash, signal));
    signal.throwIfAborted();
    const shared = shareId
      ? await set(
          resolveArtifactShare$,
          { id: shareId, userId: auth.userId },
          signal,
        )
      : null;
    return shared
      ? { status: 200 as const, body: shared }
      : notFound("Artifact unavailable");
  }
  const file = await get(privateArtifactRecord(id));
  signal.throwIfAborted();
  if (file) {
    if (
      file.userId !== auth.userId ||
      file.orgId !== auth.orgId ||
      file.materializationStatus !== "ready"
    ) {
      return notFound("Artifact unavailable");
    }
    const preview = await get(
      generateArtifactPreviewUrl(file.bucket, file.key, {
        signingDate: nowDate(),
      }),
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        ...preview,
        filename: file.filename,
        contentType: file.contentType,
        target: { kind: "file" as const, id },
      },
    };
  }
  const [site] = await get(db$)
    .select({ deployment: privateHostedDeployments })
    .from(privateHostedDeployments)
    .innerJoin(hostedSites, eq(hostedSites.id, privateHostedDeployments.siteId))
    .where(
      and(eq(privateHostedDeployments.id, id), isNull(hostedSites.deletedAt)),
    )
    .limit(1);
  signal.throwIfAborted();
  if (site) {
    const deployment = site.deployment;
    if (deployment.userId !== auth.userId || deployment.orgId !== auth.orgId) {
      return notFound("Artifact unavailable");
    }
    const preview = await set(
      createPrivateHostedPreview$,
      { deploymentId: id, userId: auth.userId, orgId: deployment.orgId },
      signal,
    );
    return preview
      ? {
          status: 200 as const,
          body: {
            ...preview,
            filename: "index.html",
            contentType: "text/html",
            target: { kind: "html" as const, id },
          },
        }
      : notFound("Artifact unavailable");
  }
  const shared = await set(
    resolveArtifactShare$,
    { id, userId: auth.userId },
    signal,
  );
  return shared
    ? { status: 200 as const, body: shared }
    : notFound("Artifact unavailable");
});

const authorizedResolve$ = authRoute({}, resolve$);

export const artifactReferenceRoutes: readonly RouteEntry[] = [
  {
    route: artifactReferencesContract.resolve,
    // Browser/PAT entry. Agent byte and bundle reads retain their existing
    // file:read and host:read capability boundaries.
    handler: command(async ({ set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      return await set(authorizedResolve$, signal);
    }),
  },
];
