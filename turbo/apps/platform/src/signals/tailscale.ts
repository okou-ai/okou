import {
  applyRemoteNetworkScope$,
  remoteNetworkScopeStatus$,
  resetRemoteNetworkScope$,
} from "./remote-network-scope.ts";
import { command, computed, state } from "ccstate";
import { privateNetworkHostCount } from "../lib/private-network-references.ts";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  tailscaleChangedPayloadSchema,
  tailscaleContract,
  type TailscaleConfig,
  type TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";
import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import {
  authenticatedSessionKey$,
  clerk$,
  currentOrgInfo$,
  user$,
} from "./auth.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { isOrgAdmin$ } from "./org.ts";
import { setAblyPayloadLoop$ } from "./realtime.ts";
import { invalidateRemoteAccess$ } from "./remote-access-refresh.ts";
import { onRef, resetSignal, settle } from "./utils.ts";

export const tailscaleEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.TailscaleAccess];
});

/** VNC uses reusable networks without enabling the Tailscale SSH editor. */
export const tailscaleSettingsEnabled$ = computed((get) => {
  const switches = get(featureSwitch$);
  return (
    switches[FeatureSwitchKey.TailscaleAccess] ||
    switches[FeatureSwitchKey.VncAccess]
  );
});

export const tailscaleIdentity$ = computed(async (get) => {
  const sessionKey = get(authenticatedSessionKey$);
  const [user, identity, clerk] = await Promise.all([
    get(user$),
    get(runtimeAuthenticatedIdentity$),
    get(clerk$),
  ]);
  if (
    !user ||
    user.id !== identity.userId ||
    !sessionKey ||
    sessionKey !== JSON.stringify([identity.orgId, user.id, clerk.session?.id])
  ) {
    return null;
  }
  return `${identity.orgId}:${user.id}`;
});

const tailscaleClient$ = computed(async (get) => {
  const [identity, clerk] = await Promise.all([
    get(tailscaleIdentity$),
    get(clerk$),
  ]);
  const sessionForOwner = () => {
    if (
      !identity ||
      !clerk.session ||
      identity !== `${clerk.organization?.id}:${clerk.user?.id}`
    ) {
      throw new DOMException("Tailscale owner changed", "AbortError");
    }
    return clerk.session;
  };
  const getTokenGuard = () => {
    const session = sessionForOwner();
    return () => {
      if (sessionForOwner().id !== session.id) {
        throw new DOMException("Tailscale owner changed", "AbortError");
      }
    };
  };
  return {
    identity,
    client: get(apiClient$)(tailscaleContract, { getTokenGuard }),
  };
});

const reload$ = state(0);
export const invalidateTailscale$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
  set(invalidateRemoteAccess$);
});

/** Shared owner metadata; each settings surface owns its existing UI gate. */
export const scopedTailscaleConfigs$ = computed(async (get) => {
  get(reload$);
  if (!(await get(tailscaleIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(tailscaleClient$)).client.list(),
    [200],
    undefined,
    { showErrorToast: false },
  );
  return result.body.configs;
});
export const tailscaleConfigs$ = computed(async (get) => {
  return get(tailscaleSettingsEnabled$)
    ? await get(scopedTailscaleConfigs$)
    : null;
});

export const retryTailscale$ = command(({ set }, signal: AbortSignal) => {
  signal.throwIfAborted();
  set(invalidateTailscale$);
});

const catchUpTailscale$ = command(({ set }) => {
  set(invalidateTailscale$);
  return false;
});
const onTailscaleChanged$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    const parsed = tailscaleChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    if (org?.id === parsed.data.orgId) {
      set(invalidateTailscale$);
    }
    return false;
  },
);
export const subscribeTailscaleChanged$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "tailscale:changed",
        loopCommand$: onTailscaleChanged$,
        initializeCommand$: catchUpTailscale$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

export type TailscaleOperation =
  "create" | "edit" | "delete" | "promote" | "adopt";
export interface TailscaleDialogState {
  readonly identity: string;
  readonly sessionKey: string | null;
  readonly kind: TailscaleOperation;
  readonly config: TailscaleConfig | null;
}
const dialog$ = state<TailscaleDialogState | null>(null);
const scope$ = state<"personal" | "organization">("personal");
const replace$ = state(false);
const error$ = state<string | null>(null);
const reviewedRevision$ = state<number | null>(null);
const acknowledged$ = state<string | null>(null);
const previewReload$ = state(0);
// Never retain a request body: only its immutable identity survives uncertainty.
const attempt$ = state<{
  readonly dialog: TailscaleDialogState;
  readonly id: string;
} | null>(null);
const resetSave$ = resetSignal();

export const tailscaleDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
  if (
    !get(tailscaleSettingsEnabled$) ||
    !dialog ||
    dialog.sessionKey !== get(authenticatedSessionKey$)
  ) {
    return null;
  }
  return dialog?.identity === (await get(tailscaleIdentity$)) ? dialog : null;
});
export const tailscaleScope$ = computed((get) => {
  return get(scope$);
});
export const tailscaleReplaceCredentials$ = computed((get) => {
  return get(replace$);
});
export const tailscaleError$ = computed((get) => {
  return get(error$);
});
export const tailscaleAcknowledged$ = computed((get) => {
  return get(acknowledged$);
});
export const tailscaleSaveUncertain$ = computed((get) => {
  return get(attempt$)?.dialog === get(dialog$) && get(attempt$) !== null;
});
export const chooseTailscaleScope$ = command(
  async (
    { get, set },
    scope: "personal" | "organization",
    signal: AbortSignal,
  ) => {
    const admin = await get(isOrgAdmin$);
    signal.throwIfAborted();
    if (get(dialog$)?.kind === "create" && (scope === "personal" || admin)) {
      set(scope$, scope);
    }
  },
);
export const replaceTailscaleCredentials$ = command(
  ({ set }, replace: boolean) => {
    return set(replace$, replace);
  },
);
export const acknowledgeTailscale$ = command(
  ({ set }, snapshot: string | null) => {
    return set(acknowledged$, snapshot);
  },
);

export const closeTailscaleDialog$ = command(({ set }) => {
  set(resetRemoteNetworkScope$);
  set(resetSave$);
  set(dialog$, null);
  set(error$, null);
  set(attempt$, null);
  set(replace$, false);
  set(reviewedRevision$, null);
  set(acknowledged$, null);
});
export const mountTailscaleForm$ = onRef(
  command(({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const mounted = get(dialog$);
    signal.addEventListener(
      "abort",
      () => {
        form.reset();
        if (get(dialog$) === mounted) {
          if (
            !get(tailscaleSettingsEnabled$) ||
            mounted?.sessionKey !== get(authenticatedSessionKey$)
          ) {
            set(closeTailscaleDialog$);
          } else {
            set(resetSave$);
            set(attempt$, null);
            set(replace$, false);
          }
        }
      },
      { once: true },
    );
  }),
);
export const mountTailscaleSecrets$ = onRef(
  command((_context, fields: HTMLFieldSetElement, signal: AbortSignal) => {
    signal.addEventListener(
      "abort",
      () => {
        for (const input of fields.querySelectorAll("input")) {
          input.value = "";
        }
      },
      { once: true },
    );
  }),
);

export const openTailscaleDialog$ = command(
  async (
    { get, set },
    kind: TailscaleOperation,
    config: TailscaleConfig | null,
    signal: AbortSignal,
  ) => {
    const [identity, admin] = await Promise.all([
      get(tailscaleIdentity$),
      get(isOrgAdmin$),
    ]);
    signal.throwIfAborted();
    if (!identity || !get(tailscaleSettingsEnabled$)) {
      return;
    }
    if (kind !== "create" && !config) {
      return;
    }
    if (
      (config?.scope === "organization" ||
        kind === "promote" ||
        kind === "adopt") &&
      !admin
    ) {
      return;
    }
    if (
      (kind === "promote" && config?.scope !== "personal") ||
      (kind === "adopt" && config?.scope !== "organization")
    ) {
      return;
    }
    set(closeTailscaleDialog$);
    set(scope$, "personal");
    set(dialog$, {
      identity,
      sessionKey: get(authenticatedSessionKey$),
      kind,
      config,
    });
  },
);

export const tailscaleImpact$ = computed(async (get) => {
  get(previewReload$);
  get(reload$);
  const dialog = await get(tailscaleDialog$);
  if (
    !dialog?.config ||
    dialog.config.scope !== "organization" ||
    (dialog.kind !== "adopt" && dialog.kind !== "delete")
  ) {
    return null;
  }
  const clients = await get(tailscaleClient$);
  if (clients.identity !== dialog.identity) {
    return null;
  }
  const result = await accept(
    clients.client.impactPreview({
      params: { configId: dialog.config.id },
      query: { operation: dialog.kind === "adopt" ? "convert" : "delete" },
    }),
    [200],
    undefined,
    { showErrorToast: false },
  );
  return result.body;
});
export const tailscaleLatestConfig$ = computed(async (get) => {
  const dialog = await get(tailscaleDialog$);
  if (dialog?.kind !== "edit" || !dialog.config || !get(error$)) {
    return null;
  }
  return (
    (await get(tailscaleConfigs$))?.find((config) => {
      return config.id === dialog.config?.id;
    }) ?? null
  );
});
export const reviewTailscale$ = command(
  async ({ get, set }, reviewed: TailscaleConfig, signal: AbortSignal) => {
    const dialog = await get(tailscaleDialog$);
    signal.throwIfAborted();
    if (!dialog) {
      return;
    }
    const clients = await get(tailscaleClient$);
    signal.throwIfAborted();
    if (clients.identity !== dialog.identity) {
      return;
    }
    const result = await accept(
      clients.client.list({ fetchOptions: { signal } }),
      [200],
      signal,
    );
    if (get(dialog$) !== dialog) {
      return;
    }
    const latest = result.body.configs.find((config) => {
      return config.id === dialog.config?.id;
    });
    if (!latest) {
      set(error$, TAILSCALE_ERROR_CODES.NOT_FOUND);
      return;
    }
    if (
      latest.id !== reviewed.id ||
      latest.revision !== reviewed.revision ||
      latest.generation !== reviewed.generation ||
      latest.scope !== reviewed.scope ||
      latest.scope !== dialog.config?.scope
    ) {
      set(error$, TAILSCALE_ERROR_CODES.REVISION_CONFLICT);
      set(invalidateTailscale$);
      return;
    }
    set(reviewedRevision$, latest.revision);
    set(error$, null);
    set(attempt$, null);
    set(acknowledged$, null);
    set(previewReload$, (value) => {
      return value + 1;
    });
    set(invalidateTailscale$);
  },
);
export const refreshTailscaleReview$ = command(
  ({ get, set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    const dialog = get(dialog$);
    if (
      dialog?.kind === "adopt" ||
      (dialog?.kind === "delete" && dialog.config?.scope === "organization")
    ) {
      set(error$, null);
    }
    set(acknowledged$, null);
    set(previewReload$, (value) => {
      return value + 1;
    });
    set(invalidateTailscale$);
  },
);

function formText(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (!(
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
  )) {
    throw new Error(`Missing Tailscale form field: ${name}`);
  }
  return field.value;
}
export function tailscaleFieldsFromForm(form: HTMLFormElement) {
  return {
    name: formText(form, "tailscaleName"),
    tags: formText(form, "tailscaleTags")
      .split(/[,\s]+/u)
      .filter(Boolean),
    credentials: {
      clientId: formText(form, "tailscaleClientId"),
      clientSecret: formText(form, "tailscaleClientSecret"),
    },
  };
}

const createTailscale$ = command(
  async (
    { get, set },
    dialog: TailscaleDialogState,
    form: HTMLFormElement,
    signal: AbortSignal,
  ) => {
    const clients = await get(tailscaleClient$);
    signal.throwIfAborted();
    if (
      clients.identity !== dialog.identity ||
      get(dialog$) !== dialog ||
      !get(tailscaleSettingsEnabled$)
    ) {
      return false;
    }
    const attempt = get(attempt$);
    const id = attempt?.dialog === dialog ? attempt.id : crypto.randomUUID();
    const parsed = tailscaleContract.create.body.safeParse({
      id,
      scope: get(scope$),
      ...tailscaleFieldsFromForm(form),
    });
    if (!parsed.success) {
      set(error$, "invalid");
      return false;
    }
    set(attempt$, { dialog, id });
    const outcome = await settle(
      accept(
        clients.client.create({ body: parsed.data, fetchOptions: { signal } }),
        [201, 204, 400, 401, 403, 404, 409, 500],
        signal,
        { showErrorToast: false },
      ),
      signal,
    );
    if (get(dialog$) !== dialog) {
      return false;
    }
    if (!outcome.ok) {
      set(error$, "uncertain");
      return false;
    }
    const result = outcome.value;
    if (result.status === 201 || result.status === 204) {
      return true;
    }
    if (result.status !== 500) {
      set(attempt$, null);
    }
    set(error$, result.status === 500 ? "uncertain" : result.body.error.code);
    return false;
  },
);

const editTailscale$ = command(
  async (
    { get, set },
    dialog: TailscaleDialogState,
    form: HTMLFormElement,
    signal: AbortSignal,
  ) => {
    const config = dialog.config;
    if (!config) {
      throw new Error("Tailscale edit requires a configuration");
    }
    const clients = await get(tailscaleClient$);
    signal.throwIfAborted();
    if (
      clients.identity !== dialog.identity ||
      get(dialog$) !== dialog ||
      !get(tailscaleSettingsEnabled$)
    ) {
      return false;
    }
    const parsed = tailscaleContract.update.body.safeParse({
      expectedRevision: get(reviewedRevision$) ?? config.revision,
      name: formText(form, "tailscaleName"),
      tags: formText(form, "tailscaleTags")
        .split(/[,\s]+/u)
        .filter(Boolean),
      ...(get(replace$)
        ? { credentials: tailscaleFieldsFromForm(form).credentials }
        : {}),
    });
    if (!parsed.success) {
      set(error$, "invalid");
      return false;
    }
    if (
      get(reviewedRevision$) === null &&
      !get(replace$) &&
      parsed.data.name === config.name &&
      parsed.data.tags?.length === config.tags.length &&
      parsed.data.tags.every((tag, index) => {
        return tag === config.tags[index];
      })
    ) {
      return true;
    }
    const outcome = await settle(
      accept(
        clients.client.update({
          params: { configId: config.id },
          body: parsed.data,
          fetchOptions: { signal },
        }),
        [200, 400, 401, 403, 404, 409, 500],
        signal,
        { showErrorToast: false },
      ),
      signal,
    );
    if (get(dialog$) !== dialog) {
      return false;
    }
    if (!outcome.ok) {
      set(error$, "uncertain");
      set(invalidateTailscale$);
      return false;
    }
    const result = outcome.value;
    if (result.status === 200) {
      return true;
    }
    set(error$, result.status === 500 ? "uncertain" : result.body.error.code);
    set(invalidateTailscale$);
    return false;
  },
);

function canConfirmTailscaleChange(
  dialog: TailscaleDialogState,
  preview: TailscaleImpactPreview | null,
  acknowledged: string | null,
) {
  if (dialog.kind === "promote") {
    return acknowledged === "promote";
  }
  if (
    dialog.config?.scope === "organization" &&
    (dialog.kind === "delete" || dialog.kind === "adopt")
  ) {
    return (
      preview !== null &&
      (preview.otherHostCount === 0 ||
        acknowledged === preview.impactSnapshot) &&
      (dialog.kind !== "delete" || preview.ownHostCount === 0)
    );
  }
  return (
    dialog.kind !== "delete" ||
    (!!dialog.config && privateNetworkHostCount(dialog.config) === 0)
  );
}

const confirmTailscaleChange$ = command(
  async (
    { get, set },
    dialog: TailscaleDialogState,
    preview: TailscaleImpactPreview | null,
    signal: AbortSignal,
  ) => {
    const config = dialog.config;
    if (!config) {
      throw new Error("Tailscale operation requires a configuration");
    }
    const clients = await get(tailscaleClient$);
    signal.throwIfAborted();
    if (
      clients.identity !== dialog.identity ||
      get(dialog$) !== dialog ||
      !get(tailscaleSettingsEnabled$)
    ) {
      return false;
    }
    const params = { configId: config.id };
    const expectedRevision = preview?.expectedRevision ?? config.revision;
    if (!canConfirmTailscaleChange(dialog, preview, get(acknowledged$))) {
      return false;
    }
    const outcome = await settle(
      (async () => {
        if (dialog.kind === "promote") {
          return await accept(
            clients.client.convertToOrganization({
              params,
              body: { expectedRevision },
              fetchOptions: { signal },
            }),
            [200, 400, 401, 403, 404, 409, 500],
            signal,
            { showErrorToast: false },
          );
        }
        if (dialog.kind === "adopt" && preview) {
          return await accept(
            clients.client.convertToPersonal({
              params,
              body: {
                expectedRevision,
                impactSnapshot: preview.impactSnapshot,
              },
              fetchOptions: { signal },
            }),
            [200, 400, 401, 403, 404, 409, 500],
            signal,
            { showErrorToast: false },
          );
        }
        return await accept(
          clients.client.delete({
            params,
            body: {
              expectedRevision,
              ...(preview ? { impactSnapshot: preview.impactSnapshot } : {}),
            },
            fetchOptions: { signal },
          }),
          [204, 400, 401, 403, 404, 409, 500],
          signal,
          { showErrorToast: false },
        );
      })(),
      signal,
    );
    if (get(dialog$) !== dialog) {
      return false;
    }
    if (!outcome.ok) {
      set(error$, "uncertain");
      set(acknowledged$, null);
      set(invalidateTailscale$);
      return false;
    }
    const result = outcome.value;
    if (result.status === 200 || result.status === 204) {
      return true;
    }
    set(error$, result.status === 500 ? "uncertain" : result.body.error.code);
    set(acknowledged$, null);
    set(invalidateTailscale$);
    return false;
  },
);

function tailscaleSaveNeedsAdmin(
  dialog: TailscaleDialogState,
  createScope: "personal" | "organization",
) {
  return (
    (dialog.kind === "create" ? createScope : dialog.config?.scope) ===
      "organization" ||
    dialog.kind === "promote" ||
    dialog.kind === "adopt"
  );
}

export const saveTailscale$ = command(
  async ({ get, set }, form: HTMLFormElement, parentSignal: AbortSignal) => {
    if (get(remoteNetworkScopeStatus$).busy) {
      return;
    }
    const signal = set(resetSave$, parentSignal);
    let dialog = await get(tailscaleDialog$);
    signal.throwIfAborted();
    if (!dialog) {
      return;
    }
    const admin = await get(isOrgAdmin$);
    signal.throwIfAborted();
    if (tailscaleSaveNeedsAdmin(dialog, get(scope$)) && !admin) {
      set(error$, TAILSCALE_ERROR_CODES.FORBIDDEN);
      return;
    }
    if (get(dialog$) !== dialog || !get(tailscaleSettingsEnabled$)) {
      return;
    }
    if (dialog.kind === "edit" && dialog.config) {
      const config = await set(
        applyRemoteNetworkScope$,
        "tailscale",
        dialog.config,
        signal,
      );
      signal.throwIfAborted();
      if (!config) {
        set(invalidateTailscale$);
        return;
      }
      if (get(dialog$) !== dialog) {
        return;
      }
      if (config !== dialog.config) {
        dialog = { ...dialog, config: { ...dialog.config, ...config } };
        set(dialog$, dialog);
        set(reviewedRevision$, null);
        set(invalidateTailscale$);
      }
    }
    let completed: boolean;
    if (dialog.kind === "create") {
      completed = await set(createTailscale$, dialog, form, signal);
    } else if (dialog.kind === "edit") {
      completed = await set(editTailscale$, dialog, form, signal);
    } else {
      const preview = await get(tailscaleImpact$);
      signal.throwIfAborted();
      completed = await set(confirmTailscaleChange$, dialog, preview, signal);
    }
    const identity = await get(tailscaleIdentity$);
    signal.throwIfAborted();
    if (completed && get(dialog$) === dialog && identity === dialog.identity) {
      set(closeTailscaleDialog$);
      set(invalidateTailscale$);
    }
  },
);
