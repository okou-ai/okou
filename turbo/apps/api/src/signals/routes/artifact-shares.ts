import { command, type Command } from "ccstate";
import { artifactSharesContract } from "@okouai/api-contracts/contracts/artifact-shares";
import { authContext$, organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { setResHeader$ } from "../context/hono";
import { notFound } from "../../lib/error";
import { privateArtifactCreationEnabled$ } from "../services/private-artifact-storage.service";
import {
  readArtifactShare$,
  resolveArtifactShare$,
  updateArtifactShare$,
  renderArtifactShareMarkdownCover$,
} from "../services/artifact-shares.service";
import { waitUntil } from "../context/wait-until";
import { tapError } from "../utils";
import { logger } from "../../lib/log";

import type { RouteEntry } from "../route-entry";

const coverLog = logger("artifacts:markdown-cover");

const availability$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const enabled = await set(
    privateArtifactCreationEnabled$,
    auth.orgId,
    auth.userId,
    signal,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { enabled } };
});

const status$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const parsed = await get(bodyResultOf(artifactSharesContract.status));
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const target = parsed.data;
  const result = await set(
    readArtifactShare$,
    { target, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  if (
    result?.shareId &&
    result.audience !== "private" &&
    target.kind === "file"
  ) {
    waitUntil(
      tapError(
        set(
          renderArtifactShareMarkdownCover$,
          {
            shareId: result.shareId,
            userId: auth.userId,
            orgId: auth.orgId,
          },
          AbortSignal.timeout(180_000),
        ),
        (error) => {
          coverLog.warn("Failed to prepare Markdown sharing cover", {
            shareId: result.shareId,
            error,
          });
        },
      ),
    );
  }
  return result
    ? { status: 200 as const, body: result }
    : notFound("Artifact not found");
});
const update$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const parsed = await get(bodyResultOf(artifactSharesContract.update));
  signal.throwIfAborted();
  if (!parsed.ok) {
    return parsed.response;
  }
  const body = parsed.data;
  if (
    body.audience !== "private" &&
    !(await set(
      privateArtifactCreationEnabled$,
      auth.orgId,
      auth.userId,
      signal,
    ))
  ) {
    return {
      status: 403 as const,
      body: {
        error: {
          code: "FORBIDDEN",
          message: "Artifact sharing is not available",
        },
      },
    };
  }
  signal.throwIfAborted();
  const result = await set(
    updateArtifactShare$,
    { ...body, userId: auth.userId, orgId: auth.orgId },
    signal,
  );
  if (result && "status" in result) {
    return result;
  }
  if (
    result?.shareId &&
    body.audience !== "private" &&
    body.target.kind === "file"
  ) {
    waitUntil(
      tapError(
        set(
          renderArtifactShareMarkdownCover$,
          {
            shareId: result.shareId,
            userId: auth.userId,
            orgId: auth.orgId,
          },
          AbortSignal.timeout(180_000),
        ),
        (error) => {
          coverLog.warn("Failed to prepare Markdown sharing cover", {
            shareId: result.shareId,
            error,
          });
        },
      ),
    );
  }
  return result
    ? { status: 200 as const, body: result }
    : notFound("Artifact not found");
});
const resolve$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(authContext$);
  const { id } = get(pathParamsOf(artifactSharesContract.resolve));
  const result = await set(
    resolveArtifactShare$,
    { id, userId: auth.userId },
    signal,
  );
  return result
    ? { status: 200 as const, body: result }
    : notFound("Artifact unavailable");
});
function noStore(handler: Command<unknown, [AbortSignal]>) {
  return command(async ({ set }, signal: AbortSignal) => {
    set(setResHeader$, "Cache-Control", "private, no-store");
    set(setResHeader$, "Referrer-Policy", "no-referrer");
    return await set(handler, signal);
  });
}
// Run tokens need explicit artifact capabilities; upload/hosting capabilities
// alone cannot publish. Services retain owner and original-org authorization.
export const artifactShareRoutes: readonly RouteEntry[] = [
  {
    route: artifactSharesContract.availability,
    handler: noStore(
      authRoute(
        { requireOrganization: true, requiredCapability: "artifact:read" },
        availability$,
      ),
    ),
  },
  {
    route: artifactSharesContract.status,
    handler: noStore(
      authRoute(
        { requireOrganization: true, requiredCapability: "artifact:read" },
        status$,
      ),
    ),
  },
  {
    route: artifactSharesContract.update,
    handler: noStore(
      authRoute(
        { requireOrganization: true, requiredCapability: "artifact:write" },
        update$,
      ),
    ),
  },
  {
    route: artifactSharesContract.resolve,
    handler: noStore(authRoute({}, resolve$)),
  },
];
