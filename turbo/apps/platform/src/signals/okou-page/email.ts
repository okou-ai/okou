import { command, computed, state, type Computed } from "ccstate";
import { emailConnectBodySchema } from "@okouai/api-contracts/validators/integrations-email";
import { integrationsEmailContract } from "@okouai/api-contracts/client/integrations-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { searchParams$ } from "../route.ts";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRef } from "../utils.ts";

const reload$ = state(0);
const connectionRequest$ = state<Promise<{
  readonly emailAddress: string;
}> | null>(null);
export const emailConnection$ = computed(async (get) => {
  return await get(connectionRequest$);
});
export const resetEmailConnection$ = command(({ set }) => {
  set(connectionRequest$, null);
});
export const emailLinkStatus$ = computed(async (get) => {
  get(reload$);
  return (
    await accept(
      get(apiClient$)(integrationsEmailContract).getLinkStatus({ headers: {} }),
      [200],
      undefined,
      { showErrorToast: false },
    )
  ).body;
});
export const emailConnectParams$ = computed((get) => {
  const params = get(searchParams$);
  if (
    !params.has("message") &&
    !params.has("signature") &&
    !params.has("expires")
  ) {
    return null;
  }
  return emailConnectBodySchema.safeParse({
    messageId: params.get("message"),
    expires: Number(params.get("expires")),
    signature: params.get("signature"),
  });
});
const connectOriginalEmail$ = command(async ({ get }, signal: AbortSignal) => {
  const params = get(emailConnectParams$);
  if (!params?.success) {
    throw new Error("Invalid email connection link");
  }
  const response = await accept(
    get(apiClient$)(integrationsEmailContract).connect({
      headers: {},
      body: params.data,
      fetchOptions: { signal },
    }),
    [200],
    signal,
    { showErrorToast: false },
  );
  signal.throwIfAborted();
  return response.body;
});
const connectEmailFromLink$ = command(({ get, set }, signal: AbortSignal) => {
  if (
    !get(featureSwitch$)[FeatureSwitchKey.EmailIntegration] ||
    !get(emailConnectParams$)?.success
  ) {
    return;
  }
  const request = set(connectOriginalEmail$, signal);
  set(connectionRequest$, request);
  return request;
});

export const connectEmailOnRef$ = onRef(
  command(async ({ set }, _element: HTMLElement, signal: AbortSignal) => {
    await set(connectEmailFromLink$, signal);
  }),
);
export const disconnectEmail$ = command(
  async ({ get }, emailAddress: string, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(integrationsEmailContract).unlink({
        headers: {},
        body: { emailAddress },
        fetchOptions: { signal },
      }),
      [204],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
  },
);
export const connectVerifiedEmail$ = command(
  async ({ get }, emailAddress: string, signal: AbortSignal) => {
    await accept(
      get(apiClient$)(integrationsEmailContract).connectAddress({
        headers: {},
        body: { emailAddress },
        fetchOptions: { signal },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
  },
);
const reloadEmailLinkStatus$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});
export const watchEmailConnection$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.EmailIntegration]) {
      return;
    }
    set(
      setAblyInvalidationLoop$,
      {
        topic: "email:changed",
        invalidations: [reloadEmailLinkStatus$],
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

export type EmailLinkStatus =
  typeof emailLinkStatus$ extends Computed<Promise<infer Value>>
    ? Value
    : never;
