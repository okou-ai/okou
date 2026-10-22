import { command } from "ccstate";
import { builtInGenerationContract } from "@okouai/api-contracts/contracts/built-in-generation";

import { organizationAuthContext$ } from "../auth/auth-context";
import { authRoute } from "../auth/auth-route";
import { pathParamsOf } from "../context/request";
import { notFound } from "../../lib/error";
import type { RouteEntry } from "../route-entry";
import { getBuiltInGenerationJob$ } from "../services/built-in-generation.service";
import { reconcileOwnedOpenAiImageJob$ } from "../services/openai-image-generation.service";

const builtInGenerationNotFound = notFound("Built-in generation not found");

const generationPathParams$ = pathParamsOf(builtInGenerationContract.get);
const reconcilePathParams$ = pathParamsOf(builtInGenerationContract.reconcile);

const getBuiltInGenerationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(generationPathParams$);
    const job = await set(
      getBuiltInGenerationJob$,
      {
        generationId: params.generationId,
        orgId: auth.orgId,
        userId: auth.userId,
      },
      signal,
    );
    if (!job) {
      return builtInGenerationNotFound;
    }
    return { status: 200 as const, body: job };
  },
);

const reconcileBuiltInGenerationInner$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const params = get(reconcilePathParams$);
    const args = {
      generationId: params.generationId,
      orgId: auth.orgId,
      userId: auth.userId,
    };
    if (!(await set(reconcileOwnedOpenAiImageJob$, args, signal))) {
      return builtInGenerationNotFound;
    }
    const job = await set(getBuiltInGenerationJob$, args, signal);
    if (!job) {
      return builtInGenerationNotFound;
    }
    return { status: 200 as const, body: job };
  },
);

export const builtInGenerationRoutes: readonly RouteEntry[] = [
  {
    route: builtInGenerationContract.reconcile,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      reconcileBuiltInGenerationInner$,
    ),
  },
  {
    route: builtInGenerationContract.get,
    handler: authRoute(
      {
        requireOrganization: true,
        requiredCapability: "file:write",
      },
      getBuiltInGenerationInner$,
    ),
  },
];
