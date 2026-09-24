import type {
  InitClientArgs,
  InitClientReturn,
} from "@okouai/api-contracts/contracts/trpc-contract";
import {
  cloudflareAccessContract,
  scopedCloudflareAccessConfigSchema,
  type ScopedCloudflareAccessConfig,
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
