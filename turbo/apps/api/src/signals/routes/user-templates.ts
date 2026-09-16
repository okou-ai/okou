import { command } from "ccstate";
import {
  userTemplatesContract,
  type UserTemplatePreviewAsset,
} from "@okouai/api-contracts/contracts/user-templates";
import { userTemplates } from "@okouai/db/schema/user-template";
import { and, eq } from "drizzle-orm";

import { notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import {
  publishPresentationTemplatesChangedForOrgSafely,
  publishPresentationTemplatesChangedForUserSafely,
} from "../external/realtime";
import {
  listAccessibleUserTemplates,
  loadAccessibleUserTemplate,
  parseUserTemplatePreviewAssetId,
  userTemplatePageKeys,
  userTemplatePreviewAssetId,
  userTemplateSummary,
  type UserTemplateRow,
} from "../services/user-template-data.service";
import { deleteUserTemplate$ } from "../services/user-template-delete.service";
import { templateArtifactBucket } from "../services/private-artifact-storage.service";
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

function templateNotFound(templateId: string) {
  return notFound(`User template not found: ${templateId}`);
}

interface AccessibleUserTemplatePreviewAsset {
  readonly previewAssetId: string;
  readonly request: PresentationTemplatePreviewPresignedUrlRequest;
}

/**
 * Presigned page URLs reuse the template-preview cache scope.
 *
 * The cache is keyed on the storage object — bucket, key, version and resolving
 * organization — and never on the row that points at it, and a user template's
 * pages are the same kind of object in the same bucket. A parallel scope would
 * duplicate the cache plumbing to produce identical URLs. The public asset id
 * is separate and does carry the row, which is what keeps the two tables' ids
 * from resolving against each other.
 */
function userTemplatePreviewAsset(args: {
  readonly row: UserTemplateRow;
  readonly objectKey: string;
  readonly orgId: string;
}): AccessibleUserTemplatePreviewAsset {
  const previewAssetId = userTemplatePreviewAssetId(
    args.row.id,
    args.objectKey,
  );
  const identity = parseUserTemplatePreviewAssetId(previewAssetId);
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

function userTemplatePreviewAssetsForRow(args: {
  readonly row: UserTemplateRow;
  readonly orgId: string;
}): readonly AccessibleUserTemplatePreviewAsset[] {
  return userTemplatePageKeys(args.row).map((objectKey) => {
    return userTemplatePreviewAsset({ ...args, objectKey });
  });
}

function resolvedUserTemplatePreviewAssets(
  assets: readonly AccessibleUserTemplatePreviewAsset[],
  urlsByCacheKey: ReadonlyMap<
    string,
    { readonly url: string; readonly expiresAt: Date }
  >,
): readonly UserTemplatePreviewAsset[] {
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

function accessibleUserTemplatePreviewAssets(args: {
  readonly rows: readonly UserTemplateRow[];
  readonly previewAssetIds: readonly string[];
  readonly orgId: string;
}): readonly AccessibleUserTemplatePreviewAsset[] {
  const rowById = new Map(
    args.rows.map((row) => {
      return [row.id, row];
    }),
  );
  return [...new Set(args.previewAssetIds)].flatMap((previewAssetId) => {
    const identity = parseUserTemplatePreviewAssetId(previewAssetId);
    const row = identity ? rowById.get(identity.templateId) : undefined;
    const objectKey = row
      ? userTemplatePageKeys(row).find((pageKey) => {
          return userTemplatePreviewAssetId(row.id, pageKey) === previewAssetId;
        })
      : undefined;
    return identity === null || row === undefined || objectKey === undefined
      ? []
      : [userTemplatePreviewAsset({ row, objectKey, orgId: args.orgId })];
  });
}

/** One cover URL, for the summary shapes that carry a cover and nothing else. */
const coverUrlFor$ = command(
  async (
    { get, set },
    args: { readonly row: UserTemplateRow; readonly orgId: string },
  ): Promise<string | null> => {
    const coverAsset = userTemplatePreviewAssetsForRow(args)[0];
    const urlsByCacheKey = await get(
      resolvePresentationTemplatePreviewPresignedUrls({
        db: set(writeDb$),
        requests: coverAsset === undefined ? [] : [coverAsset.request],
      }),
    );
    return coverAsset === undefined
      ? null
      : (resolvedUserTemplatePreviewAssets([coverAsset], urlsByCacheKey)[0]
          ?.url ?? null);
  },
);

const listInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const rows = await listAccessibleUserTemplates(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
  });
  signal.throwIfAborted();
  const previewAssetsByTemplateId = new Map(
    rows.map((row) => {
      return [
        row.id,
        userTemplatePreviewAssetsForRow({ row, orgId: auth.orgId }),
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
    const previewAssets = resolvedUserTemplatePreviewAssets(
      previewAssetsByTemplateId.get(row.id) ?? [],
      urlsByCacheKey,
    );
    return {
      ...userTemplateSummary(row, previewAssets[0]?.url ?? null, auth.userId),
      previewAssets,
    };
  });
  return { status: 200 as const, body: catalog };
});

const getParams$ = pathParamsOf(userTemplatesContract.get);
const getInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(getParams$);
  const row = await loadAccessibleUserTemplate(get(db$), {
    orgId: auth.orgId,
    userId: auth.userId,
    templateId: params.templateId,
  });
  signal.throwIfAborted();
  if (!row) {
    return templateNotFound(params.templateId);
  }
  const previewAssets = userTemplatePreviewAssetsForRow({
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
  const resolvedPreviewAssets = resolvedUserTemplatePreviewAssets(
    previewAssets,
    urlsByCacheKey,
  );
  const pageUrls = resolvedPreviewAssets.map((asset) => {
    return asset.url;
  });
  return {
    status: 200 as const,
    body: {
      ...userTemplateSummary(row, pageUrls[0] ?? null, auth.userId),
      pageUrls,
      previewAssets: resolvedPreviewAssets,
    },
  };
});

const resolvePreviewUrlsBody$ = bodyResultOf(
  userTemplatesContract.resolvePreviewUrls,
);
const resolvePreviewUrlsInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const bodyResult = await get(resolvePreviewUrlsBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }
    const rows = await listAccessibleUserTemplates(get(db$), {
      orgId: auth.orgId,
      userId: auth.userId,
    });
    signal.throwIfAborted();
    const assets = accessibleUserTemplatePreviewAssets({
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
        assets: resolvedUserTemplatePreviewAssets(assets, urlsByCacheKey),
      },
    };
  },
);

const updateParams$ = pathParamsOf(userTemplatesContract.update);
const updateBody$ = bodyResultOf(userTemplatesContract.update);
const updateInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(updateParams$);
  const bodyResult = await get(updateBody$);
  signal.throwIfAborted();
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const mutation = await set(writeDb$).transaction(async (tx) => {
    const whereOwner = and(
      eq(userTemplates.id, params.templateId),
      eq(userTemplates.orgId, auth.orgId),
      eq(userTemplates.ownerUserId, auth.userId),
    );
    const [previous] = await tx
      .select({ visibility: userTemplates.visibility })
      .from(userTemplates)
      .where(whereOwner)
      .for("update")
      .limit(1);
    if (!previous) {
      return null;
    }
    const [row] = await tx
      .update(userTemplates)
      .set({
        title: bodyResult.data.title,
        visibility: bodyResult.data.visibility,
        updatedAt: nowDate(),
        updatedBy: auth.userId,
      })
      .where(whereOwner)
      .returning();
    if (!row) {
      throw new Error(`User template disappeared: ${params.templateId}`);
    }
    // Either side of a visibility change has to reach the organization: making
    // a template private must retract it from members who can still see it.
    return {
      row,
      organizationVisible:
        previous.visibility === "organization" ||
        row.visibility === "organization",
    };
  });
  signal.throwIfAborted();
  if (!mutation) {
    return templateNotFound(params.templateId);
  }
  const { row, organizationVisible } = mutation;
  const coverUrl = await set(coverUrlFor$, { row, orgId: auth.orgId });
  signal.throwIfAborted();
  if (organizationVisible) {
    await publishPresentationTemplatesChangedForOrgSafely(auth.orgId);
  } else {
    await publishPresentationTemplatesChangedForUserSafely(auth.userId);
  }
  signal.throwIfAborted();
  return {
    status: 200 as const,
    body: userTemplateSummary(row, coverUrl, auth.userId),
  };
});

const deleteParams$ = pathParamsOf(userTemplatesContract.delete);
const deleteInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const params = get(deleteParams$);
  const deleted = await set(
    deleteUserTemplate$,
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
  if (deleted.visibility === "organization") {
    await publishPresentationTemplatesChangedForOrgSafely(auth.orgId);
  } else {
    await publishPresentationTemplatesChangedForUserSafely(auth.userId);
  }
  signal.throwIfAborted();
  return { status: 204 as const, body: undefined };
});

export const userTemplatesRoutes: readonly RouteEntry[] = [
  {
    route: userTemplatesContract.list,
    handler: authRoute(templateReadAuth, listInner$),
  },
  {
    route: userTemplatesContract.get,
    handler: authRoute(templateReadAuth, getInner$),
  },
  {
    route: userTemplatesContract.resolvePreviewUrls,
    handler: authRoute(templateReadAuth, resolvePreviewUrlsInner$),
  },
  {
    route: userTemplatesContract.update,
    handler: authRoute(templateWriteAuth, updateInner$),
  },
  {
    route: userTemplatesContract.delete,
    handler: authRoute(templateWriteAuth, deleteInner$),
  },
];
