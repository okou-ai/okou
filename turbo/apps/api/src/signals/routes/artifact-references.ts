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
import { pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { generateArtifactPreviewUrl, s3ObjectHead } from "../external/s3";
import { privateArtifactRecord } from "../services/private-artifact-storage.service";
import { createPrivateHostedPreview$ } from "../services/private-hosted-preview.service";
import {
  resolveArtifactShare$,
  resolveArtifactTargetShare$,
} from "../services/artifact-shares.service";
import { artifactReferenceRecord } from "../services/artifact-reference.service";
import type { RouteEntry } from "../route-entry";

const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const { kind: ownerKind } = get(queryOf(artifactReferencesContract.resolve));
  const { reference } = get(pathParamsOf(artifactReferencesContract.resolve));
  const parsed = parseArtifactReference(`/artifacts/${reference}`);
  if (!parsed) {
    return notFound("Artifact unavailable");
  }
  let id = parsed.id;
  let targetKind: "file" | "html" | undefined;
  if (id === null) {
    const record = await get(artifactReferenceRecord(parsed.hash, signal));
    signal.throwIfAborted();
    if (!record) return notFound("Artifact unavailable");
    if (record.version === 1) {
      if (ownerKind) return notFound("Artifact unavailable");
      const shared = await set(
        resolveArtifactShare$,
        { id: record.shareId, userId: auth.userId },
        signal,
      );
      return shared
        ? { status: 200 as const, body: shared }
        : notFound("Artifact unavailable");
    }
    id = record.target.id;
    targetKind = record.target.kind;
  }
  const file =
    targetKind === "html" ? null : await get(privateArtifactRecord(id));
  signal.throwIfAborted();
  if (file) {
    if (ownerKind === "html") return notFound("Artifact unavailable");
    if (file.userId !== auth.userId || file.orgId !== auth.orgId) {
      if (ownerKind) return notFound("Artifact unavailable");
      const shared = await set(
        resolveArtifactTargetShare$,
        { target: { kind: "file", id }, targetId: id, userId: auth.userId },
        signal,
      );
      return shared
        ? { status: 200 as const, body: shared }
        : notFound("Artifact unavailable");
    }
    // Older attachment composers do not call complete after a single PUT.
    // Verify the owned object exists before signing its preview; multipart
    // uploads remain unreadable until R2 publishes the completed object.
    const object = await get(s3ObjectHead(file.bucket, file.key));
    signal.throwIfAborted();
    if (object.kind === "missing") {
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
  if (targetKind === "file") return notFound("Artifact unavailable");
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
    if (ownerKind === "file") return notFound("Artifact unavailable");
    const deployment = site.deployment;
    if (deployment.userId !== auth.userId || deployment.orgId !== auth.orgId) {
      if (ownerKind) return notFound("Artifact unavailable");
      const shared = await set(
        resolveArtifactTargetShare$,
        {
          target: { kind: "html", id },
          targetId: deployment.siteId,
          userId: auth.userId,
        },
        signal,
      );
      return shared
        ? { status: 200 as const, body: shared }
        : notFound("Artifact unavailable");
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
  if (targetKind || ownerKind) return notFound("Artifact unavailable");
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
const authorizedFileResolve$ = authRoute(
  { requiredCapability: "file:read" },
  resolve$,
);
const authorizedHostedResolve$ = authRoute(
  { requiredCapability: "host:read" },
  resolve$,
);

export const artifactReferenceRoutes: readonly RouteEntry[] = [
  {
    route: artifactReferencesContract.resolve,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      const { kind } = get(queryOf(artifactReferencesContract.resolve));
      return await set(
        kind === "file"
          ? authorizedFileResolve$
          : kind === "html"
            ? authorizedHostedResolve$
            : authorizedResolve$,
        signal,
      );
    }),
  },
];
