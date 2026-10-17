import { runnerFileDownloadsContract } from "@okouai/api-contracts/contracts/runner-file-downloads";
import { command } from "ccstate";
import { notFound } from "../../lib/error";
import { authRoute } from "../auth/auth-route";
import { runnerAuth$ } from "../auth/runner-auth";
import { authorization$, setResHeader$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import {
  consumeFileDownload$,
  expireFileDownloads$,
  fileDownloadTarget$,
  issueFileDownload$,
} from "../services/runner-file-download.service";

const unavailable = notFound("File download unavailable");
const prepareInner$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(bodyResultOf(runnerFileDownloadsContract.bootstrap));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const target = await get(fileDownloadTarget$);
  signal.throwIfAborted();
  if (!target) {
    return unavailable;
  }
  await set(expireFileDownloads$, signal);
  const result = await set(
    issueFileDownload$,
    { target, path: body.data.path },
    signal,
  );
  return result
    ? { status: 200 as const, body: result }
    : {
        status: 409 as const,
        body: {
          error: {
            code: "DOWNLOAD_BUSY",
            message: "A download is already being prepared; retry shortly",
          },
        },
      };
});
const prepareAuth$ = authRoute(
  { requireOrganization: true, missingOrganizationStatus: 401 },
  prepareInner$,
);
const prepare$ = command(async ({ set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  return await set(prepareAuth$, signal);
});
const consume$ = command(async ({ get, set }, signal: AbortSignal) => {
  set(setResHeader$, "Cache-Control", "no-store");
  const auth = await set(runnerAuth$, get(authorization$), signal);
  signal.throwIfAborted();
  if (!auth) {
    return {
      status: 401 as const,
      body: {
        error: { code: "UNAUTHORIZED", message: "Authentication required" },
      },
    };
  }
  if (auth.type !== "official-runner") {
    return {
      status: 403 as const,
      body: {
        error: { code: "FORBIDDEN", message: "Official Runner required" },
      },
    };
  }
  const body = await get(bodyResultOf(runnerFileDownloadsContract.consume));
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(consumeFileDownload$, body.data, signal);
  return result ? { status: 200 as const, body: result } : unavailable;
});
export const runnerFileDownloadRoutes: readonly RouteEntry[] = [
  { route: runnerFileDownloadsContract.bootstrap, handler: prepare$ },
  { route: runnerFileDownloadsContract.consume, handler: consume$ },
];
