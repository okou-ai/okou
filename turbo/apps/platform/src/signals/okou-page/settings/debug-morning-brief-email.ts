import {
  debugMorningBriefEmailContract,
  type DebugMorningBriefEmailResponse,
} from "@okouai/api-contracts/contracts/debug-morning-brief-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "../../external/feature-switch.ts";
import { command, computed, state } from "ccstate";
import { accept } from "../../../lib/accept.ts";
import { apiClient$ } from "../../api-client.ts";
import { authenticatedIdentity$ } from "../../auth.ts";

interface TestEmail {
  readonly userId: string;
  readonly orgId: string;
  readonly requestId: string;
  readonly response: DebugMorningBriefEmailResponse | null;
}
const request$ = state<TestEmail | null>(null);
export const debugMorningBriefEmailEnabled$ = computed(async (get) => {
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
export const debugMorningBriefEmailResponse$ = computed(async (get) => {
  return (await get(currentRequest$))?.response ?? null;
});

export const sendDebugMorningBriefEmail$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const owner = await get(authenticatedIdentity$);
    signal.throwIfAborted();
    const existing = get(request$);
    const owned =
      existing?.userId === owner.userId && existing.orgId === owner.orgId;
    // A lost HTTP response retries the same intent. A terminal receipt permits
    // the next deliberate click to request a new sample.
    const request =
      existing &&
      owned &&
      (!existing.response || existing.response.status === "queued")
        ? existing
        : {
            userId: owner.userId,
            orgId: owner.orgId,
            requestId: crypto.randomUUID(),
            response: null,
          };
    set(request$, request);
    const result = await accept(
      get(apiClient$)(debugMorningBriefEmailContract).send({
        body: { requestId: request.requestId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    set(request$, { ...request, response: result.body });
  },
);

export const refreshDebugMorningBriefEmail$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const request = await get(currentRequest$);
    signal.throwIfAborted();
    if (!request) {
      return;
    }
    const result = await accept(
      get(apiClient$)(debugMorningBriefEmailContract).get({
        params: { id: request.requestId },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    set(request$, { ...request, response: result.body });
  },
);
