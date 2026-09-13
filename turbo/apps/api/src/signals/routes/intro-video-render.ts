import { command } from "ccstate";
import { introVideoRenderContract } from "@okouai/api-contracts/contracts/intro-video-render";
import { env } from "../../lib/env";
import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { checkBillableOperationCredits$ } from "../services/billable-operation-admission.service";
import {
  introVideoDisabled,
  introVideoEnabled$,
} from "../services/intro-video-access.service";
import { introVideoRenderPricing$ } from "../services/intro-video-render-pricing.service";
import {
  IntroVideoProjectError,
  prepareIntroVideoRenderProject$,
} from "../services/intro-video-render-project.service";
import {
  createIntroVideoRenderJob$,
  introVideoRenderHash,
  isOwnedIntroVideoRender,
  loadIntroVideoRenderJob$,
  reconcileIntroVideoRender$,
  serializeIntroVideoRender,
} from "../services/intro-video-render.service";
import { loadOrgPlanCapabilities } from "../services/org-plan-entitlement-read.service";
import { settle } from "../utils";

const body$ = bodyResultOf(introVideoRenderContract.create);
const params$ = pathParamsOf(introVideoRenderContract.get);
const errorBody = (code: string, message: string) => {
  return {
    error: { code, message },
  };
};
function notFound() {
  return {
    status: 404 as const,
    body: errorBody("NOT_FOUND", "Cloud render or project file not found"),
  };
}
function conflict() {
  return {
    status: 409 as const,
    body: errorBody(
      "REQUEST_ID_CONFLICT",
      "This request ID belongs to different input. Resume the original generation.",
    ),
  };
}

function renderStorageConfigured(): boolean {
  const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
  return (
    !!env("HEYGEN_API_KEY") &&
    !!privateBucket &&
    privateBucket !== env("R2_USER_ARTIFACTS_BUCKET_NAME")
  );
}

const postRender$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "agent") {
    throw new Error("Cloud rendering requires run authentication");
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const input = body.data;
  const existing = await set(loadIntroVideoRenderJob$, input.requestId, signal);
  if (existing) {
    if (!isOwnedIntroVideoRender(existing, auth)) {
      return notFound();
    }
    if (existing.request.inputHash !== introVideoRenderHash(input)) {
      return conflict();
    }
  } else {
    if (!(await get(introVideoEnabled$))) {
      return introVideoDisabled;
    }
    const capabilities = await loadOrgPlanCapabilities(get(db$), auth.orgId);
    signal.throwIfAborted();
    if (capabilities?.videoGenerationAllowed !== true) {
      return {
        status: 402 as const,
        body: errorBody(
          "PRO_REQUIRED",
          "Cloud rendering requires Pro, Team, or Custom workspace access.",
        ),
      };
    }
    if (!renderStorageConfigured() || !(await get(introVideoRenderPricing$))) {
      return {
        status: 503 as const,
        body: errorBody(
          "RENDER_NOT_CONFIGURED",
          "Platform HeyGen rendering, private input storage, and cloud render pricing must be configured.",
        ),
      };
    }
    signal.throwIfAborted();
    if (
      !(await set(
        checkBillableOperationCredits$,
        { orgId: auth.orgId, userId: auth.userId, runId: auth.runId },
        signal,
      ))
    ) {
      return {
        status: 402 as const,
        body: errorBody(
          "INSUFFICIENT_CREDITS",
          "Insufficient credits. Please add credits to continue.",
        ),
      };
    }
    const prepared = await settle(
      set(
        prepareIntroVideoRenderProject$,
        {
          userId: auth.userId,
          orgId: auth.orgId,
          projectFileId: input.projectFileId,
          generationId: input.requestId,
          composition: input.composition,
          aspectRatio: input.output.aspectRatio,
        },
        signal,
      ),
      signal,
    );
    if (!prepared.ok) {
      if (prepared.error instanceof IntroVideoProjectError) {
        return {
          status: prepared.error.status,
          body: errorBody(prepared.error.code, prepared.error.message),
        };
      }
      throw prepared.error;
    }
    await set(
      createIntroVideoRenderJob$,
      {
        input,
        userId: auth.userId,
        orgId: auth.orgId,
        runId: auth.runId,
        project: prepared.value,
      },
      signal,
    );
  }
  const job = await set(loadIntroVideoRenderJob$, input.requestId, signal);
  if (!isOwnedIntroVideoRender(job, auth)) {
    return notFound();
  }
  if (job.request.inputHash !== introVideoRenderHash(input)) {
    return conflict();
  }
  await set(reconcileIntroVideoRender$, job.id, true, signal);
  const updated = await set(loadIntroVideoRenderJob$, job.id, signal);
  if (!updated) {
    throw new Error("Cloud render disappeared after submission");
  }
  return {
    status:
      updated.status === "completed" || updated.status === "failed"
        ? (200 as const)
        : (202 as const),
    body: serializeIntroVideoRender(updated),
  };
});

const getRender$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const { generationId } = get(params$);
  const job = await set(loadIntroVideoRenderJob$, generationId, signal);
  if (!isOwnedIntroVideoRender(job, auth)) {
    return notFound();
  }
  // Turning off new Intro Video creation must not strand an admitted render.
  await set(reconcileIntroVideoRender$, job.id, false, signal);
  const updated = await set(loadIntroVideoRenderJob$, job.id, signal);
  if (!updated) {
    return notFound();
  }
  return { status: 200 as const, body: serializeIntroVideoRender(updated) };
});

export const introVideoRenderRoutes: readonly RouteEntry[] = [
  {
    route: introVideoRenderContract.create,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      postRender$,
    ),
  },
  {
    route: introVideoRenderContract.get,
    handler: authRoute(
      {
        accept: ["agent"],
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      getRender$,
    ),
  },
];
