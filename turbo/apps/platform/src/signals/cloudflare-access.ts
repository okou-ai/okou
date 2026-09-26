import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import {
  cloudflareAccessContract,
  scopedCloudflareAccessConfigSchema,
  type ScopedCloudflareAccessConfig,
  type CloudflareAccessImpactPreview,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import { CLOUDFLARE_ACCESS_ERROR_CODES } from "@okouai/api-contracts/contracts/cloudflare-access-errors";
import { command, computed, state } from "ccstate";
import { z } from "zod";

import { accept } from "../lib/accept.ts";
import { apiClient$ } from "./api-client.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import { clerk$, currentOrgInfo$, user$ } from "./auth.ts";
import { isOrgAdmin$ } from "./org.ts";
import { setAblyPayloadLoop$ } from "./realtime.ts";
import { onRef, resetSignal } from "./utils.ts";

const cloudflareAccessChangedPayloadSchema = z
  .object({ orgId: z.string().min(1) })
  .strict();

export const cloudflareAccessIdentity$ = computed(async (get) => {
  const [user, identity] = await Promise.all([
    get(user$),
    get(runtimeAuthenticatedIdentity$),
  ]);
  return user ? `${identity.orgId}:${user.id}` : null;
});

const cloudflareAccessClient$ = computed(async (get) => {
  const [identity, clerk] = await Promise.all([
    get(cloudflareAccessIdentity$),
    get(clerk$),
  ]);
  const getSession = () => {
    const session = clerk.session;
    if (
      !identity ||
      !session ||
      identity !== `${clerk.organization?.id}:${clerk.user?.id}`
    ) {
      throw new DOMException("Cloudflare Access owner changed", "AbortError");
    }
    return session;
  };
  const getTokenGuard = () => {
    const session = getSession();
    return () => {
      if (getSession().id !== session.id) {
        throw new DOMException("Cloudflare Access owner changed", "AbortError");
      }
    };
  };
  return {
    identity,
    client: get(apiClient$)(cloudflareAccessContract, { getTokenGuard }),
  };
});

const reload$ = state(0);

export const invalidateCloudflareAccess$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

export const cloudflareAccessConfigs$ = computed(async (get) => {
  get(reload$);
  if (!(await get(cloudflareAccessIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(cloudflareAccessClient$)).client.list({
      query: { view: "scoped" },
    }),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200
    ? result.body.configs.map((config) => {
        return scopedCloudflareAccessConfigSchema.parse(config);
      })
    : null;
});

export const cloudflareAccessSummary$ = computed(async (get) => {
  const configs = await get(cloudflareAccessConfigs$);
  return configs ? { configuredCount: configs.length } : null;
});

export const retryCloudflareAccess$ = command(
  ({ set }, signal: AbortSignal) => {
    signal.throwIfAborted();
    set(invalidateCloudflareAccess$);
  },
);

const catchUpCloudflareAccess$ = command(({ set }) => {
  set(invalidateCloudflareAccess$);
  return false;
});

const onCloudflareAccessChanged$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    const parsed = cloudflareAccessChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    if (org?.id === parsed.data.orgId) {
      set(invalidateCloudflareAccess$);
    }
    return false;
  },
);

export const subscribeCloudflareAccessChanged$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "cloudflare-access:changed",
        loopCommand$: onCloudflareAccessChanged$,
        initializeCommand$: catchUpCloudflareAccess$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

export interface CloudflareAccessDialogState {
  readonly identity: string;
  readonly kind: "create" | "edit" | "delete";
  readonly config: ScopedCloudflareAccessConfig | null;
  readonly scope: "personal" | "organization";
}

const dialog$ = state<CloudflareAccessDialogState | null>(null);
const createScope$ = state<"personal" | "organization">("personal");
export const cloudflareAccessCreateScope$ = computed((get) => {
  return get(createScope$);
});
const conflict$ = state<string | null>(null);
const reviewedRevision$ = state<number | null>(null);
const replaceToken$ = state(false);
const saveMessage$ = state<string | null>(null);
const unresolvedSave$ = state<{
  readonly dialog: CloudflareAccessDialogState;
  readonly id: string;
} | null>(null);
const resetFormSave$ = resetSignal();

export const cloudflareAccessDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
  return dialog?.identity === (await get(cloudflareAccessIdentity$))
    ? dialog
    : null;
});

export const cloudflareAccessConflict$ = computed((get) => {
  return get(conflict$);
});

export const cloudflareAccessReplaceToken$ = computed((get) => {
  return get(replaceToken$);
});

export const cloudflareAccessSaveMessage$ = computed((get) => {
  return get(saveMessage$);
});

export const cloudflareAccessSaveUncertain$ = computed((get) => {
  const attempt = get(unresolvedSave$);
  return attempt !== null && attempt.dialog === get(dialog$);
});

const abandonCloudflareAccessSave$ = command(({ set }) => {
  set(unresolvedSave$, null);
  set(saveMessage$, null);
});

export const mountCloudflareAccessForm$ = onRef(
  command(({ set }, form: HTMLFormElement, signal: AbortSignal) => {
    form.querySelector("input")?.focus();
    signal.addEventListener(
      "abort",
      () => {
        set(resetFormSave$);
        set(abandonCloudflareAccessSave$);
        form.reset();
      },
      { once: true },
    );
  }),
);

export const replaceCloudflareAccessToken$ = command(
  ({ set }, replace: boolean) => {
    set(replaceToken$, replace);
  },
);

export const chooseCloudflareAccessScope$ = command(
  async (
    { get, set },
    scope: "personal" | "organization",
    signal: AbortSignal,
  ) => {
    const dialog = await get(cloudflareAccessDialog$);
    signal.throwIfAborted();
    if (
      !dialog ||
      dialog.kind !== "create" ||
      (scope === "organization" && !(await get(isOrgAdmin$)))
    ) {
      return;
    }
    signal.throwIfAborted();
    if (get(dialog$) === dialog) {
      set(createScope$, scope);
    }
  },
);

export const openCloudflareAccessDialog$ = command(
  async (
    { get, set },
    kind: CloudflareAccessDialogState["kind"],
    config: ScopedCloudflareAccessConfig | null,
    signal: AbortSignal,
  ) => {
    const identity = await get(cloudflareAccessIdentity$);
    signal.throwIfAborted();
    if (!identity) {
      return;
    }
    if (config?.scope === "organization" && !(await get(isOrgAdmin$))) {
      return;
    }
    signal.throwIfAborted();
    set(conflict$, null);
    set(reviewedRevision$, null);
    set(replaceToken$, false);
    set(createScope$, "personal");
    set(dialog$, {
      identity,
      kind,
      config,
      scope: config?.scope ?? "personal",
    });
  },
);

export const closeCloudflareAccessDialog$ = command(({ set }) => {
  set(abandonCloudflareAccessSave$);
  set(conflict$, null);
  set(replaceToken$, false);
  set(reviewedRevision$, null);
  set(dialog$, null);
});

function textField(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (!(field instanceof HTMLInputElement)) {
    throw new Error(`Missing Cloudflare Access form field: ${name}`);
  }
  return field.value;
}

function credentialsFromForm(form: HTMLFormElement) {
  return {
    clientId: textField(form, "clientId"),
    clientSecret: textField(form, "clientSecret"),
  };
}

async function updateCloudflareAccessConfig(
  client: InitClientReturn<typeof cloudflareAccessContract, InitClientArgs>,
  dialog: CloudflareAccessDialogState,
  form: HTMLFormElement,
  editor: {
    readonly reviewedRevision: number | null;
    readonly replace: boolean;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const config = dialog.config;
  if (!config) {
    throw new Error("Cloudflare Access edit requires a configuration");
  }
  const params = { configId: config.id };
  const expectedRevision = editor.reviewedRevision ?? config.revision;
  if (dialog.kind === "delete") {
    const result = await accept(
      client.delete({
        params,
        query: { view: "scoped" },
        body: { expectedRevision },
        fetchOptions: { signal },
      }),
      [204, 403, 404, 409],
      signal,
    );
    return result.status === 204 ? null : result.body.error.code;
  }
  const name = textField(form, "accessName").trim();
  if (name === config.name && !editor.replace) {
    return null;
  }
  const result = await accept(
    client.update({
      params,
      query: { view: "scoped" },
      body: {
        expectedRevision,
        ...(name !== config.name ? { name } : {}),
        ...(editor.replace ? { credentials: credentialsFromForm(form) } : {}),
      },
      fetchOptions: { signal },
    }),
    [200, 403, 404, 409],
    signal,
  );
  return result.status === 200 ? null : result.body.error.code;
}

const finishCloudflareAccessCreate$ = command(
  (
    { get, set },
    dialog: CloudflareAccessDialogState,
    result:
      | { readonly status: 201 | 204 }
      | {
          readonly status: 400 | 403 | 404 | 409 | 500;
          readonly body: { readonly error: { readonly code: string } };
        },
    retrying: boolean,
  ) => {
    if (get(dialog$) !== dialog) {
      return false;
    }
    if (result.status === 201 || result.status === 204) {
      set(unresolvedSave$, null);
      return true;
    }
    if (result.status === 500 || retrying) {
      return false;
    }
    if (!("body" in result)) {
      return false;
    }
    set(unresolvedSave$, null);
    if (result.status === 400) {
      set(saveMessage$, result.body.error.code);
    } else {
      set(conflict$, result.body.error.code);
      set(invalidateCloudflareAccess$);
    }
    return false;
  },
);

export const saveCloudflareAccess$ = command(
  async ({ get, set }, form: HTMLFormElement, parentSignal: AbortSignal) => {
    const signal = set(resetFormSave$, parentSignal);
    const dialog = await get(cloudflareAccessDialog$);
    signal.throwIfAborted();
    if (!dialog) {
      return;
    }
    const clients = await get(cloudflareAccessClient$);
    signal.throwIfAborted();
    if (clients.identity !== dialog.identity) {
      return;
    }
    const retrying = get(cloudflareAccessSaveUncertain$);
    let conflict: string | null = null;
    if (dialog.kind === "create") {
      const scope = get(createScope$);
      const retry = get(unresolvedSave$);
      const id = retry?.dialog === dialog ? retry.id : crypto.randomUUID();
      if (scope === "organization" && !(await get(isOrgAdmin$))) {
        set(conflict$, CLOUDFLARE_ACCESS_ERROR_CODES.FORBIDDEN);
        return;
      }
      signal.throwIfAborted();
      const body = cloudflareAccessContract.create.body.parse({
        id,
        name: textField(form, "accessName"),
        credentials: credentialsFromForm(form),
        scope,
      });
      set(saveMessage$, null);
      set(unresolvedSave$, { dialog, id });
      const result = await accept(
        clients.client.create({
          query: { view: "scoped" },
          body,
          fetchOptions: { signal },
        }),
        [201, 204, 400, 403, 404, 409, 500],
        signal,
      );
      if (!set(finishCloudflareAccessCreate$, dialog, result, retrying)) {
        return;
      }
    } else {
      if (dialog.scope === "organization" && !(await get(isOrgAdmin$))) {
        set(conflict$, CLOUDFLARE_ACCESS_ERROR_CODES.FORBIDDEN);
        return;
      }
      signal.throwIfAborted();
      conflict = await updateCloudflareAccessConfig(
        clients.client,
        dialog,
        form,
        {
          reviewedRevision: get(reviewedRevision$),
          replace: get(cloudflareAccessReplaceToken$),
        },
        signal,
      );
    }
    signal.throwIfAborted();
    if (dialog.identity !== (await get(cloudflareAccessIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    set(invalidateCloudflareAccess$);
    if (get(dialog$) !== dialog) {
      return;
    }
    if (conflict) {
      set(conflict$, conflict);
      return;
    }
    set(closeCloudflareAccessDialog$);
  },
);

export const cloudflareAccessConflictReview$ = computed(async (get) => {
  const dialog = await get(cloudflareAccessDialog$);
  const conflict = get(conflict$);
  if (
    !dialog?.config ||
    (conflict !== CLOUDFLARE_ACCESS_ERROR_CODES.REVISION_CONFLICT &&
      conflict !== CLOUDFLARE_ACCESS_ERROR_CODES.IN_USE)
  ) {
    return null;
  }
  const config = (await get(cloudflareAccessConfigs$))?.find((value) => {
    return value.id === dialog.config?.id;
  });
  return config ? { ...dialog, config } : null;
});

export const acceptCloudflareAccessConflictReview$ = command(
  async (
    { get, set },
    reviewed: CloudflareAccessDialogState,
    signal: AbortSignal,
  ) => {
    const current = await get(cloudflareAccessDialog$);
    signal.throwIfAborted();
    if (
      !current ||
      reviewed.identity !== current.identity ||
      reviewed.kind !== current.kind ||
      reviewed.config?.id !== current.config?.id
    ) {
      return;
    }
    set(reviewedRevision$, reviewed.config?.revision ?? null);
    set(conflict$, null);
  },
);

interface ConversionDialog {
  readonly identity: string;
  readonly configId: string;
  readonly name: string;
}

const conversionDialog$ = state<ConversionDialog | null>(null);
const conversionPreviewReload$ = state(0);
const conversionError$ = state<string | null>(null);
const conversionAcknowledgedSnapshot$ = state<string | null>(null);

export const cloudflareAccessConversionAcknowledgedSnapshot$ = computed(
  (get) => {
    return get(conversionAcknowledgedSnapshot$);
  },
);

export const acknowledgeCloudflareAccessConversion$ = command(
  ({ set }, snapshot: string | null) => {
    set(conversionAcknowledgedSnapshot$, snapshot);
  },
);

export const cloudflareAccessConversionDialog$ = computed(async (get) => {
  const dialog = get(conversionDialog$);
  return dialog?.identity === (await get(cloudflareAccessIdentity$))
    ? dialog
    : null;
});

export const cloudflareAccessConversionError$ = computed((get) => {
  return get(conversionError$);
});

export const openCloudflareAccessConversion$ = command(
  async (
    { get, set },
    config: ScopedCloudflareAccessConfig,
    signal: AbortSignal,
  ) => {
    const [identity, admin] = await Promise.all([
      get(cloudflareAccessIdentity$),
      get(isOrgAdmin$),
    ]);
    signal.throwIfAborted();
    if (!identity || !admin || config.scope !== "organization") {
      return;
    }
    set(conversionError$, null);
    set(conversionAcknowledgedSnapshot$, null);
    set(conversionDialog$, {
      identity,
      configId: config.id,
      name: config.name,
    });
  },
);

export const closeCloudflareAccessConversion$ = command(({ set }) => {
  set(conversionDialog$, null);
  set(conversionError$, null);
  set(conversionAcknowledgedSnapshot$, null);
});

export const reviewCloudflareAccessConversion$ = command(({ set }) => {
  set(conversionError$, null);
  set(conversionAcknowledgedSnapshot$, null);
  set(conversionPreviewReload$, (value) => {
    return value + 1;
  });
  set(invalidateCloudflareAccess$);
});

export const cloudflareAccessConversionPreview$ = computed(async (get) => {
  get(conversionPreviewReload$);
  const dialog = await get(cloudflareAccessConversionDialog$);
  if (!dialog) {
    return null;
  }
  const client = await get(cloudflareAccessClient$);
  if (client.identity !== dialog.identity) {
    return null;
  }
  const result = await accept(
    client.client.impactPreview({
      params: { configId: dialog.configId },
      query: { operation: "convert" },
    }),
    [200, 403, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body : null;
});

interface ReviewedAccessDialog {
  readonly identity: string;
  readonly configId: string;
  readonly name: string;
  readonly revision: number;
}
const promotionDialog$ = state<ReviewedAccessDialog | null>(null);
const promotionError$ = state<string | null>(null);
const promotionAcknowledged$ = state(false);
export const cloudflareAccessPromotionAcknowledged$ = computed((get) => {
  return get(promotionAcknowledged$);
});
export const acknowledgeCloudflareAccessPromotion$ = command(
  ({ set }, checked: boolean) => {
    return set(promotionAcknowledged$, checked);
  },
);
export const cloudflareAccessPromotionDialog$ = computed(async (get) => {
  const dialog = get(promotionDialog$);
  return dialog?.identity === (await get(cloudflareAccessIdentity$))
    ? dialog
    : null;
});
export const cloudflareAccessPromotionError$ = computed((get) => {
  return get(promotionError$);
});
export const openCloudflareAccessPromotion$ = command(
  async (
    { get, set },
    config: ScopedCloudflareAccessConfig,
    signal: AbortSignal,
  ) => {
    const [identity, admin] = await Promise.all([
      get(cloudflareAccessIdentity$),
      get(isOrgAdmin$),
    ]);
    signal.throwIfAborted();
    if (!identity || !admin || config.scope !== "personal") {
      return;
    }
    set(promotionError$, null);
    set(promotionAcknowledged$, false);
    set(promotionDialog$, {
      identity,
      configId: config.id,
      name: config.name,
      revision: config.revision,
    });
  },
);
export const closeCloudflareAccessPromotion$ = command(({ set }) => {
  set(promotionDialog$, null);
  set(promotionError$, null);
  set(promotionAcknowledged$, false);
});
export const confirmCloudflareAccessPromotion$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const dialog = await get(cloudflareAccessPromotionDialog$);
    signal.throwIfAborted();
    if (!dialog || !get(promotionAcknowledged$) || !(await get(isOrgAdmin$))) {
      set(promotionError$, CLOUDFLARE_ACCESS_ERROR_CODES.FORBIDDEN);
      return;
    }
    const client = await get(cloudflareAccessClient$);
    signal.throwIfAborted();
    if (client.identity !== dialog.identity) {
      return;
    }
    const [outcome] = await Promise.allSettled([
      accept(
        client.client.convertToOrganization({
          params: { configId: dialog.configId },
          body: { expectedRevision: dialog.revision },
          fetchOptions: { signal },
        }),
        [200, 403, 404, 409],
        signal,
      ),
    ]);
    signal.throwIfAborted();
    if (get(promotionDialog$) !== dialog) {
      return;
    }
    set(invalidateCloudflareAccess$);
    if (outcome.status === "rejected") {
      set(promotionError$, "uncertain");
    } else if (outcome.value.status === 200) {
      set(closeCloudflareAccessPromotion$);
    } else {
      set(promotionError$, outcome.value.body.error.code);
    }
  },
);

const deletionDialog$ = state<ReviewedAccessDialog | null>(null);
const deletionReload$ = state(0);
const deletionError$ = state<string | null>(null);
const deletionAcknowledged$ = state<string | null>(null);
export const cloudflareAccessDeletionDialog$ = computed(async (get) => {
  const dialog = get(deletionDialog$);
  return dialog?.identity === (await get(cloudflareAccessIdentity$))
    ? dialog
    : null;
});
export const cloudflareAccessDeletionError$ = computed((get) => {
  return get(deletionError$);
});
export const cloudflareAccessDeletionAcknowledged$ = computed((get) => {
  return get(deletionAcknowledged$);
});
export const acknowledgeCloudflareAccessDeletion$ = command(
  ({ set }, snapshot: string | null) => {
    return set(deletionAcknowledged$, snapshot);
  },
);
export const openCloudflareAccessDeletion$ = command(
  async (
    { get, set },
    config: ScopedCloudflareAccessConfig,
    signal: AbortSignal,
  ) => {
    const [identity, admin] = await Promise.all([
      get(cloudflareAccessIdentity$),
      get(isOrgAdmin$),
    ]);
    signal.throwIfAborted();
    if (!identity || !admin || config.scope !== "organization") {
      return;
    }
    set(deletionError$, null);
    set(deletionAcknowledged$, null);
    set(deletionDialog$, {
      identity,
      configId: config.id,
      name: config.name,
      revision: config.revision,
    });
  },
);
export const closeCloudflareAccessDeletion$ = command(({ set }) => {
  set(deletionDialog$, null);
  set(deletionError$, null);
  set(deletionAcknowledged$, null);
});
export const reviewCloudflareAccessDeletion$ = command(({ set }) => {
  set(deletionError$, null);
  set(deletionAcknowledged$, null);
  set(deletionReload$, (value) => {
    return value + 1;
  });
  set(invalidateCloudflareAccess$);
});
export const cloudflareAccessDeletionPreview$ = computed(async (get) => {
  get(deletionReload$);
  const dialog = await get(cloudflareAccessDeletionDialog$);
  if (!dialog) {
    return null;
  }
  const client = await get(cloudflareAccessClient$);
  if (client.identity !== dialog.identity) {
    return null;
  }
  const result = await accept(
    client.client.impactPreview({
      params: { configId: dialog.configId },
      query: { operation: "delete" },
    }),
    [200, 403, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body : null;
});
export const confirmCloudflareAccessDeletion$ = command(
  async (
    { get, set },
    preview: CloudflareAccessImpactPreview,
    signal: AbortSignal,
  ) => {
    const dialog = await get(cloudflareAccessDeletionDialog$);
    signal.throwIfAborted();
    if (!dialog || !(await get(isOrgAdmin$))) {
      set(deletionError$, CLOUDFLARE_ACCESS_ERROR_CODES.FORBIDDEN);
      return;
    }
    if (
      preview.ownHostCount > 0 ||
      (preview.otherHostCount > 0 &&
        get(deletionAcknowledged$) !== preview.impactSnapshot)
    ) {
      return;
    }
    const client = await get(cloudflareAccessClient$);
    signal.throwIfAborted();
    if (client.identity !== dialog.identity) {
      return;
    }
    const [outcome] = await Promise.allSettled([
      accept(
        client.client.delete({
          params: { configId: dialog.configId },
          query: { view: "scoped" },
          body: {
            expectedRevision: preview.expectedRevision,
            impactSnapshot: preview.impactSnapshot,
          },
          fetchOptions: { signal },
        }),
        [204, 403, 404, 409],
        signal,
      ),
    ]);
    signal.throwIfAborted();
    if (get(deletionDialog$) !== dialog) {
      return;
    }
    set(invalidateCloudflareAccess$);
    if (outcome.status === "rejected") {
      set(deletionError$, "uncertain");
    } else if (outcome.value.status === 204) {
      set(closeCloudflareAccessDeletion$);
    } else {
      set(deletionError$, outcome.value.body.error.code);
    }
  },
);

export const confirmCloudflareAccessConversion$ = command(
  async (
    { get, set },
    preview: CloudflareAccessImpactPreview,
    signal: AbortSignal,
  ) => {
    const dialog = await get(cloudflareAccessConversionDialog$);
    signal.throwIfAborted();
    if (!dialog || !(await get(isOrgAdmin$))) {
      set(conversionError$, CLOUDFLARE_ACCESS_ERROR_CODES.FORBIDDEN);
      return;
    }
    const client = await get(cloudflareAccessClient$);
    signal.throwIfAborted();
    if (client.identity !== dialog.identity) {
      return;
    }
    const [outcome] = await Promise.allSettled([
      accept(
        client.client.convertToPersonal({
          params: { configId: dialog.configId },
          body: {
            expectedRevision: preview.expectedRevision,
            impactSnapshot: preview.impactSnapshot,
          },
          fetchOptions: { signal },
        }),
        [200, 403, 404, 409],
        signal,
      ),
    ]);
    signal.throwIfAborted();
    if (outcome.status === "rejected") {
      if (dialog === get(conversionDialog$)) {
        set(conversionError$, "uncertain");
        set(invalidateCloudflareAccess$);
      }
      return;
    }
    if (dialog !== get(conversionDialog$)) {
      return;
    }
    set(invalidateCloudflareAccess$);
    const result = outcome.value;
    if (result.status === 200) {
      set(closeCloudflareAccessConversion$);
      return;
    }
    set(conversionError$, result.body.error.code);
  },
);
