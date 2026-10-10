import { command } from "ccstate";
import {
  presentationTemplatesContract,
  type PresentationTemplatePreviewAsset,
} from "@okouai/api-contracts/contracts/presentation-templates";
import { presentationTemplates } from "@okouai/db/schema/presentation-template";
import { and, eq, getTableColumns, sql } from "drizzle-orm";

import { notFound } from "../../lib/error";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import {
  publishPresentationTemplatesChangedForOrgSafely,
  publishPresentationTemplatesChangedForUserSafely,
} from "../external/realtime";
import {
  listAccessiblePresentationTemplates,
  loadAccessiblePresentationTemplate,
  parsePresentationTemplatePreviewAssetId,
  presentationTemplatePreviewAssetId,
  presentationTemplateSummary,
  type PresentationTemplateRow,
} from "../services/presentation-template-data.service";
import { deletePresentationTemplate$ } from "../services/presentation-template-delete.service";
import { templateArtifactBucket } from "../services/private-artifact-storage.service";
import { publishPresentationTemplate$ } from "../services/presentation-template-publish.service";
import {
  presentationTemplatePreviewPresignedUrlCacheKey,
  resolvePresentationTemplatePreviewPresignedUrls,
  type PresentationTemplatePreviewPresignedUrlRequest,
} from "../services/system-storage-presigned-url-cache.service";
import type { RouteEntry } from "../route-entry";

const templateReadAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:read",
} as const;

const templateWriteAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "agent:write",
} as const;

/** Publishing is done by the analysis run, not by the browser session. */
const templatePublishAuth = {
  requireOrganization: true,
  missingOrganizationStatus: 401,
  requiredCapability: "presentation-template:write",
} as const;

function templateNotFound(templateId: string) {
  return notFound(`Presentation template not found: ${templateId}`);
}

interface AccessiblePresentationTemplatePreviewAsset {
  readonly previewAssetId: string;
  readonly request: PresentationTemplatePreviewPresignedUrlRequest;
}

function presentationTemplatePreviewAsset(args: {
  readonly row: PresentationTemplateRow;
  readonly objectKey: string;
  readonly orgId: string;
}): AccessiblePresentationTemplatePreviewAsset {
  const previewAssetId = presentationTemplatePreviewAssetId(
    args.row.id,
    args.objectKey,
  );
  const identity = parsePresentationTemplatePreviewAssetId(previewAssetId);
  if (identity === null) {
    throw new Error(`Invalid generated preview asset id: ${previewAssetId}`);
  }
  return {
    previewAssetId,
    request: {
      bucket: templateArtifactBucket(args.objectKey),
      objectKey: args.objectKey,
      storageVersionId: identity.storageVersionId,
      resolvedOrgId: args.orgId,
      publicEndpoint: true,
    },
  };
}

function presentationTemplatePreviewAssetsForRow(args: {
  readonly row: PresentationTemplateRow;
  readonly orgId: string;
}): readonly AccessiblePresentationTemplatePreviewAsset[] {
  return args.row.pageKeys.map((objectKey) => {
    return presentationTemplatePreviewAsset({ ...args, objectKey });
  });
}

function resolvedPresentationTemplatePreviewAssets(
  assets: readonly AccessiblePresentationTemplatePreviewAsset[],
  urlsByCacheKey: ReadonlyMap<
    string,
    { readonly url: string; readonly expiresAt: Date }
  >,
): readonly PresentationTemplatePreviewAsset[] {
  return assets.map((asset) => {
    const result = urlsByCacheKey.get(
      presentationTemplatePreviewPresignedUrlCacheKey(asset.request),
    );
    if (result === undefined) {
      throw new Error(`Preview URL not resolved: ${asset.previewAssetId}`);
    }
    return {
      previewAssetId: asset.previewAssetId,
      url: result.url,
      expiresAt: result.expiresAt.toISOString(),
    };
  });
}

function accessiblePresentationTemplatePreviewAssets(args: {
  readonly rows: readonly PresentationTemplateRow[];
  readonly previewAssetIds: readonly string[];
  readonly orgId: string;
}): readonly AccessiblePresentationTemplatePreviewAsset[] {
  const rowById = new Map(
    args.rows.map((row) => {
      return [row.id, row];
    }),
  );
  return [...new Set(args.previewAssetIds)].flatMap((previewAssetId) => {
    const identity = parsePresentationTemplatePreviewAssetId(previewAssetId);
    const row = identity ? rowById.get(identity.templateId) : undefined;
    const objectKey = row?.pageKeys.find((pageKey) => {
      return (
        presentationTemplatePreviewAssetId(row.id, pageKey) === previewAssetId
      );
    });
    return identity === null || row === undefined || objectKey === undefined
      ? []
      : [
          presentationTemplatePreviewAsset({
            row,
            objectKey,
            orgId: args.orgId,
          }),
        ];
  });
}

const publishBody$ = bodyResultOf(presentationTemplatesContract.publish);
const publishInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const bodyResult = await get(publishBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const result = await set(
    publishPresentationTemplate$,
    { orgId: auth.orgId, ownerUserId: auth.userId, body: bodyResult.data },
    signal,
  );
  signal.throwIfAborted();
  if (result.kind === "rejected") {
    return result.response;
  }
  const row = await loadAccessiblePresentationTemplate(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    templateId: result.templateId,
  });
  signal.throwIfAborted();
  if (!row) {
    throw new Error(`Published template not found: ${result.templateId}`);
  }
  const coverAsset = presentationTemplatePreviewAssetsForRow({
    row,
    orgId: auth.orgId,
  })[0];
  const coverUrlsByCacheKey = await get(
    resolvePresentationTemplatePreviewPresignedUrls({
      db: set(writeDb$),
      requests: coverAsset === undefined ? [] : [coverAsset.request],
    }),
  );
  signal.throwIfAborted();
  const coverUrl =
    coverAsset === undefined
      ? null
      : (resolvedPresentationTemplatePreviewAssets(
          [coverAsset],
          coverUrlsByCacheKey,
        )[0]?.url ?? null);
  await publishPresentationTemplatesChangedForUserSafely(auth.userId);
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: presentationTemplateSummary(row, coverUrl, auth.userId),
  };
});

const listInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const rows = await listAccessiblePresentationTemplates(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  const previewAssetsByTemplateId = new Map(
    rows.map((row) => {
      return [
        row.id,
        presentationTemplatePreviewAssetsForRow({
          row,
          orgId: auth.orgId,
        }),
      ] as const;
    }),
  );
  const urlsByCacheKey = await get(
    resolvePresentationTemplatePreviewPresignedUrls({
      db: set(writeDb$),
      requests: [...previewAssetsByTemplateId.values()].flatMap((assets) => {
        return assets.map((asset) => {
          return asset.request;
        });
      }),
    }),
  );
  signal.throwIfAborted();
  const catalog = rows.map((row) => {
    const previewAssets = resolvedPresentationTemplatePreviewAssets(
      previewAssetsByTemplateId.get(row.id) ?? [],
      urlsByCacheKey,
    );
    return {
      ...presentationTemplateSummary(
        row,
        previewAssets[0]?.url ?? null,
        auth.userId,
      ),
      previewAssets,
    };
  });
  return { status: 200 as const, body: catalog };
});

const getParams$ = pathParamsOf(presentationTemplatesContract.get);
const getInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(getParams$);
  const row = await loadAccessiblePresentationTemplate(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    templateId: params.templateId,
  });
  signal.throwIfAborted();
  if (!row) {
    return templateNotFound(params.templateId);
  }
  const previewAssets = presentationTemplatePreviewAssetsForRow({
    row,
    orgId: auth.orgId,
  });
  const urlsByCacheKey = await get(
    resolvePresentationTemplatePreviewPresignedUrls({
      db: set(writeDb$),
      requests: previewAssets.map((asset) => {
        return asset.request;
      }),
    }),
  );
  signal.throwIfAborted();
  const resolvedPreviewAssets = resolvedPresentationTemplatePreviewAssets(
    previewAssets,
    urlsByCacheKey,
  );
  const pageUrls = resolvedPreviewAssets.map((asset) => {
    return asset.url;
  });
  return {
    status: 200 as const,
    body: {
      ...presentationTemplateSummary(row, pageUrls[0] ?? null, auth.userId),
      pageUrls,
      previewAssets: resolvedPreviewAssets,
    },
  };
});

const resolvePreviewUrlsBody$ = bodyResultOf(
  presentationTemplatesContract.resolvePreviewUrls,
);
const resolvePreviewUrlsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(resolvePreviewUrlsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const rows = await listAccessiblePresentationTemplates(get(db$), {
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    const assets = accessiblePresentationTemplatePreviewAssets({
      rows,
      previewAssetIds: bodyResult.data.previewAssetIds,
      orgId: auth.orgId,
    });
    const urlsByCacheKey = await get(
      resolvePresentationTemplatePreviewPresignedUrls({
        db: set(writeDb$),
        requests: assets.map((asset) => {
          return asset.request;
        }),
      }),
    );
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: {
        assets: resolvedPresentationTemplatePreviewAssets(
          assets,
          urlsByCacheKey,
        ),
      },
    };
  },
);

const updateParams$ = pathParamsOf(presentationTemplatesContract.update);
const updateBody$ = bodyResultOf(presentationTemplatesContract.update);
const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(updateParams$);
  const bodyResult = await get(updateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const db = set(writeDb$);
  const whereOwner = and(
    eq(presentationTemplates.id, params.templateId),
    eq(presentationTemplates.orgId, auth.orgId),
    eq(presentationTemplates.ownerUserId, auth.userId),
  );
  // Keep the existing row lock in the statement: when it waits for a concurrent
  // update, retraction must notify the workspace using the replaced visibility.
  const previous = db.$with("previous").as(
    db
      .select({
        id: presentationTemplates.id,
        visibility: presentationTemplates.visibility,
      })
      .from(presentationTemplates)
      .where(whereOwner)
      .for("update")
      .limit(1),
  );
  const [mutation] = await db
    .with(previous)
    .update(presentationTemplates)
    .set({
      title: bodyResult.data.title,
      visibility: bodyResult.data.visibility,
      // Sample after the lock: pre-wait time can leave a client's optimistic
      // summary newer than the catalog after concurrent writes.
      updatedAt: sql`clock_timestamp() AT TIME ZONE 'UTC'`,
      updatedBy: auth.userId,
    })
    .from(previous)
    .where(and(whereOwner, eq(presentationTemplates.id, previous.id)))
    .returning({
      row: getTableColumns(presentationTemplates),
      previousVisibility: previous.visibility,
    });
  signal.throwIfAborted();
  if (!mutation) {
    return templateNotFound(params.templateId);
  }
  const { row, previousVisibility } = mutation;
  const workspaceVisible =
    previousVisibility === "public" || row.visibility === "public";
  const coverAsset = presentationTemplatePreviewAssetsForRow({
    row,
    orgId: auth.orgId,
  })[0];
  const coverUrlsByCacheKey = await get(
    resolvePresentationTemplatePreviewPresignedUrls({
      db: set(writeDb$),
      requests: coverAsset === undefined ? [] : [coverAsset.request],
    }),
  );
  signal.throwIfAborted();
  const coverUrl =
    coverAsset === undefined
      ? null
      : (resolvedPresentationTemplatePreviewAssets(
          [coverAsset],
          coverUrlsByCacheKey,
        )[0]?.url ?? null);
  if (workspaceVisible) {
    await publishPresentationTemplatesChangedForOrgSafely(auth.orgId);
  } else {
    await publishPresentationTemplatesChangedForUserSafely(auth.userId);
  }
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: presentationTemplateSummary(row, coverUrl, auth.userId),
  };
});

const deleteParams$ = pathParamsOf(presentationTemplatesContract.delete);
const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(deleteParams$);
  const deleted = await set(
    deletePresentationTemplate$,
    {
      orgId: auth.orgId,
      ownerUserId: auth.userId,
      templateId: params.templateId,
    },
    signal,
  );
  if (!deleted) {
    return templateNotFound(params.templateId);
  }
  if (deleted.visibility === "public") {
    await publishPresentationTemplatesChangedForOrgSafely(auth.orgId);
  } else {
    await publishPresentationTemplatesChangedForUserSafely(auth.userId);
  }
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const presentationTemplatesRoutes: readonly RouteEntry[] = [
  {
    route: presentationTemplatesContract.publish,
    handler: authRoute(templatePublishAuth, publishInner$),
  },
  {
    route: presentationTemplatesContract.list,
    handler: authRoute(templateReadAuth, listInner$),
  },
  {
    route: presentationTemplatesContract.get,
    handler: authRoute(templateReadAuth, getInner$),
  },
  {
    route: presentationTemplatesContract.resolvePreviewUrls,
    handler: authRoute(templateReadAuth, resolvePreviewUrlsInner$),
  },
  {
    route: presentationTemplatesContract.update,
    handler: authRoute(templateWriteAuth, updateInner$),
  },
  {
    route: presentationTemplatesContract.delete,
    handler: authRoute(templateWriteAuth, deleteInner$),
  },
];
