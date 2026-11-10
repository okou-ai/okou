import { command, computed, state } from "ccstate";
import { emailConnectBodySchema } from "@okouai/api-contracts/validators/integrations-email";
import { integrationsEmailContract } from "@okouai/api-contracts/client/integrations-email";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { searchParams$ } from "../route.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { onRef } from "../utils.ts";

const reload$ = state(0);
const internalEmails$ = state<readonly string[] | null>(null);
const internalDialogMode$ = state<"connect" | "manage" | null>(null);
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
export const emailConnectionDialogMode$ = computed((get) => {
  return get(internalDialogMode$);
});
export const openEmailManageDialog$ = command(({ set }) => {
  set(internalDialogMode$, "manage");
});
export const createEmailConnectionCode$ = command(
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
export const emailConnectDialogOpen$ = computed((get) => {
  return get(internalDialogMode$) !== null;
});
export const setEmailConnectDialogOpen$ = command(({ set }, open: boolean) => {
  set(internalDialogMode$, open ? "connect" : null);
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

export const disconnectEmail$ = command(
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
export const connectVerifiedEmail$ = command(
  async ({ get, set }, emailAddress: string, signal: AbortSignal) => {
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
    set(reloadEmailLinkStatus$);
    if (get(internalDialogMode$) === "connect") {
      set(setEmailConnectDialogOpen$, false);
    }
  },
);
const reloadEmailLinkStatus$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});
const refreshEmailFromChange$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const previous = get(internalEmails$);
    set(reloadEmailLinkStatus$);
    const status = await get(emailLinkStatus$);
    signal.throwIfAborted();
    set(internalEmails$, status.emails);
    if (
      get(internalDialogMode$) === "connect" &&
      status.emails.some((email) => {
        return !(previous ?? []).includes(email);
      })
    ) {
      set(setEmailConnectDialogOpen$, false);
    }
    return false;
  },
);
export const watchEmailConnection$ = command(
  ({ get, set }, signal: AbortSignal) => {
    if (!get(featureSwitch$)[FeatureSwitchKey.EmailIntegration]) {
      return;
    }
    set(internalEmails$, null);
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
