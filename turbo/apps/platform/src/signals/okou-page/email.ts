import { command, computed, state } from "ccstate";
import { emailConnectBodySchema } from "@okouai/api-contracts/validators/integrations-email";
import { integrationsEmailContract } from "@okouai/api-contracts/client/integrations-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { i18n } from "../../i18n/index.ts";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { searchParams$ } from "../route.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRef } from "../utils.ts";

const reload$ = state(0);
const internalDialogOpen$ = state(false);
const internalCodeRequest$ = state<Promise<{
  readonly code: string;
  readonly expiresAt: string;
}> | null>(null);
const internalTrigger$ = state<HTMLButtonElement | null>(null);
export const emailConnectionTriggerRef$ = onRef(
  command(({ set }, element: HTMLButtonElement, signal: AbortSignal) => {
    set(internalTrigger$, element);
    signal.addEventListener(
      "abort",
      () => {
        set(internalTrigger$, null);
      },
      { once: true },
    );
  }),
);
export const emailConnectionFinalFocus$ = command(({ get }) => {
  return get(internalTrigger$);
});
export const emailConnectionCode$ = computed(async (get) => {
  return await get(internalCodeRequest$);
});
const requestEmailConnectionCode$ = command(
  async ({ get }, signal: AbortSignal) => {
    const response = await accept(
      get(apiClient$)(integrationsEmailContract).createLinkCode({
        headers: {},
        fetchOptions: { signal },
      }),
      [200],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    return response.body;
  },
);
export const createEmailConnectionCode$ = command(
  ({ set }, signal: AbortSignal) => {
    const request = set(requestEmailConnectionCode$, signal);
    set(internalCodeRequest$, request);
    return request;
  },
);
export const emailConnectDialogOpen$ = computed((get) => {
  return get(internalDialogOpen$);
});
export const setEmailConnectDialogOpen$ = command(({ set }, open: boolean) => {
  if (open) {
    set(internalCodeRequest$, null);
  }
  set(internalDialogOpen$, open);
});
export const addEmailConnection$ = command(({ set }, signal: AbortSignal) => {
  set(setEmailConnectDialogOpen$, true);
  return set(createEmailConnectionCode$, signal);
});
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
  toast.success(
    i18n.t(($) => {
      return $.works.email.connected;
    }),
    { description: response.body.emailAddress },
  );
  return response.body;
});
export const connectEmailFromLink$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (
      !get(featureSwitch$)[FeatureSwitchKey.EmailIntegration] ||
      !get(emailConnectParams$)?.success
    ) {
      return;
    }
    const request = set(connectOriginalEmail$, signal);
    set(connectionRequest$, request);
    return request;
  },
);

export const deleteEmailConnection$ = command(
  async ({ get, set }, emailAddress: string, signal: AbortSignal) => {
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
    set(reloadEmailLinkStatus$);
  },
);
const reloadEmailLinkStatus$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});
const refreshEmailFromChange$ = command(({ set }) => {
  set(reloadEmailLinkStatus$);
  return false;
});
export const watchEmailConnection$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.EmailIntegration]) {
      return;
    }
    set(
      setAblyLoop$,
      {
        topic: "email:changed",
        loopCommand$: refreshEmailFromChange$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
    set(
      setAblyLoop$,
      {
        topic: "connector:changed",
        loopCommand$: refreshEmailFromChange$,
        options: { runOnSubscribe: false },
      },
      signal,
    );
  },
);
