import { antigravityDeviceAuthContract } from "@okouai/api-contracts/client/antigravity-device-auth";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { toast } from "@okouai/ui/components/ui/sonner";
import { command, computed, state } from "ccstate";

import { i18n } from "../../../i18n/index.ts";
import { accept } from "../../../lib/accept.ts";
import { now } from "../../../lib/time.ts";
import { apiClient$ } from "../../api-client.ts";
import { featureSwitches$ } from "../../external/feature-switch.ts";
import { reloadPersonalModelProvider$ } from "../model-first-personal-oauth.ts";

/** Staff members who opted into the Antigravity pilot may connect accounts. */
export const antigravitySignInEnabled$ = computed(async (get) => {
  return (await get(featureSwitches$))[FeatureSwitchKey.GeminiAntigravity];
});

interface SignInDialog {
  readonly mode: "connect" | "reconnect";
  readonly modelProviderId: string | null;
}

interface SignInSession {
  readonly sessionToken: string;
  readonly browserUrl: string;
  readonly expiresAtMs: number;
}

const internalDialog$ = state<SignInDialog | null>(null);
const internalSession$ = state<SignInSession | null>(null);
const internalAddress$ = state("");
const internalError$ = state<string | null>(null);
const internalStart$ = state<Promise<void> | null>(null);

export const antigravitySignInDialog$ = computed((get) => {
  return get(internalDialog$);
});
export const antigravitySignInSession$ = computed((get) => {
  return get(internalSession$);
});
export const antigravitySignInAddress$ = computed((get) => {
  return get(internalAddress$);
});
export const antigravitySignInError$ = computed((get) => {
  return get(internalError$);
});
export const antigravitySignInStart$ = computed((get) => {
  return get(internalStart$);
});

const startSession$ = command(
  async ({ get, set }, dialog: SignInDialog, signal: AbortSignal) => {
    const client = get(apiClient$)(antigravityDeviceAuthContract, {
      apiBase: "api",
    });
    const started = await accept(
      client.start({
        body: {
          mode: dialog.mode === "reconnect" ? "reconnect" : "add",
          ...(dialog.modelProviderId
            ? { modelProviderId: dialog.modelProviderId }
            : {}),
        },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    // Closing or reopening the dialog supersedes this start.
    if (get(internalDialog$) !== dialog) {
      return;
    }
    set(internalSession$, {
      sessionToken: started.body.sessionToken,
      browserUrl: started.body.browserUrl,
      expiresAtMs: now() + started.body.expiresIn * 1000,
    });
  },
);

const beginSession$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<void> => {
    const dialog = get(internalDialog$);
    if (!dialog) {
      return;
    }
    set(internalSession$, null);
    set(internalAddress$, "");
    const started = set(startSession$, dialog, signal);
    set(internalStart$, started);
    await started;
  },
);

export const openAntigravitySignIn$ = command(
  async (
    { set },
    args:
      | { readonly mode: "connect" }
      | { readonly mode: "reconnect"; readonly modelProviderId: string },
    signal: AbortSignal,
  ) => {
    set(internalDialog$, {
      mode: args.mode,
      modelProviderId: args.mode === "reconnect" ? args.modelProviderId : null,
    });
    set(internalError$, null);
    await set(beginSession$, signal);
  },
);

/** Start a fresh sign-in after the previous one expired or failed. */
export const restartAntigravitySignIn$ = command(
  async ({ set }, signal: AbortSignal) => {
    set(internalError$, null);
    await set(beginSession$, signal);
  },
);

export const setAntigravitySignInAddress$ = command(
  ({ set }, address: string) => {
    set(internalAddress$, address);
    set(internalError$, null);
  },
);

const clearSignIn$ = command(({ set }) => {
  set(internalDialog$, null);
  set(internalSession$, null);
  set(internalAddress$, "");
  set(internalError$, null);
  set(internalStart$, null);
});

export const submitAntigravitySignIn$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const session = get(internalSession$);
    if (!session) {
      return;
    }
    if (session.expiresAtMs <= now()) {
      set(internalSession$, null);
      set(
        internalError$,
        i18n.t(($) => {
          return $.settings.models.deviceAuth.antigravity.expired;
        }),
      );
      return;
    }
    const address = get(internalAddress$).trim();
    if (!address) {
      set(
        internalError$,
        i18n.t(($) => {
          return $.settings.models.deviceAuth.antigravity.addressRequired;
        }),
      );
      return;
    }
    set(internalError$, null);
    const client = get(apiClient$)(antigravityDeviceAuthContract, {
      apiBase: "api",
    });
    const completed = await accept(
      client.complete({
        body: {
          sessionToken: session.sessionToken,
          authorizationCode: address,
        },
        fetchOptions: { signal },
      }),
      [200, 400, 503],
    );
    signal.throwIfAborted();
    if (get(internalSession$) !== session) {
      return;
    }
    if (completed.status === 400) {
      set(internalError$, completed.body.error.message);
      return;
    }
    if (completed.status === 503) {
      // The server ended this sign-in; the member starts a new one.
      set(internalSession$, null);
      set(internalError$, completed.body.error.message);
      return;
    }
    set(clearSignIn$);
    set(reloadPersonalModelProvider$);
    toast.success(
      i18n.t(($) => {
        return $.settings.models.deviceAuth.antigravity.connectedToast;
      }),
    );
  },
);

export const closeAntigravitySignIn$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const session = get(internalSession$);
    set(clearSignIn$);
    if (!session) {
      return;
    }
    const client = get(apiClient$)(antigravityDeviceAuthContract, {
      apiBase: "api",
    });
    await accept(
      client.cancel({
        body: { sessionToken: session.sessionToken },
        fetchOptions: { signal },
      }),
      [200, 400, 404],
    );
    signal.throwIfAborted();
  },
);
