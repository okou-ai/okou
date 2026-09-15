import { nowDate } from "../../lib/time";
import { command } from "ccstate";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { generateArtifactPreviewUrl } from "../external/s3";
import { uploadedArtifactObject } from "../services/uploaded-artifact.service";
import type { RouteEntry } from "../route-entry";

const fileUrlInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const params = get(queryOf(webFilesContract.fileUrl));

  const object = await get(
    uploadedArtifactObject({
      userId: auth.userId,
      orgId: auth.orgId,
      id: params.file_id,
    }),
  );
  signal.throwIfAborted();
  if (!object) {
    return notFound("File not found");
  }

  // Signed against the object key resolved for this user, so the URL never
  // widens beyond what the ownership check already allowed.
  const preview = await get(
    generateArtifactPreviewUrl(object.bucket, object.key, {
      signingDate: nowDate(),
    }),
  );

  signal.throwIfAborted();
  if (object.isPrivate) {
    set(setResHeader$, "Cache-Control", "private, no-store");
  }
  return {
    status: 200 as const,
    body: { ...preview, publicUrl: object.isPrivate ? null : object.url },
  };
});

export const webFileUrlRoutes: readonly RouteEntry[] = [
  {
    route: webFilesContract.fileUrl,
    handler: authRoute(
      {
        requireOrganization: false,
        missingOrganizationStatus: 401,
        requiredCapability: "file:read",
      },
      fileUrlInner$,
    ),
  },
];
