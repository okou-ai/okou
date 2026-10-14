import {
  debugMorningBriefContract,
  type DebugMorningBriefResponse,
} from "@okouai/api-contracts/contracts/debug-morning-brief";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { command, computed, state } from "ccstate";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { authenticatedIdentity$ } from "../../auth.ts";

interface BriefRequest {
  readonly userId: string;
  readonly orgId: string;
  readonly requestId: string;
  readonly response: DebugMorningBriefResponse | null;
}
const request$ = state<BriefRequest | null>(null);
export const debugMorningBriefEnabled$ = computed(async (get) => {
  const features = await get(featureSwitch$);
  return features[FeatureSwitchKey.OkouDebug];
});
const currentRequest$ = computed(async (get) => {
  const request = get(request$);
  const owner = await get(authenticatedIdentity$);
  return request?.userId === owner?.userId && request?.orgId === owner?.orgId
    ? request
    : null;
});
export const debugMorningBriefResponse$ = computed(async (get) => {
  return (await get(currentRequest$))?.response ?? null;
});

export const runDebugMorningBrief$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const owner = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const existing = get(request$);
    const owned =
      existing?.userId === owner.userId && existing.orgId === owner.orgId;
    // A lost HTTP response retries the same intent. A terminal receipt permits
    // the next deliberate click to request a new run.
    const request =
      existing &&
      owned &&
      (!existing.response ||
        existing.response.status === "queued" ||
        existing.response.status === "running")
        ? existing
        : {
            userId: owner.userId,
            orgId: owner.orgId,
            requestId: crypto.randomUUID(),
            response: null,
          };
    set(request$, request);
    const result = await accept(
      get(apiClient$)(debugMorningBriefContract).run({
        body: { requestId: request.requestId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    set(request$, { ...request, response: result.body });
  },
);

export const refreshDebugMorningBrief$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = await get(currentRequest$);
    signal.throwIfAborted();
    if (!request) {
      return;
    }
    const result = await accept(
      get(apiClient$)(debugMorningBriefContract).get({
        params: { id: request.requestId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    set(request$, { ...request, response: result.body });
  },
);
