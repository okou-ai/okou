import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import { pathname$ } from "../route.ts";
import { command, computed, state } from "ccstate";
import {
  feishuConnectContract,
  larkConnectContract,
  type FeishuConnectStatus,
  type FeishuInstallationStatus,
} from "@okouai/api-contracts/contracts/feishu-connect";
import { toast } from "@okouai/ui/components/ui/sonner";

import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { i18n } from "../../i18n/index.ts";

export const feishuPlatform$ = computed((get): FeishuPlatform => {
  const path = get(pathname$);
  return path === FEISHU_PLATFORMS.lark.settingsPath ||
    path === FEISHU_PLATFORMS.lark.callbackPath
    ? "lark"
    : "feishu";
});

const reload$ = state(0);
const internalDialogOpen$ = state(false);
const internalDialogExisting$ = state(false);
const internalDialogInstallationId$ = state<string | null>(null);
const internalUninstallInstallationId$ = state<string | null>(null);
const internalSetupStep$ = state<FeishuSetupStep>("create");
const internalSetupForm$ = state<FeishuSetupInput>({
  appId: "",
  appSecret: "",
  verificationToken: "",
  encryptKey: "",
  defaultAgentId: "",
});
const FEISHU_SETUP_STEP_ORDER = [
  "create",
  "credentials",
  "tokens",
  "redirect",
  "permissions",
  "events",
  "publish",
] as const satisfies readonly FeishuSetupStep[];

export const feishuOrgData$ = computed(
  async (get): Promise<FeishuConnectStatus> => {
    get(reload$);
    const client = get(apiClient$)(
      get(feishuPlatform$) === "lark"
        ? larkConnectContract
        : feishuConnectContract,
    );
    const result = await accept(client.getStatus({}), [200]);
    return result.body;
  },
);

export interface FeishuBotInstallation extends Omit<
  FeishuInstallationStatus,
  "connectUrl" | "id" | "oauthRedirectUrl" | "setupCompleted"
> {
  readonly id: string | null;
  readonly connectUrl: string | null;
  readonly oauthRedirectUrl: string | null;
  readonly setupCompleted: boolean;
}

const internalInstallations$ = state<FeishuBotInstallation[] | null>(null);

export const feishuInstallations$ = computed(
  async (get): Promise<FeishuBotInstallation[]> => {
    const data = await get(feishuOrgData$);
    if (data.installations) {
      return data.installations.map((installation) => {
        return {
          ...installation,
          connectUrl: installation.connectUrl ?? null,
          oauthRedirectUrl: installation.oauthRedirectUrl ?? null,
          setupCompleted:
            installation.setupCompleted ?? installation.messageReceived,
        };
      });
    }
    if (
      !data.isInstalled ||
      !data.appId ||
      !data.callbackUrl ||
      !data.defaultAgentId
    ) {
      return [];
    }
    return [
      {
        id: data.installationId ?? null,
        publicBrand: data.publicBrand,
        isConnected: data.isConnected,
        connectedUserName: data.connectedUserName ?? null,
        appId: data.appId,
        callbackUrl: data.callbackUrl,
        connectUrl: data.connectUrl ?? null,
        oauthRedirectUrl: data.oauthRedirectUrl ?? null,
        callbackVerified: data.callbackVerified,
        setupCompleted: data.messageReceived,
        messageReceived: data.messageReceived,
        tenantKey: data.tenantKey,
        tenantName: data.tenantName,
        defaultAgentId: data.defaultAgentId,
        defaultAgentName: data.defaultAgentName,
      },
    ];
  },
);

export const disconnectFeishuOrg$ = command(
  async ({ get, set }, installationId: string | null, signal: AbortSignal) => {
    const client = get(apiClient$)(
      get(feishuPlatform$) === "lark"
        ? larkConnectContract
        : feishuConnectContract,
    );
    if (installationId) {
      await accept(
        client.disconnectInstallation({
          params: { installationId },
          fetchOptions: { signal },
        }),
        [200],
      );
    } else {
      await accept(
        client.disconnect({
          fetchOptions: { signal },
        }),
        [200],
      );
    }
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings[get(feishuPlatform$)].toasts
          .disconnected;
      }),
    );
  },
);

export interface FeishuSetupInput {
  readonly appId: string;
  readonly appSecret: string;
  readonly verificationToken: string;
  readonly encryptKey: string;
  readonly defaultAgentId: string;
}

export type FeishuSetupStep =
  | "create"
  | "credentials"
  | "tokens"
  | "redirect"
  | "permissions"
  | "events"
  | "publish";

export const feishuDialogOpen$ = computed((get) => {
  return get(internalDialogOpen$);
});

export const feishuSetupStep$ = computed((get) => {
  return get(internalSetupStep$);
});

export const feishuDialogExisting$ = computed((get) => {
  return get(internalDialogExisting$);
});

export const feishuDialogInstallationId$ = computed((get) => {
  return get(internalDialogInstallationId$);
});

export const feishuUninstallInstallationId$ = computed((get) => {
  return get(internalUninstallInstallationId$);
});

export const feishuSetupForm$ = computed((get) => {
  return get(internalSetupForm$);
});

export const openFeishuDialog$ = command(
  (
    { set },
    initial: Pick<FeishuSetupInput, "appId" | "defaultAgentId"> & {
      readonly step: FeishuSetupStep;
      readonly installationId?: string | null;
    },
  ) => {
    const { step, installationId, ...formDefaults } = initial;
    set(internalDialogExisting$, installationId !== undefined);
    set(internalDialogInstallationId$, installationId ?? null);
    set(internalSetupStep$, step);
    set(internalSetupForm$, {
      ...formDefaults,
      appSecret: "",
      verificationToken: "",
      encryptKey: "",
    });
    set(internalDialogOpen$, true);
  },
);

export const closeFeishuDialog$ = command(({ set }) => {
  set(internalDialogOpen$, false);
});

export const completeFeishuDialogClose$ = command(({ get, set }) => {
  if (get(internalDialogOpen$)) {
    return;
  }
  set(internalSetupForm$, (previous) => {
    return {
      ...previous,
      appSecret: "",
      verificationToken: "",
      encryptKey: "",
    };
  });
});

export const advanceFeishuSetupStep$ = command(({ set }) => {
  set(internalSetupStep$, (step) => {
    const index = FEISHU_SETUP_STEP_ORDER.indexOf(step);
    return FEISHU_SETUP_STEP_ORDER[index + 1] ?? step;
  });
});

export const goBackFeishuSetupStep$ = command(({ set }) => {
  set(internalSetupStep$, (step) => {
    const index = FEISHU_SETUP_STEP_ORDER.indexOf(step);
    return index > 0 ? (FEISHU_SETUP_STEP_ORDER[index - 1] ?? step) : step;
  });
});

export const updateFeishuSetupForm$ = command(
  ({ set }, update: Partial<FeishuSetupInput>) => {
    set(internalSetupForm$, (previous) => {
      return { ...previous, ...update };
    });
  },
);

export const setupFeishuOrg$ = command(
  async (
    { get, set },
    input: FeishuSetupInput & {
      readonly installationId?: string;
      readonly createNew?: boolean;
    },
    signal: AbortSignal,
  ): Promise<FeishuConnectStatus> => {
    const client = get(apiClient$)(
      get(feishuPlatform$) === "lark"
        ? larkConnectContract
        : feishuConnectContract,
    );
    const result = await accept(
      client.setup({
        body: input,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(internalDialogExisting$, true);
    set(
      internalDialogInstallationId$,
      result.body.installationId ?? input.installationId ?? null,
    );
    set(reload$, (value) => {
      return value + 1;
    });
    return result.body;
  },
);

export const checkFeishuAppIdAvailable$ = command(
  async ({ get }, appId: string, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(
      get(feishuPlatform$) === "lark"
        ? larkConnectContract
        : feishuConnectContract,
    );
    await accept(
      client.checkAppId({
        query: { appId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
  },
);

export const updateFeishuInstallationAgent$ = command(
  async (
    { get, set },
    installationId: string,
    defaultAgentId: string,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(
      get(feishuPlatform$) === "lark"
        ? larkConnectContract
        : feishuConnectContract,
    );
    await accept(
      client.updateInstallation({
        params: { installationId },
        body: { defaultAgentId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
  },
);

export const completeFeishuInstallationSetup$ = command(
  async (
    { get, set },
    installationId: string,
    defaultAgentId: string,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(
      get(feishuPlatform$) === "lark"
        ? larkConnectContract
        : feishuConnectContract,
    );
    const result = await accept(
      client.updateInstallation({
        params: { installationId },
        body: { defaultAgentId, setupCompleted: true },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings[get(feishuPlatform$)].toasts
          .botInstalled;
      }),
    );
    if (!result.body.isConnected && result.body.connectUrl) {
      const url = new URL(result.body.connectUrl);
      url.searchParams.set("callbackTarget", "app");
      window.location.assign(url.toString());
    }
  },
);

export const uninstallFeishuInstallation$ = command(
  async ({ get, set }, installationId: string, signal: AbortSignal) => {
    const client = get(apiClient$)(
      get(feishuPlatform$) === "lark"
        ? larkConnectContract
        : feishuConnectContract,
    );
    await accept(
      client.removeInstallation({
        params: { installationId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reload$, (value) => {
      return value + 1;
    });
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings[get(feishuPlatform$)].toasts
          .botUninstalled;
      }),
    );
  },
);

export const setFeishuUninstallInstallationId$ = command(
  ({ set }, installationId: string | null) => {
    set(internalUninstallInstallationId$, installationId);
  },
);

export const reloadFeishuInstallations$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

const onFeishuChanged$ = command(async ({ get, set }, signal: AbortSignal) => {
  const previous = get(internalInstallations$);
  set(reloadFeishuInstallations$);
  const next = await get(feishuInstallations$);
  signal.throwIfAborted();
  set(internalInstallations$, next);
  if (
    previous?.some((installation) => {
      return (
        !installation.isConnected &&
        next.some((candidate) => {
          return (
            (candidate.id ?? candidate.appId) ===
              (installation.id ?? installation.appId) && candidate.isConnected
          );
        })
      );
    })
  ) {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings[get(feishuPlatform$)].toasts
          .connected;
      }),
    );
  }
  return false;
});

export const showFeishuSettingsResult$ = command(({ get }) => {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("error");
  if (error) {
    toast.error(error);
  } else if (params.get("status") === "connected") {
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings[get(feishuPlatform$)].toasts
          .connected;
      }),
    );
  } else {
    return;
  }
  window.history.replaceState({}, "", window.location.pathname);
});

export const startFeishuSettingsRealtime$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const current = await get(feishuInstallations$);
    signal.throwIfAborted();
    set(internalInstallations$, current);

    set(
      setAblyLoop$,
      {
        topic: "feishu:changed",
        loopCommand$: onFeishuChanged$,
      },
      signal,
    );
  },
);

export const resetFeishuSettingsUi$ = command(({ set }) => {
  set(internalDialogOpen$, false);
  set(internalDialogExisting$, false);
  set(internalDialogInstallationId$, null);
  set(internalUninstallInstallationId$, null);
  set(internalInstallations$, null);
  set(internalSetupStep$, "create");
  set(internalSetupForm$, {
    appId: "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    defaultAgentId: "",
  });
});
