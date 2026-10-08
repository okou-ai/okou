import { command } from "ccstate";
import { webFilesContract } from "@okouai/api-contracts/contracts/web-files";

import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { queryOf } from "../context/request";
import { notFound, badRequestMessage } from "../../lib/error";
import { webDownloadFile$ } from "../services/web-download.service";
import type { RouteEntry } from "../route-entry";

const downloadFileInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const params = get(queryOf(webFilesContract.download));

    const fileId = params.file_id;
    if (!fileId) {
      return badRequestMessage("file_id query parameter is required");
    }

    const result = await set(
      webDownloadFile$,
      fileId,
      auth.userId,
      auth.orgId,
      signal,
    );
    if (!result) {
      return notFound("File not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", result.contentType);
    headers.set("X-File-Name", encodeURIComponent(result.filename));
    headers.set("X-File-Mimetype", result.contentType);
    headers.set("Content-Length", String(result.buffer.length));
    headers.set("Cache-Control", "private, no-store");
    if (result.isPrivate) {
      // Never execute uploaded HTML or SVG with the API origin's privileges.
      headers.set(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
      );
      headers.set("X-Content-Type-Options", "nosniff");
    }

    return new Response(new Uint8Array(result.buffer), {
      status: 200,
      headers,
    });
  },
);

export const webDownloadRoutes: readonly RouteEntry[] = [
  {
    route: webFilesContract.download,
    handler: authRoute(
      {
        requireOrganization: false,
        missingOrganizationStatus: 401,
        requiredCapability: "file:read",
      },
      downloadFileInner$,
    ),
  },
];
