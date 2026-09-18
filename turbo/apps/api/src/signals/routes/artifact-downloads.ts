import { command } from "ccstate";
import { artifactDownloadsContract } from "@okouai/api-contracts/contracts/artifact-downloads";
import { notFound } from "../../lib/error";
import { authContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { setResHeader$ } from "../context/hono";
import { pathParamsOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { resolveArtifactDownload$ } from "../services/artifact-downloads.service";

const download$ = authRoute(
  { requiredCapability: "artifact:read" },
  command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const { reference } = get(pathParamsOf(artifactDownloadsContract.download));
    const result = await set(
      resolveArtifactDownload$,
      { reference, userId: auth.userId, orgId: auth.orgId },
      signal,
    );
    return result
      ? { status: 200 as const, body: result }
      : notFound("Artifact unavailable");
  }),
);

const files$ = authRoute(
  { requiredCapability: "host:read" },
  command(async ({ get, set }, signal: AbortSignal) => {
    const auth = get(authContext$);
    const { reference } = get(pathParamsOf(artifactDownloadsContract.files));
    const result = await set(
      resolveArtifactDownload$,
      {
        reference,
        userId: auth.userId,
        orgId: auth.orgId,
        expectedKind: "html",
      },
      signal,
    );
    return result?.kind === "html"
      ? { status: 200 as const, body: result.site }
      : notFound("Artifact unavailable");
  }),
);

export const artifactDownloadRoutes: readonly RouteEntry[] = [
  {
    route: artifactDownloadsContract.files,
    handler: command(async ({ set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      return await set(files$, signal);
    }),
  },
  {
    route: artifactDownloadsContract.download,
    handler: command(async ({ set }, signal: AbortSignal) => {
      set(setResHeader$, "Cache-Control", "private, no-store");
      set(setResHeader$, "Referrer-Policy", "no-referrer");
      return await set(download$, signal);
    }),
  },
];
