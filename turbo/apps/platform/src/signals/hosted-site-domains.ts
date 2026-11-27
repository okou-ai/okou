import { writeToClipboard } from "./okou-page/clipboard.ts";
import { i18n } from "../i18n/index.ts";
import { command, computed, state, type Computed } from "ccstate";
import type { infer as zInfer } from "zod";
import { hostContract } from "@okouai/api-contracts/client/host";
import type { hostedSiteUrlSchema } from "@okouai/api-contracts/contracts/host";
import type { hostedDomainSettingsSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../lib/accept.ts";
import { apiClient$, type ApiClientFactory } from "./api-client.ts";
import { featureSwitches$ } from "./external/feature-switch.ts";
import { openSettingsBillingPlansDialog$ } from "./okou-page/settings/settings-dialog.ts";
import { onRef, resetSignal } from "./utils.ts";
import { delay } from "signal-timers";
import { now } from "../lib/time.ts";
import { setAblyLoop$ } from "./realtime.ts";

type Settings = zInfer<typeof hostedDomainSettingsSchema>;
type SiteSignal = Computed<Promise<zInfer<typeof hostedSiteUrlSchema> | null>>;
function createDomainState(site$: SiteSignal) {
  const request$ = state<
    | ((
        createClient: ApiClientFactory,
        siteId: string,
        readSignal?: AbortSignal,
      ) => Promise<Settings | null>)
    | null
  >(null);
  const initialize$ = command(({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(request$, () => {
      return async (
        createClient: ApiClientFactory,
        siteId: string,
        readSignal = signal,
      ) => {
        signal.throwIfAborted();
        const result = await accept(
          createClient(hostContract).siteDomains({
            params: { siteId },
            fetchOptions: { cache: "no-store", signal: readSignal },
          }),
          [200, 403, 404],
          readSignal,
        );
        return result.status === 200 ? result.body : null;
      };
    });
  });
  const saved$ = state<Settings | null>(null);
  const open$ = state(false);
  const addressMode$ = state<"platform" | "custom">("platform");
  const selectedDomainId$ = state<string | null>(null);
  const managedDomainId$ = state<string | null>(null);
  const hostname$ = state("");
  const notice$ = state<string | null>(null);
  const removalConfirmation$ = state(false);
  const resetVerificationSignal$ = resetSignal();
  const settings$ = computed(async (get) => {
    const request = get(request$);
    if (!request) {
      return null;
    }
    const site = await get(site$);
    if (
      !(await get(featureSwitches$))[
        FeatureSwitchKey.HostedSiteCustomDomains
      ] &&
      !site?.effectiveUrl
    ) {
      return null;
    }
    if (!site?.isActive) {
      return null;
    }
    const saved = get(saved$);
    if (saved) {
      return saved;
    }
    return await request(get(apiClient$), site.siteId);
  });
  const setup$ = computed(async (get) => {
    const settings = await get(settings$);
    if (!get(open$) || !get(managedDomainId$) || !settings?.allowed) {
      return null;
    }
    const domain = settings.domains.find((item) => {
      return item.id === get(managedDomainId$);
    });
    if (!domain || domain.removing) {
      return null;
    }
    const response = await accept(
      get(apiClient$)(hostContract).siteDomainSetup({
        params: { siteId: settings.siteId, domainId: domain.id },
        fetchOptions: { cache: "no-store" },
      }),
      [200, 402, 404],
    );
    return response.status === 200 ? response.body : null;
  });
  const effectiveUrl$ = computed((get) => {
    return get(saved$)?.effectiveUrl ?? null;
  });
  return {
    initialize$,
    request$,
    saved$,
    open$,
    addressMode$,
    selectedDomainId$,
    managedDomainId$,
    hostname$,
    notice$,
    removalConfirmation$,
    resetVerificationSignal$,
    settings$,
    setup$,
    effectiveUrl$,
  };
}
type DomainState = ReturnType<typeof createDomainState>;
function createDomainUpdates(scope: DomainState, site$: SiteSignal) {
  const { request$, saved$, managedDomainId$, settings$ } = scope;
  const expiredAttempt$ = state<string | null>(null);
  const mountDeadline$ = onRef(
    command(async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
      const settings = await get(settings$);
      signal.throwIfAborted();
      const automatic = settings?.domains.find((domain) => {
        return domain.id === get(managedDomainId$);
      })?.verification?.automatic;
      if (automatic?.status === "checking") {
        await delay(Math.max(0, Date.parse(automatic.expiresAt) - now()), {
          signal,
        });
        signal.throwIfAborted();
        set(expiredAttempt$, automatic.id);
      }
    }),
  );
  const refresh$ = command(async ({ get, set }, signal: AbortSignal) => {
    const previous = get(saved$);
    const request = get(request$);
    const site = await get(site$);
    signal.throwIfAborted();
    if (request && site?.isActive) {
      const fresh = await request(get(apiClient$), site.siteId, signal);
      signal.throwIfAborted();
      // An in-flight baseline must not overwrite a newer mutation response.
      if (previous === get(saved$)) {
        set(saved$, fresh);
      }
    }
    return false;
  });
  const mountCustomTab$ = onRef(
    command(async ({ get, set }, _el: HTMLElement, signal: AbortSignal) => {
      const site = await get(site$);
      signal.throwIfAborted();
      if (!site?.isActive) {
        return;
      }
      // Read on entry even when realtime is offline. Subscribe with catch-up to
      // cover the interval between the baseline and attachment, and reconnects.
      await set(refresh$, signal);
      signal.throwIfAborted();
      set(
        setAblyLoop$,
        {
          topic: `hostedSiteDomainsChanged:${site.siteId}`,
          loopCommand$: refresh$,
          options: { runOnSubscribe: true },
        },
        signal,
      );
    }),
  );
  return { mountCustomTab$, mountDeadline$, expiredAttempt$ };
}
type DomainAction = "create" | "verify" | "remove";
function createDomainNavigation(scope: DomainState) {
  const {
    open$,
    addressMode$,
    selectedDomainId$,
    managedDomainId$,
    hostname$,
    notice$,
    removalConfirmation$,
    settings$,
  } = scope;
  const begin$ = command(async ({ get, set }, signal: AbortSignal) => {
    set(scope.resetVerificationSignal$);
    const settings = await get(settings$);
    signal.throwIfAborted();
    set(open$, false);
    set(notice$, null);
    const selected =
      settings?.allowed &&
      settings.domains.some((domain) => {
        return domain.id === settings.selectedDomainId && domain.ready;
      })
        ? settings.selectedDomainId
        : null;
    set(selectedDomainId$, selected);
    set(addressMode$, selected ? "custom" : "platform");
  });
  const show$ = command(async ({ get, set }, signal: AbortSignal) => {
    set(scope.resetVerificationSignal$);
    const settings = await get(settings$);
    signal.throwIfAborted();
    if (!settings?.allowed) {
      await set(openSettingsBillingPlansDialog$, signal);
      signal.throwIfAborted();
      return;
    }
    set(managedDomainId$, null);
    set(hostname$, "");
    set(notice$, null);
    set(open$, true);
  });
  const back$ = command(({ set }) => {
    set(scope.resetVerificationSignal$);
    set(open$, false);
    set(notice$, null);
  });
  const choose$ = command(({ set }, id: string | null) => {
    set(selectedDomainId$, id);
    set(notice$, null);
  });
  const changeMode$ = command(
    async ({ get, set }, mode: "platform" | "custom", signal: AbortSignal) => {
      set(scope.resetVerificationSignal$);
      const settings = await get(settings$);
      signal.throwIfAborted();
      set(addressMode$, mode);
      set(open$, false);
      set(notice$, null);
      if (mode === "platform") {
        set(selectedDomainId$, null);
        return;
      }
      if (!settings?.allowed) {
        set(selectedDomainId$, null);
        return;
      }
      const selected = settings?.domains.find((domain) => {
        return domain.id === get(selectedDomainId$) && domain.ready;
      });
      set(selectedDomainId$, selected?.id ?? null);
      if (settings?.allowed && settings.domains.length === 0) {
        set(managedDomainId$, null);
        set(hostname$, "");
        set(open$, true);
      }
    },
  );
  const manage$ = command(({ set }, id: string | null) => {
    set(scope.resetVerificationSignal$);
    set(managedDomainId$, id);
    set(notice$, null);
    set(open$, true);
  });
  const requestRemoval$ = command(({ set }, id: string) => {
    set(scope.resetVerificationSignal$);
    set(managedDomainId$, id);
    set(removalConfirmation$, true);
    set(notice$, null);
  });
  const editHostname$ = command(({ set }, value: string) => {
    set(hostname$, value);
    set(notice$, null);
  });
  const confirmRemoval$ = command(({ set }, open: boolean) => {
    return set(removalConfirmation$, open);
  });
  const copy$ = command(async ({ set }, value: string, signal: AbortSignal) => {
    const copied = await writeToClipboard(value);
    signal.throwIfAborted();
    const message = copied
      ? null
      : i18n.t(($) => {
          return $.artifacts.customDomain.copyFailed;
        });
    set(notice$, message);
    return copied;
  });
  return {
    begin$,
    show$,
    changeMode$,
    back$,
    choose$,
    manage$,
    requestRemoval$,
    editHostname$,
    confirmRemoval$,
    copy$,
  };
}
const requestDomainChange$ = command(
  (
    { get },
    args: {
      readonly settings: Settings;
      readonly domain: Settings["domains"][number] | undefined;
      readonly action: DomainAction;
      readonly hostname: string;
    },
    signal: AbortSignal,
  ) => {
    const { settings, domain, action, hostname } = args;
    const api = get(apiClient$)(hostContract);
    const params = { siteId: settings.siteId, domainId: domain?.id ?? "" };
    const body = { expectedRevision: domain?.revision ?? "" };
    return accept(
      action === "create"
        ? api.addSiteDomain({
            params: { siteId: settings.siteId },
            body: { hostname },
            fetchOptions: { signal },
          })
        : action === "verify"
          ? api.verifySiteDomain({ params, body, fetchOptions: { signal } })
          : api.removeSiteDomain({ params, body, fetchOptions: { signal } }),
      [200, 400, 402, 409, 503],
      signal,
    );
  },
);
const applyDomainSettings$ = command(
  (
    { get, set },
    args: {
      readonly scope: DomainState;
      readonly settings: Settings;
      readonly action: DomainAction;
      readonly domainId?: string;
    },
  ) => {
    const { scope, settings, action, domainId } = args;
    const {
      saved$,
      selectedDomainId$,
      notice$,
      managedDomainId$,
      hostname$,
      open$,
    } = scope;
    set(saved$, settings);
    if (
      get(selectedDomainId$) &&
      !settings.domains.some((domain) => {
        return domain.id === get(selectedDomainId$) && domain.ready;
      })
    ) {
      set(selectedDomainId$, null);
    }
    set(notice$, null);
    if (action === "create") {
      set(
        managedDomainId$,
        settings.domains.find((item) => {
          return (
            item.hostname ===
            new URL(`https://${get(hostname$).trim()}`).hostname
              .toLowerCase()
              .replace(/\.$/u, "")
          );
        })?.id ?? null,
      );
    }
    if (action === "remove") {
      set(managedDomainId$, null);
      set(open$, false);
      if (get(selectedDomainId$) === domainId) {
        set(selectedDomainId$, null);
      }
    }
  },
);
const handleDomainFailure$ = command(
  async (
    { get, set },
    args: {
      readonly scope: DomainState;
      readonly settings: Settings;
      readonly action: DomainAction;
      readonly domainId?: string;
      readonly response: {
        readonly status: number;
        readonly body: { readonly error: { readonly message: string } };
      };
    },
    signal: AbortSignal,
  ) => {
    const { scope, settings, action, domainId, response } = args;
    const { saved$, selectedDomainId$, notice$ } = scope;
    if (action === "remove" && response.status === 503) {
      const current = await accept(
        get(apiClient$)(hostContract).siteDomains({
          params: { siteId: settings.siteId },
          fetchOptions: { signal, cache: "no-store" },
        }),
        [200],
        signal,
      );
      signal.throwIfAborted();
      set(saved$, current.body);
      if (get(selectedDomainId$) === domainId) {
        set(selectedDomainId$, null);
      }
    }
    if (response.status === 402) {
      await set(openSettingsBillingPlansDialog$, signal);
      signal.throwIfAborted();
    } else {
      set(notice$, response.body.error.message);
    }
  },
);
function createDomainMutations(scope: DomainState) {
  const { settings$, managedDomainId$, hostname$, removalConfirmation$ } =
    scope;
  const mutate$ = command(
    async ({ get, set }, action: DomainAction, signal: AbortSignal) => {
      const settings = await get(settings$);
      signal.throwIfAborted();
      if (!settings) {
        return;
      }
      if (action !== "remove" && !settings.allowed) {
        await set(openSettingsBillingPlansDialog$, signal);
        signal.throwIfAborted();
        return;
      }
      const domain = settings.domains.find((item) => {
        return item.id === get(managedDomainId$);
      });
      if (action !== "create" && !domain) {
        return;
      }
      const response = await set(
        requestDomainChange$,
        { settings, domain, action, hostname: get(hostname$) },
        signal,
      );
      signal.throwIfAborted();
      if (response.status !== 200) {
        await set(
          handleDomainFailure$,
          { scope, settings, action, domainId: domain?.id, response },
          signal,
        );
        signal.throwIfAborted();
        return;
      }
      set(applyDomainSettings$, {
        scope,
        settings: response.body,
        action,
        domainId: domain?.id,
      });
    },
  );
  const create$ = command(({ set }, signal: AbortSignal) => {
    return set(mutate$, "create", signal);
  });
  const verify$ = command(async ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const verificationSignal = set(scope.resetVerificationSignal$, signal);
    set(scope.notice$, null);
    await set(mutate$, "verify", verificationSignal);
    signal.throwIfAborted();
    verificationSignal.throwIfAborted();
  });
  const remove$ = command(async ({ set }, signal: AbortSignal) => {
    await set(mutate$, "remove", signal);
    signal.throwIfAborted();
    set(removalConfirmation$, false);
  });
  return { create$, verify$, remove$ };
}
function createDomainSelection(scope: DomainState, site$: SiteSignal) {
  const { settings$, selectedDomainId$, notice$, saved$ } = scope;
  const persist$ = command(
    async ({ get, set }, publicSlug: string, signal: AbortSignal) => {
      const settings = await get(settings$);
      signal.throwIfAborted();
      const site = await get(site$);
      signal.throwIfAborted();
      if (!settings || !site) {
        return null;
      }
      const response = await accept(
        get(apiClient$)(hostContract).selectSiteDomain({
          params: { siteId: site.siteId },
          body: {
            domainId: get(selectedDomainId$),
            expectedRevision: settings.revision,
            publicSlug: get(selectedDomainId$) ? site.publicSlug : publicSlug,
            expectedPublicSlug: site.publicSlug,
          },
          fetchOptions: { signal },
        }),
        [200, 402, 409],
        signal,
      );
      signal.throwIfAborted();
      if (response.status !== 200) {
        if (response.status === 402) {
          await set(openSettingsBillingPlansDialog$, signal);
          signal.throwIfAborted();
        } else {
          set(notice$, response.body.error.message);
        }
        return null;
      }
      set(saved$, response.body);
      set(notice$, null);
      return response.body;
    },
  );
  return { persist$ };
}
export function createHostedSiteDomainSignals(site$: SiteSignal) {
  const scope = createDomainState(site$);
  const mutations = createDomainMutations(scope);
  return {
    ...scope,
    ...createDomainNavigation(scope),
    ...mutations,
    ...createDomainUpdates(scope, site$),
    ...createDomainSelection(scope, site$),
  };
}
