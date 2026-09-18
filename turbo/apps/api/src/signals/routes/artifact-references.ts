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
import { authorization$, setResHeader$ } from "../context/hono";
import { pathParamsOf, queryOf } from "../context/request";
import { db$ } from "../external/db";
import { generateArtifactPreviewUrl, s3ObjectHead } from "../external/s3";
import { privateArtifactRecord } from "../services/private-artifact-storage.service";
import { createPrivateHostedPreview$ } from "../services/private-hosted-preview.service";
import {
  resolveArtifactShare$,
  resolveArtifactTargetShare$,
  resolvePublicArtifactUrl$,
} from "../services/artifact-shares.service";
import { artifactReferenceRecord } from "../services/artifact-reference.service";
import { resolveSharedThreadArtifactReference$ } from "../services/shared-thread-artifact-reference.service";
import type { RouteEntry } from "../route-entry";

const resolveFileReference$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly ownerKind: "file" | "html" | "artifact" | undefined;
    },
    signal: AbortSignal,
  ) => {
    const { id, ownerKind } = args;
    const auth = get(authContext$);
    const file = await get(privateArtifactRecord(id));
    signal.throwIfAborted();
    if (file) {
      if (ownerKind === "html") {
        return notFound("Artifact unavailable");
      }
      if (file.userId !== auth.userId || file.orgId !== auth.orgId) {
        if (ownerKind) {
          return notFound("Artifact unavailable");
        }
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
    return null;
  },
);

const resolveHostedReference$ = command(
  async (
    { get, set },
    args: {
      readonly id: string;
      readonly ownerKind: "file" | "html" | "artifact" | undefined;
    },
    signal: AbortSignal,
  ) => {
    const { id, ownerKind } = args;
    const auth = get(authContext$);
    const [site] = await get(db$)
      .select({ deployment: privateHostedDeployments })
      .from(privateHostedDeployments)
      .innerJoin(
        hostedSites,
        eq(hostedSites.id, privateHostedDeployments.siteId),
      )
      .where(
        and(eq(privateHostedDeployments.id, id), isNull(hostedSites.deletedAt)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (site) {
      if (ownerKind === "file") {
        return notFound("Artifact unavailable");
      }
      const deployment = site.deployment;
      if (
        deployment.userId !== auth.userId ||
        deployment.orgId !== auth.orgId
      ) {
        if (ownerKind) {
          return notFound("Artifact unavailable");
        }
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
    return null;
  },
);

const resolveReference$ = command(
  async (
    { get, set },
    reference: string,
    ownerKind: "file" | "html" | "artifact" | undefined,
    signal: AbortSignal,
  ) => {
    const auth = get(authContext$);
    const parsed = parseArtifactReference(`/artifacts/${reference}`);
    if (!parsed) {
      return notFound("Artifact unavailable");
    }
    let id = parsed.id;
    let targetKind: "file" | "html" | undefined;
    if (id === null) {
      const record = await get(artifactReferenceRecord(parsed.hash, signal));
      signal.throwIfAborted();
      if (!record) {
        return notFound("Artifact unavailable");
      }
      if (record.version === 3) {
        if (ownerKind) {
          return notFound("Artifact unavailable");
        }
        const shared = await set(
          resolveSharedThreadArtifactReference$,
          record,
          signal,
        );
        return shared
          ? { status: 200 as const, body: shared }
          : notFound("Artifact unavailable");
      }
      if (record.version === 1) {
        if (ownerKind) {
          return notFound("Artifact unavailable");
        }
        const shared = await set(
          resolveArtifactShare$,
          { id: record.shareId, userId: auth.userId, allowPrivateOwner: true },
          signal,
        );
        return shared
          ? { status: 200 as const, body: shared }
          : notFound("Artifact unavailable");
      }
      id = record.target.id;
      targetKind = record.target.kind;
    }
    if (targetKind !== "html") {
      const file = await set(resolveFileReference$, { id, ownerKind }, signal);
      if (file) {
        return file;
      }
    }
    if (targetKind === "file") {
      return notFound("Artifact unavailable");
    }
    const hosted = await set(
      resolveHostedReference$,
      { id, ownerKind },
      signal,
    );
    if (hosted) {
      return hosted;
    }
    if (targetKind || ownerKind) {
      return notFound("Artifact unavailable");
    }
    const shared = await set(
      resolveArtifactShare$,
      { id, userId: auth.userId, allowPrivateOwner: true },
      signal,
    );
    return shared
      ? { status: 200 as const, body: shared }
      : notFound("Artifact unavailable");
  },
);

const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { kind } = get(queryOf(artifactReferencesContract.resolve));
  const { reference } = get(pathParamsOf(artifactReferencesContract.resolve));
  return await set(resolveReference$, reference, kind, signal);
});

const resolvePublicReference$ = command(
  async ({ get, set }, reference: string, signal: AbortSignal) => {
    const parsed = parseArtifactReference(`/artifacts/${reference}`);
    if (!parsed) {
      return notFound("Artifact unavailable");
    }
    const record =
      parsed.id === null
        ? await get(artifactReferenceRecord(parsed.hash, signal))
        : null;
    signal.throwIfAborted();
    if (record?.version === 3) {
      const shared = await set(
        resolveSharedThreadArtifactReference$,
        record,
        signal,
      );
      return shared
        ? {
            status: 200 as const,
            body: {
              url: shared.url,
              expiresAt: shared.expiresAt,
              sharedThreadSnapshot: shared.sharedThreadSnapshot,
              preview: {
                filename: shared.filename,
                contentType: shared.contentType,
              },
            },
          }
        : notFound("Artifact unavailable");
    }
    const target =
      parsed.id !== null
        ? { id: parsed.id }
        : record?.version === 1
          ? { id: record.shareId, kind: "share" as const }
          : record?.target;
    if (!target) {
      return notFound("Artifact unavailable");
    }
    const result = await set(resolvePublicArtifactUrl$, target, signal);
    return result
      ? { status: 200 as const, body: result }
      : notFound("Artifact unavailable");
  },
);

const read$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { reference } = get(pathParamsOf(artifactReferencesContract.read));
  const result = await set(resolveReference$, reference, undefined, signal);
  if (result.status === 200) {
    return {
      status: 200 as const,
      body: {
        url: result.body.url,
        filename: result.body.filename,
        contentType: result.body.contentType,
      },
    };
  }
  // Public content remains readable outside its originating organization,
  // just as it is in the artifact viewer.
  const published = await set(resolvePublicReference$, reference, signal);
  return published.status === 200
    ? {
        status: 200 as const,
        body: { url: published.body.url, ...published.body.preview },
      }
    : published;
});

const authorizedRead$ = authRoute(
  { requiredCapability: "artifact:read" },
  read$,
);

const authorizedResolve$ = authRoute({}, resolve$);
const authorizedFileResolve$ = authRoute(
  { requiredCapability: "file:read" },
  resolve$,
);
const authorizedHostedResolve$ = authRoute(
  { requiredCapability: "host:read" },
  resolve$,
);
const authorizedArtifactResolve$ = authRoute(
  { requiredCapability: "artifact:read" },
  resolve$,
);

export const artifactReferenceRoutes: readonly RouteEntry[] = [
  {
    route: artifactReferencesContract.read,
    handler: command(async ({ set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      return await set(authorizedRead$, signal);
    }),
  },
  {
    route: artifactReferencesContract.publicUrl,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      const { reference } = get(
        pathParamsOf(artifactReferencesContract.publicUrl),
      );
      return await set(resolvePublicReference$, reference, signal);
    }),
  },
  {
    route: artifactReferencesContract.resolve,
    handler: command(async ({ get, set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      const { kind } = get(queryOf(artifactReferencesContract.resolve));
      if (kind === undefined && !get(authorization$)) {
        const { reference } = get(
          pathParamsOf(artifactReferencesContract.resolve),
        );
        const parsed = parseArtifactReference(`/artifacts/${reference}`);
        const record =
          parsed?.id === null
            ? await get(artifactReferenceRecord(parsed.hash, signal))
            : null;
        signal.throwIfAborted();
        if (record?.version === 3) {
          const shared = await set(
            resolveSharedThreadArtifactReference$,
            record,
            signal,
          );
          return shared
            ? { status: 200 as const, body: shared }
            : notFound("Artifact unavailable");
        }
      }
      return await set(
        kind === "file"
          ? authorizedFileResolve$
          : kind === "html"
            ? authorizedHostedResolve$
            : kind === "artifact"
              ? authorizedArtifactResolve$
              : authorizedResolve$,
        signal,
      );
    }),
  },
];
