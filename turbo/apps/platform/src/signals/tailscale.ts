import {
  applyRemoteNetworkScope$,
  resetRemoteNetworkScope$,
} from "./remote-network-scope.ts";
import { command, computed, state } from "ccstate";
import { privateNetworkHostCount } from "../lib/private-network-references.ts";
import { sortByName, sortRemoteHosts } from "../lib/remote-resource-order.ts";
import { locale$ } from "./locale.ts";
import {
  createTailscaleConfigRequestSchema,
  tailscaleChangedPayloadSchema,
  updateTailscaleConfigRequestSchema,
} from "@okouai/api-contracts/validators/tailscale";
import { tailscaleContract } from "@okouai/api-contracts/client/tailscale";
import type {
  TailscaleConfig,
  TailscaleImpactPreview,
} from "@okouai/api-contracts/contracts/tailscale";
import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";
import { accept } from "../lib/accept.ts";
import { ApiError } from "../lib/api-error.ts";
import { apiClient$ } from "./api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import {
  authenticatedSessionKey$,
  clerk$,
  currentOrgInfo$,
  user$,
} from "./auth.ts";
import { isOrgAdmin$ } from "./org.ts";
import { setAblyPayloadLoop$ } from "./realtime.ts";
import { invalidateRemoteAccess$ } from "./remote-access-refresh.ts";
import { onRef, resetSignal } from "./utils.ts";
import {
  openRemoteNetworkEditor$,
  closeRemoteNetworkEditor$,
} from "./remote-network-location.ts";

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

const tailscaleConfigsData$ = computed(async (get) => {
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
  const locale = get(locale$);
  const configs = await get(tailscaleConfigsData$);
  return configs
    ? sortByName(
        configs.map((config) => {
          return {
            ...config,
            sshHosts: sortRemoteHosts(config.sshHosts, locale),
            vncHosts: sortRemoteHosts(config.vncHosts, locale),
          };
        }),
        locale,
        (config) => {
          return { name: config.name, id: config.id };
        },
      )
    : null;
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
const acknowledged$ = state<string | null>(null);
// Never retain a request body: only its immutable identity survives uncertainty.
const attempt$ = state<{
  readonly dialog: TailscaleDialogState;
  readonly id: string;
} | null>(null);
const resetSave$ = resetSignal();

export const tailscaleDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
  if (!dialog || dialog.sessionKey !== get(authenticatedSessionKey$)) {
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

export const closeTailscaleDialog$ = command(
  ({ set }, preserveLocation = false) => {
    if (!preserveLocation) {
      set(closeRemoteNetworkEditor$, "tailscale");
    }
    set(resetRemoteNetworkScope$);
    set(resetSave$);
    set(dialog$, null);

    set(attempt$, null);
    set(replace$, false);
    set(acknowledged$, null);
  },
);
export const mountTailscaleForm$ = onRef(
  command(({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const mounted = get(dialog$);
    signal.addEventListener(
      "abort",
      () => {
        form.reset();
        if (get(dialog$) === mounted) {
          if (mounted?.sessionKey !== get(authenticatedSessionKey$)) {
            set(closeTailscaleDialog$);
          } else {
            // Ref reattachment must preserve the dialog's replacement choice.
            // Closing the dialog resets that choice; form cleanup clears inputs.
            set(resetSave$);
            set(attempt$, null);
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
    if (!identity) {
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
    set(closeTailscaleDialog$, true);
    set(scope$, "personal");
    set(dialog$, {
      identity,
      sessionKey: get(authenticatedSessionKey$),
      kind,
      config,
    });
    if (kind === "create" || kind === "edit") {
      set(openRemoteNetworkEditor$, "tailscale", config?.id ?? null);
    }
  },
);

export const tailscaleImpact$ = computed(async (get) => {
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
    if (clients.identity !== dialog.identity || get(dialog$) !== dialog) {
      return false;
    }
    if (get(tailscaleSaveUncertain$)) {
      return false;
    }
    const id = crypto.randomUUID();
    const parsed = createTailscaleConfigRequestSchema.safeParse({
      id,
      scope: get(scope$),
      ...tailscaleFieldsFromForm(form),
    });
    if (!parsed.success) {
      throw new ApiError("Invalid Tailscale input", "INVALID_INPUT", 400, true);
    }
    set(attempt$, { dialog, id });
    const result = await accept(
      clients.client.create({ body: parsed.data, fetchOptions: { signal } }),
      [201, 204, 400, 401, 403, 404, 409, 500],
      signal,
      { showErrorToast: false },
    );
    if (get(dialog$) !== dialog) {
      return false;
    }
    if (result.status === 201 || result.status === 204) {
      return true;
    }
    if (result.status !== 500) {
      set(attempt$, null);
    }
    throw new ApiError(
      "Tailscale request failed",
      result.status >= 500 ? "uncertain" : result.body.error.code,
      result.status,
      true,
    );
  },
);

const editTailscale$ = command(
  async (
    { get },
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
    if (clients.identity !== dialog.identity || get(dialog$) !== dialog) {
      return false;
    }
    const parsed = updateTailscaleConfigRequestSchema.safeParse({
      expectedRevision: config.revision,
      name: formText(form, "tailscaleName"),
      tags: formText(form, "tailscaleTags")
        .split(/[,\s]+/u)
        .filter(Boolean),
      ...(get(replace$)
        ? { credentials: tailscaleFieldsFromForm(form).credentials }
        : {}),
    });
    if (!parsed.success) {
      throw new ApiError("Invalid Tailscale input", "INVALID_INPUT", 400, true);
    }
    if (
      !get(replace$) &&
      parsed.data.name === config.name &&
      parsed.data.tags?.length === config.tags.length &&
      parsed.data.tags.every((tag, index) => {
        return tag === config.tags[index];
      })
    ) {
      return true;
    }
    const result = await accept(
      clients.client.update({
        params: { configId: config.id },
        body: parsed.data,
        fetchOptions: { signal },
      }),
      [200, 400, 401, 403, 404, 409, 500],
      signal,
      { showErrorToast: false },
    );
    if (get(dialog$) !== dialog) {
      return false;
    }
    if (result.status === 200) {
      return true;
    }
    throw new ApiError(
      "Tailscale request failed",
      result.status >= 500 ? "uncertain" : result.body.error.code,
      result.status,
      true,
    );
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
    if (clients.identity !== dialog.identity || get(dialog$) !== dialog) {
      return false;
    }
    const params = { configId: config.id };
    const expectedRevision = preview?.expectedRevision ?? config.revision;
    if (!canConfirmTailscaleChange(dialog, preview, get(acknowledged$))) {
      return false;
    }
    set(acknowledged$, null);
    const result = await (async () => {
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
    })();
    signal.throwIfAborted();
    if (get(dialog$) !== dialog) {
      return false;
    }
    if (result.status === 200 || result.status === 204) {
      return true;
    }
    throw new ApiError(
      "Tailscale request failed",
      result.status >= 500 ? "uncertain" : result.body.error.code,
      result.status,
      true,
    );
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
    const signal = set(resetSave$, parentSignal);
    let dialog = await get(tailscaleDialog$);
    signal.throwIfAborted();
    if (!dialog) {
      return;
    }
    const admin = await get(isOrgAdmin$);
    signal.throwIfAborted();
    if (tailscaleSaveNeedsAdmin(dialog, get(scope$)) && !admin) {
      throw new ApiError(
        "Tailscale access is forbidden",
        TAILSCALE_ERROR_CODES.FORBIDDEN,
        403,
        true,
      );
    }
    if (get(dialog$) !== dialog) {
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
        return;
      }
      if (get(dialog$) !== dialog) {
        return;
      }
      if (config !== dialog.config) {
        dialog = { ...dialog, config: { ...dialog.config, ...config } };
        set(dialog$, dialog);
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
      const savedId =
        dialog.kind === "create" ? get(attempt$)?.id : dialog.config?.id;
      set(closeTailscaleDialog$);
      set(invalidateTailscale$);
      return savedId;
    }
    return;
  },
);
