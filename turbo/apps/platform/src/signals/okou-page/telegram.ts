import { command, computed, state } from "ccstate";
import { timeout } from "signal-timers";
import { toast } from "@okouai/ui/components/ui/sonner";
import {
  integrationsTelegramContract,
  type TelegramBot,
  type TelegramBotStatus,
  type TelegramSetupStatus,
} from "@okouai/api-contracts/contracts/integrations-telegram";
import { apiClient$ } from "../api-client.ts";
import { accept } from "../../lib/accept.ts";
import { setAblyLoop$ } from "../realtime.ts";
import { writeToClipboard } from "./clipboard.ts";
import { i18n } from "../../i18n/index.ts";
import { resetSignal } from "../utils.ts";

export type TelegramAddSetupStep = "token" | "domain" | "privacy" | "create";
export type TelegramSetupCheckTarget = "token" | "domain" | "privacy";

export interface TelegramAddSetupState {
  step: TelegramAddSetupStep;
  setupStatus: TelegramSetupStatus | null;
  domainConfirmed: boolean;
  privacyConfirmed: boolean;
  setupError: string | null;
}

const TELEGRAM_ADD_SETUP_STEP_ORDER = [
  "token",
  "domain",
  "privacy",
  "create",
] as const satisfies readonly TelegramAddSetupStep[];

const internalReload$ = state(0);
const internalTelegramAddDialogOpen$ = state(false);
const internalTelegramAddDialogSession$ = state(0);
const internalTelegramBotTokenForm$ = state("");
const internalTelegramBotAgentForm$ = state<string | null>(null);
const internalTelegramRegisteredBotId$ = state<string | null>(null);
const internalTelegramAddSetupState$ = state<TelegramAddSetupState>(
  initialTelegramAddSetupState(),
);
const internalTelegramCopiedValue$ = state<string | null>(null);
const resetTelegramCopySignal$ = resetSignal();
const internalTelegramFailedAvatarKeys$ = state<Record<string, boolean>>({});
const internalTelegramSavingBotId$ = state<string | null>(null);
const internalTelegramUnlinkingBotId$ = state<string | null>(null);
const internalTelegramUninstallingBotId$ = state<string | null>(null);
const internalTelegramUninstallDialogBotId$ = state<string | null>(null);
const internalTelegramReinstallDialogOpen$ = state(false);
const internalTelegramReinstallDialogBotId$ = state<string | null>(null);
const internalTelegramReinstallTokenForm$ = state("");
const internalTelegramReinstallingBotId$ = state<string | null>(null);

function initialTelegramAddSetupState(): TelegramAddSetupState {
  return {
    step: "token",
    setupStatus: null,
    domainConfirmed: false,
    privacyConfirmed: false,
    setupError: null,
  };
}

function getNextTelegramAddSetupStep(
  step: TelegramAddSetupStep,
): TelegramAddSetupStep {
  const index = TELEGRAM_ADD_SETUP_STEP_ORDER.indexOf(step);
  if (index === -1) {
    return step;
  }
  return TELEGRAM_ADD_SETUP_STEP_ORDER[index + 1] ?? step;
}

function getPreviousTelegramAddSetupStep(
  step: TelegramAddSetupStep,
): TelegramAddSetupStep {
  const index = TELEGRAM_ADD_SETUP_STEP_ORDER.indexOf(step);
  if (index < 1) {
    return step;
  }
  return TELEGRAM_ADD_SETUP_STEP_ORDER[index - 1] ?? step;
}

function isTelegramSetupCheckSatisfied(
  target: TelegramSetupCheckTarget,
  status: TelegramSetupStatus,
) {
  switch (target) {
    case "token": {
      return true;
    }
    case "domain": {
      return status.domainConfigured;
    }
    case "privacy": {
      return status.privacyDisabled;
    }
  }
}

function getTelegramSetupCheckFailureMessage(target: TelegramSetupCheckTarget) {
  if (target === "domain") {
    return i18n.t(($) => {
      return $.connectors.providerSettings.errors.telegramDomain;
    });
  }
  return i18n.t(($) => {
    return $.connectors.providerSettings.errors.telegramPrivacy;
  });
}

export const telegramBotTokenForm$ = computed((get) => {
  return get(internalTelegramBotTokenForm$);
});

export const telegramAddDialogOpen$ = computed((get) => {
  return get(internalTelegramAddDialogOpen$);
});

export const telegramAddDialogSession$ = computed((get) => {
  return get(internalTelegramAddDialogSession$);
});

export const telegramBotAgentForm$ = computed((get) => {
  return get(internalTelegramBotAgentForm$);
});

export const telegramAddSetupState$ = computed((get) => {
  return get(internalTelegramAddSetupState$);
});

export const telegramCopiedValue$ = computed((get) => {
  return get(internalTelegramCopiedValue$);
});

export const telegramFailedAvatarKeys$ = computed((get) => {
  return get(internalTelegramFailedAvatarKeys$);
});

export const telegramSavingBotId$ = computed((get) => {
  return get(internalTelegramSavingBotId$);
});

export const telegramUnlinkingBotId$ = computed((get) => {
  return get(internalTelegramUnlinkingBotId$);
});

export const telegramUninstallingBotId$ = computed((get) => {
  return get(internalTelegramUninstallingBotId$);
});

export const telegramUninstallDialogBotId$ = computed((get) => {
  return get(internalTelegramUninstallDialogBotId$);
});

export const telegramReinstallDialogBotId$ = computed((get) => {
  return get(internalTelegramReinstallDialogBotId$);
});

export const telegramReinstallDialogOpen$ = computed((get) => {
  return get(internalTelegramReinstallDialogOpen$);
});

export const telegramReinstallTokenForm$ = computed((get) => {
  return get(internalTelegramReinstallTokenForm$);
});

export const telegramReinstallingBotId$ = computed((get) => {
  return get(internalTelegramReinstallingBotId$);
});

export const setTelegramBotTokenForm$ = command(({ set }, value: string) => {
  set(internalTelegramBotTokenForm$, value);
  set(internalTelegramAddSetupState$, initialTelegramAddSetupState());
});

export const setTelegramAddDialogOpen$ = command(({ set }, open: boolean) => {
  if (open) {
    set(internalTelegramAddDialogSession$, (previous) => {
      return previous + 1;
    });
    set(internalTelegramBotTokenForm$, "");
    set(internalTelegramBotAgentForm$, null);
    set(internalTelegramRegisteredBotId$, null);
    set(internalTelegramAddSetupState$, initialTelegramAddSetupState());
  }
  set(internalTelegramAddDialogOpen$, open);
});

export const closeTelegramAddDialogAfterRegistration$ = command(
  ({ set }, botId: string) => {
    set(internalTelegramRegisteredBotId$, botId);
    set(internalTelegramAddDialogOpen$, false);
  },
);

export const completeTelegramAddDialogClose$ = command(({ get, set }) => {
  if (get(internalTelegramAddDialogOpen$)) {
    return null;
  }
  set(internalTelegramBotTokenForm$, "");
  const registeredBotId = get(internalTelegramRegisteredBotId$);
  set(internalTelegramRegisteredBotId$, null);
  return registeredBotId;
});

export const setTelegramBotAgentForm$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramBotAgentForm$, value);
  },
);

export const markTelegramAvatarFailed$ = command(
  ({ set }, avatarKey: string) => {
    set(internalTelegramFailedAvatarKeys$, (previous) => {
      return { ...previous, [avatarKey]: true };
    });
  },
);

export const copyTelegramValue$ = command(
  async ({ get, set }, value: string, signal: AbortSignal) => {
    const copied = await writeToClipboard(value);
    signal.throwIfAborted();
    if (!copied) {
      return;
    }

    const copySignal = set(resetTelegramCopySignal$, signal);
    set(internalTelegramCopiedValue$, value);
    const clearCopiedValue = () => {
      if (get(internalTelegramCopiedValue$) === value) {
        set(internalTelegramCopiedValue$, null);
      }
    };
    copySignal.addEventListener("abort", clearCopiedValue, { once: true });
    timeout(
      () => {
        copySignal.removeEventListener("abort", clearCopiedValue);
        clearCopiedValue();
      },
      1500,
      { signal: copySignal },
    );
  },
);

export const advanceTelegramAddSetupStep$ = command(({ set }) => {
  set(internalTelegramAddSetupState$, (previous) => {
    return {
      ...previous,
      step: getNextTelegramAddSetupStep(previous.step),
      setupError: null,
    };
  });
});

export const goBackTelegramAddSetupStep$ = command(({ set }) => {
  set(internalTelegramAddSetupState$, (previous) => {
    return {
      ...previous,
      step: getPreviousTelegramAddSetupStep(previous.step),
      setupError: null,
    };
  });
});

export const setTelegramSavingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramSavingBotId$, value);
  },
);

export const setTelegramUnlinkingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramUnlinkingBotId$, value);
  },
);

export const setTelegramUninstallingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramUninstallingBotId$, value);
  },
);

export const setTelegramUninstallDialogBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramUninstallDialogBotId$, value);
  },
);

export const setTelegramReinstallDialogBotId$ = command(
  ({ set }, value: string | null) => {
    if (value) {
      set(internalTelegramReinstallDialogBotId$, value);
      set(internalTelegramReinstallTokenForm$, "");
      set(internalTelegramReinstallDialogOpen$, true);
      return;
    }
    set(internalTelegramReinstallDialogOpen$, false);
  },
);

export const completeTelegramReinstallDialogClose$ = command(({ get, set }) => {
  if (get(internalTelegramReinstallDialogOpen$)) {
    return;
  }
  set(internalTelegramReinstallDialogBotId$, null);
  set(internalTelegramReinstallTokenForm$, "");
});

export const setTelegramReinstallTokenForm$ = command(
  ({ set }, value: string) => {
    set(internalTelegramReinstallTokenForm$, value);
  },
);

export const setTelegramReinstallingBotId$ = command(
  ({ set }, value: string | null) => {
    set(internalTelegramReinstallingBotId$, value);
  },
);

export const resetTelegramSettingsUi$ = command(({ set }) => {
  set(internalTelegramAddDialogOpen$, false);
  set(internalTelegramAddDialogSession$, 0);
  set(internalTelegramBotTokenForm$, "");
  set(internalTelegramBotAgentForm$, null);
  set(internalTelegramRegisteredBotId$, null);
  set(internalTelegramAddSetupState$, initialTelegramAddSetupState());
  set(internalTelegramSavingBotId$, null);
  set(internalTelegramUnlinkingBotId$, null);
  set(internalTelegramUninstallingBotId$, null);
  set(internalTelegramUninstallDialogBotId$, null);
  set(internalTelegramReinstallDialogOpen$, false);
  set(internalTelegramReinstallDialogBotId$, null);
  set(internalTelegramReinstallTokenForm$, "");
  set(internalTelegramReinstallingBotId$, null);
});

export const telegramBots$ = computed(async (get): Promise<TelegramBot[]> => {
  get(internalReload$);
  const client = get(apiClient$)(integrationsTelegramContract);
  const result = await accept(client.list({ headers: {} }), [200]);
  return result.body.bots;
});

export const reloadTelegramBots$ = command(({ set }) => {
  set(internalReload$, (prev) => {
    return prev + 1;
  });
});

const onTelegramChanged$ = command(({ set }) => {
  set(reloadTelegramBots$);
  return false;
});

export const startTelegramSettingsRealtime$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyLoop$,
      {
        topic: "telegram:changed",
        loopCommand$: onTelegramChanged$,
      },
      signal,
    );
  },
);

export const registerTelegramBot$ = command(
  async (
    { get, set },
    input: { botToken: string; defaultAgentId?: string },
    signal: AbortSignal,
  ): Promise<TelegramBotStatus> => {
    const client = get(apiClient$)(integrationsTelegramContract);
    const result = await accept(
      client.register({
        headers: {},
        body: input,
        fetchOptions: { signal },
      }),
      [201],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramBotAdded;
      }),
    );
    return (result as { body: TelegramBotStatus }).body;
  },
);

const checkTelegramBotSetupStatus$ = command(
  async (
    { get },
    input: { botToken: string; origin?: string },
    signal: AbortSignal,
  ): Promise<TelegramSetupStatus> => {
    const client = get(apiClient$)(integrationsTelegramContract);
    const result = await accept(
      client.setupStatus({
        headers: {},
        body: input,
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    return (result as { body: TelegramSetupStatus }).body;
  },
);

export const checkTelegramAddSetupStatus$ = command(
  async (
    { get, set },
    target: TelegramSetupCheckTarget,
    origin: string | undefined,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const botToken = get(internalTelegramBotTokenForm$).trim();
    if (!botToken) {
      return false;
    }

    set(internalTelegramAddSetupState$, (previous) => {
      return { ...previous, setupError: null };
    });

    const status = await set(
      checkTelegramBotSetupStatus$,
      { botToken, origin },
      signal,
    );
    signal.throwIfAborted();
    if (get(internalTelegramBotTokenForm$).trim() !== botToken) {
      return false;
    }

    const satisfied = isTelegramSetupCheckSatisfied(target, status);
    set(internalTelegramAddSetupState$, (previous) => {
      return {
        ...previous,
        setupStatus: status,
        domainConfirmed: previous.domainConfirmed || status.domainConfigured,
        privacyConfirmed: previous.privacyConfirmed || status.privacyDisabled,
        setupError: satisfied
          ? null
          : getTelegramSetupCheckFailureMessage(target),
      };
    });
    return satisfied;
  },
);

export const reinstallTelegramBot$ = command(
  async (
    { get, set },
    input: { botId: string; botToken: string },
    signal: AbortSignal,
  ): Promise<TelegramBotStatus> => {
    const client = get(apiClient$)(integrationsTelegramContract);
    const result = await accept(
      client.register({
        headers: {},
        body: { botToken: input.botToken, reinstallBotId: input.botId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramBotReinstalled;
      }),
    );
    return (result as { body: TelegramBotStatus }).body;
  },
);

export const updateTelegramBotAgent$ = command(
  async (
    { get, set },
    input:
      | { botId: string; defaultAgentId: string }
      | { botId: string; selectedAgentId: string | null },
    signal: AbortSignal,
  ): Promise<TelegramBotStatus> => {
    const toastId = toast.loading(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramUpdatingAgent;
      }),
    );
    signal.addEventListener("abort", () => {
      return toast.dismiss(toastId);
    });
    const client = get(apiClient$)(integrationsTelegramContract);
    const result = await accept(
      client.updateBot({
        headers: {},
        params: { botId: input.botId },
        body:
          "selectedAgentId" in input
            ? { selectedAgentId: input.selectedAgentId }
            : { defaultAgentId: input.defaultAgentId },
        fetchOptions: { signal },
      }),
      [200],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramAgentUpdated;
      }),
      { id: toastId },
    );
    return result.body;
  },
);

export const disconnectTelegramAccount$ = command(
  async ({ get, set }, botId: string, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(integrationsTelegramContract);
    await accept(
      client.unlink({
        headers: {},
        query: { botId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramDisconnected;
      }),
    );
  },
);

export const uninstallTelegramBot$ = command(
  async ({ get, set }, botId: string, signal: AbortSignal): Promise<void> => {
    const client = get(apiClient$)(integrationsTelegramContract);
    await accept(
      client.disconnect({
        headers: {},
        params: { botId },
        fetchOptions: { signal },
      }),
      [204],
    );
    signal.throwIfAborted();
    set(reloadTelegramBots$);
    toast.success(
      i18n.t(($) => {
        return $.connectors.providerSettings.toasts.telegramBotUninstalled;
      }),
    );
  },
);
