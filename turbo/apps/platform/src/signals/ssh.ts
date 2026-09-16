import type {
  InitClientReturn,
  InitClientArgs,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { command, computed, state } from "ccstate";
import {
  sshCredentialsContract,
  createSshCredentialRequestSchema,
  updateSshCredentialRequestSchema,
  type SshCredentialResponse,
} from "@okouai/api-contracts/contracts/ssh-credentials";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import {
  cloudflareAccessContract,
  type CloudflareAccessConfig,
} from "@okouai/api-contracts/contracts/cloudflare-access";
import {
  agentSshAccessContract,
  sshChangedPayloadSchema,
} from "@okouai/api-contracts/contracts/ssh-access";
import { setAblyPayloadLoop$ } from "./realtime.ts";
import {
  sshConnectionsContract,
  type SshConnectionResponse,
  createSshConnectionRequestSchema,
  updateSshConnectionRequestSchema,
  SSH_PRIVATE_KEY_MAX_LENGTH,
} from "@okouai/api-contracts/contracts/ssh-connections";
import { clerk$, currentOrgInfo$, user$ } from "./auth.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { apiClient$ } from "./api-client.ts";
import { currentAgent$, agents$ } from "./agent.ts";
import { accept } from "../lib/accept.ts";
import {
  createDeferredPromise,
  onRef,
  resetSignal,
  settle,
  setDaemon,
  waitForOperation,
  withCleanup,
} from "./utils.ts";

type PrivateKeyFileError = "size" | "read";
const privateKeyFileRead$ = state<Promise<PrivateKeyFileError | null> | null>(
  null,
);
const resetPrivateKeyRead$ = resetSignal();
export const sshPrivateKeyFileResult$ = computed(async (get) => {
  return await get(privateKeyFileRead$);
});
export const cancelSshPrivateKeyFile$ = command(({ set }) => {
  set(resetPrivateKeyRead$);
  set(privateKeyFileRead$, null);
});
const resetFormSave$ = resetSignal();
const resetAccessFormSave$ = resetSignal();
export const mountSshForm$ = onRef(
  command(({ set }, form: HTMLFormElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      set(resetFormSave$);
      form.reset();
      set(cancelSshPrivateKeyFile$);
    });
  }),
);
export const mountSshAccessForm$ = onRef(
  command(({ set }, form: HTMLFormElement, signal: AbortSignal) => {
    const first = form.querySelector("input");
    first?.focus();
    signal.addEventListener(
      "abort",
      () => {
        set(resetAccessFormSave$);
        form.reset();
      },
      { once: true },
    );
  }),
);
export const mountSshPrivateKey$ = onRef(
  command(({ set }, input: HTMLTextAreaElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      input.value = "";
      set(cancelSshPrivateKeyFile$);
    });
  }),
);

const readPrivateKeyFile$ = command(
  async (
    { set },
    input: HTMLInputElement,
    parentSignal: AbortSignal,
  ): Promise<PrivateKeyFileError | null> => {
    const file = input.files?.[0];
    input.value = "";
    if (!file) {
      return null;
    }
    set(cancelSshPrivateKeyFile$);
    const signal = set(resetPrivateKeyRead$, parentSignal);
    signal.throwIfAborted();
    const privateKey = input.form?.elements.namedItem("privateKey");
    if (!(privateKey instanceof HTMLTextAreaElement)) {
      throw new Error("SSH credential form is missing its private key field");
    }
    privateKey.value = "";
    if (file.size === 0 || file.size > SSH_PRIVATE_KEY_MAX_LENGTH) {
      return "size";
    }
    const aborted = createDeferredPromise<never>(signal);
    const result = await withCleanup(
      settle(Promise.race([file.text(), aborted.promise]), signal),
      () => {
        if (!aborted.settled()) {
          aborted.reject(new DOMException("File read finished", "AbortError"));
        }
      },
    );
    signal.throwIfAborted();
    if (!result.ok) {
      return "read";
    }
    if (result.value.length === 0) {
      return "size";
    }
    privateKey.value = result.value;
    return null;
  },
);
export const importSshPrivateKeyFile$ = command(
  ({ set }, input: HTMLInputElement, signal: AbortSignal) => {
    // Persist only the non-secret outcome, never the File or decoded key.
    const result = set(readPrivateKeyFile$, input, signal);
    set(privateKeyFileRead$, result);
    return result;
  },
);

export const sshIdentity$ = computed(async (get) => {
  const enabled = get(sshEnabled$);
  if (!enabled) {
    return null;
  }
  // User changes invalidate SSH state; global org switching reloads the page.
  // Background token/profile updates must not reset credential forms.
  const [user, identity] = await Promise.all([
    get(user$),
    get(runtimeAuthenticatedIdentity$),
  ]);
  return user ? `${identity.orgId}:${user.id}` : null;
});
const reload$ = state(0);
const sshClients$ = computed(async (get) => {
  const [identity, clerk] = await Promise.all([get(sshIdentity$), get(clerk$)]);
  const createClient = get(apiClient$);
  const getSession = () => {
    const session = clerk.session;
    if (
      !identity ||
      !session ||
      identity !== `${clerk.organization?.id}:${clerk.user?.id}`
    ) {
      throw new DOMException("SSH owner changed", "AbortError");
    }
    return session;
  };
  const getTokenGuard = () => {
    const session = getSession();
    return () => {
      if (getSession().id !== session.id) {
        throw new DOMException("SSH owner changed", "AbortError");
      }
    };
  };
  const options = { getTokenGuard };
  return {
    identity,
    connections: createClient(sshConnectionsContract, options),
    access: createClient(agentSshAccessContract, options),
    credentials: createClient(sshCredentialsContract, options),
    cloudflare: createClient(cloudflareAccessContract, options),
  };
});
export interface SshDialogState {
  readonly identity: string;
  readonly kind:
    | "create"
    | "edit"
    | "delete"
    | "reset"
    | "create-credential"
    | "edit-credential"
    | "delete-credential"
    | "create-access"
    | "edit-access"
    | "delete-access";
  readonly credential: SshCredentialResponse | null;
  readonly connection: SshConnectionResponse | null;
  readonly config: CloudflareAccessConfig | null;
}
const dialog$ = state<SshDialogState | null>(null);
export const sshEnabled$ = computed((get) => {
  return get(featureSwitch$)[FeatureSwitchKey.SshAccess];
});
const view$ = state<"hosts" | "credentials" | "access">("hosts");
export const sshView$ = computed((get) => {
  const view = get(view$);
  return view === "access" && !get(sshEnabled$) ? "hosts" : view;
});
export const changeSshView$ = command(({ get, set }, value: string) => {
  if (
    value === "hosts" ||
    value === "credentials" ||
    (value === "access" && get(sshEnabled$))
  ) {
    set(view$, value);
  }
});
const transportEditor$ = state<{ mode: string; configId: string | null }>({
  mode: "direct",
  configId: null,
});
export const sshTransportEditor$ = computed((get) => {
  return get(transportEditor$);
});
export const chooseSshTransport$ = command(({ get, set }, mode: string) => {
  if (mode === "direct" || (mode === "cloudflare_access" && get(sshEnabled$))) {
    set(transportEditor$, (current) => {
      return { ...current, mode };
    });
    const conflict = get(conflict$);
    if (
      conflict === SSH_ERROR_CODES.ACCESS_NOT_FOUND ||
      (mode === "direct" && conflict === SSH_ERROR_CODES.ACCESS_UNAVAILABLE)
    ) {
      set(conflict$, null);
    }
  }
});
export const chooseSshAccessConfig$ = command(
  ({ get, set }, configId: string | null) => {
    if (configId !== null) {
      set(transportEditor$, (current) => {
        return { ...current, configId };
      });
      if (get(conflict$) === SSH_ERROR_CODES.ACCESS_NOT_FOUND) {
        set(conflict$, null);
      }
    }
  },
);
const replaceAccessToken$ = state(false);
export const sshReplaceAccessToken$ = computed((get) => {
  return get(replaceAccessToken$);
});
export const replaceSshAccessToken$ = command(({ set }, replace: boolean) => {
  set(replaceAccessToken$, replace);
});
export const sshCloudflareConfigs$ = computed(async (get) => {
  get(reload$);
  if (!get(sshEnabled$) || !(await get(sshIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).cloudflare.list(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.configs : null;
});
const credentialEditor$ = state<{
  selection: string | null;
  method: string;
  replace: boolean;
}>({
  selection: null,
  method: "private_key",
  replace: false,
});
export const sshCredentialEditor$ = computed((get) => {
  return get(credentialEditor$);
});
export const chooseSshCredential$ = command(
  ({ get, set }, value: string | null) => {
    if (get(conflict$) === SSH_ERROR_CODES.CREDENTIAL_NOT_FOUND) {
      set(conflict$, null);
    }
    if (value === null) {
      return;
    }
    set(cancelSshPrivateKeyFile$);
    set(credentialEditor$, (current) => {
      return { ...current, selection: value };
    });
  },
);
export const chooseSshAuthMethod$ = command(({ set }, value: string) => {
  if (value !== "private_key" && value !== "password") {
    return;
  }
  set(cancelSshPrivateKeyFile$);
  set(credentialEditor$, (current) => {
    return { ...current, method: value };
  });
});
export const replaceSshAuthentication$ = command(
  ({ set }, replace: boolean) => {
    set(cancelSshPrivateKeyFile$);
    set(credentialEditor$, (current) => {
      return { ...current, replace };
    });
  },
);
export const sshCredentials$ = computed(async (get) => {
  get(reload$);
  if (!(await get(sshIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).credentials.list(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.credentials : null;
});
const conflict$ = state<string | null>(null);
const reviewedVersion$ = state<number | null>(null);
export const sshConflict$ = computed((get) => {
  return get(conflict$);
});
export const sshDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
  if (dialog?.kind.endsWith("-access") && !get(sshEnabled$)) {
    return null;
  }
  return dialog?.identity === (await get(sshIdentity$)) ? dialog : null;
});
export const sshConnections$ = computed(async (get) => {
  get(reload$);
  if (!(await get(sshIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).connections.list(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.connections : null;
});
export const sshSummary$ = computed(async (get) => {
  get(reload$);
  if (!(await get(sshIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).connections.summary(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body : null;
});
export const sshSingleConnectionName$ = computed(async (get) => {
  if ((await get(sshSummary$))?.configuredCount !== 1) {
    return null;
  }
  const connections = await get(sshConnections$);
  return connections?.length === 1 ? connections[0]?.displayName : null;
});
export const closeSshDialog$ = command(({ set }) => {
  set(cancelSshPrivateKeyFile$);
  set(conflict$, null);
  return set(dialog$, null);
});
export const sshObservationsSnapshot$ = computed(async (get) => {
  get(reload$);
  const identity = await get(sshIdentity$);
  if (!identity) {
    return { identity, observations: null };
  }
  const result = await accept(
    (await get(sshClients$)).connections.observations(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return {
    identity,
    observations: result.status === 200 ? result.body.observations : null,
  };
});
export const refreshSsh$ = command(({ set }) => {
  set(view$, "hosts");
  set(cancelSshPrivateKeyFile$);
  set(dialog$, null);
  set(conflict$, null);
  set(closeSshAccessManagement$);
  set(invalidateSsh$);
});

// Background changes must not discard an open credential form or dialog.
export const invalidateSsh$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

// Defaults belong to an untouched dialog, not to the reactive list. A failed
// list remains unknown; its load-error UI owns recovery through Retry.
const initializeSshSelection$ = command(
  async (
    { get, set },
    resource: "credential" | "access",
    signal: AbortSignal,
  ) => {
    const dialog = get(dialog$);
    if (!dialog || (dialog.kind !== "create" && dialog.kind !== "edit")) {
      return;
    }
    const result = await settle(
      waitForOperation<readonly { readonly id: string }[] | null>(
        resource === "credential"
          ? get(sshCredentials$)
          : get(sshCloudflareConfigs$),
        signal,
      ),
      signal,
    );
    const identity = await get(sshIdentity$);
    signal.throwIfAborted();
    if (get(dialog$) !== dialog || dialog.identity !== identity) {
      return;
    }
    if (!result.ok || result.value === null) {
      return;
    }
    const items = result.value;
    const selection =
      items.length === 0 ? "new" : items.length === 1 ? items[0]!.id : "";
    if (resource === "credential") {
      set(credentialEditor$, (current) => {
        return {
          ...current,
          selection: current.selection ?? selection,
        };
      });
    } else {
      set(transportEditor$, (current) => {
        return {
          ...current,
          configId: current.configId ?? selection,
        };
      });
    }
  },
);
const initializeSshSelections$ = command(
  async ({ set }, signal: AbortSignal) => {
    await Promise.all([
      set(initializeSshSelection$, "credential", signal),
      set(initializeSshSelection$, "access", signal),
    ]);
  },
);
export const retrySsh$ = command(async ({ set }, signal: AbortSignal) => {
  set(invalidateSsh$);
  await set(initializeSshSelections$, signal);
});

const catchUpSsh$ = command(({ set }) => {
  set(invalidateSsh$);
  return false;
});
const onSshChanged$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    const parsed = sshChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    if (org?.id === parsed.data.orgId) {
      set(invalidateSsh$);
    }
    return false;
  },
);
export const subscribeSshChanged$ = command(({ set }, signal: AbortSignal) => {
  set(
    setAblyPayloadLoop$,
    {
      topic: "ssh:changed",
      loopCommand$: onSshChanged$,
      initializeCommand$: catchUpSsh$,
      options: { runOnSubscribe: true },
    },
    signal,
  );
});
export const openSshDialog$ = command(
  async (
    { get, set },
    kind: "create" | "edit" | "delete" | "reset",
    connection: SshConnectionResponse | null,
    signal: AbortSignal,
  ) => {
    const identity = await get(sshIdentity$);
    signal.throwIfAborted();
    if (!identity) {
      return;
    }
    set(conflict$, null);
    set(reviewedVersion$, null);
    set(cancelSshPrivateKeyFile$);
    set(credentialEditor$, {
      selection: connection?.credentialId ?? null,
      method: "private_key",
      replace: false,
    });
    set(transportEditor$, {
      mode:
        connection && "transport" in connection
          ? "cloudflare_access"
          : "direct",
      configId:
        connection && "transport" in connection
          ? connection.transport.configId
          : null,
    });
    set(dialog$, {
      identity,
      kind,
      connection,
      credential: null,
      config: null,
    });
    // Render immediately; an optional Access list must not hold up page entry.
    setDaemon((ownerSignal) => {
      return set(initializeSshSelections$, ownerSignal);
    }, signal);
  },
);

export const openSshCredentialDialog$ = command(
  async (
    { get, set },
    kind: "create-credential" | "edit-credential" | "delete-credential",
    credential: SshCredentialResponse | null,
    signal: AbortSignal,
  ) => {
    const identity = await get(sshIdentity$);
    signal.throwIfAborted();
    if (!identity) {
      return;
    }
    set(conflict$, null);
    set(reviewedVersion$, null);
    set(cancelSshPrivateKeyFile$);
    set(credentialEditor$, {
      selection: "new",
      method: credential?.authMethod ?? "private_key",
      replace: false,
    });
    set(dialog$, {
      identity,
      kind,
      connection: null,
      credential,
      config: null,
    });
  },
);

export const openSshCloudflareDialog$ = command(
  async (
    { get, set },
    kind: "create-access" | "edit-access" | "delete-access",
    config: CloudflareAccessConfig | null,
    signal: AbortSignal,
  ) => {
    const identity = await get(sshIdentity$);
    signal.throwIfAborted();
    if (!identity || !get(sshEnabled$)) {
      return;
    }
    set(conflict$, null);
    set(reviewedVersion$, null);
    set(replaceAccessToken$, false);
    set(dialog$, {
      identity,
      kind,
      config,
      connection: null,
      credential: null,
    });
  },
);

function accessCredentialsFromForm(form: FormData) {
  return {
    clientId: textField(form, "clientId"),
    clientSecret: textField(form, "clientSecret"),
  };
}

async function updateAccessConfig(
  client: InitClientReturn<typeof cloudflareAccessContract, InitClientArgs>,
  dialog: SshDialogState,
  form: FormData,
  editor: {
    readonly reviewedRevision: number | null;
    readonly replace: boolean;
  },
  signal: AbortSignal,
): Promise<string | null> {
  const config = dialog.config;
  if (!config) {
    throw new Error("Access edit requires a configuration");
  }
  const params = { configId: config.id };
  const expectedRevision = editor.reviewedRevision ?? config.revision;
  if (dialog.kind === "delete-access") {
    const result = await accept(
      client.delete({
        params,
        body: { expectedRevision },
        fetchOptions: { signal },
      }),
      [204, 404, 409],
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
      body: {
        expectedRevision,
        ...(name !== config.name ? { name } : {}),
        ...(editor.replace
          ? { credentials: accessCredentialsFromForm(form) }
          : {}),
      },
      fetchOptions: { signal },
    }),
    [200, 404, 409],
    signal,
  );
  return result.status === 200 ? null : result.body.error.code;
}

export const saveSshCloudflare$ = command(
  async ({ get, set }, form: FormData, parentSignal: AbortSignal) => {
    const signal = set(resetAccessFormSave$, parentSignal);
    const dialog = await get(sshDialog$);
    signal.throwIfAborted();
    if (!dialog || !get(sshEnabled$)) {
      return;
    }
    const clients = await get(sshClients$);
    signal.throwIfAborted();
    if (clients.identity !== dialog.identity) {
      return;
    }
    let conflict: string | null = null;
    if (dialog.kind === "create-access") {
      await accept(
        clients.cloudflare.create({
          body: cloudflareAccessContract.create.body.parse({
            name: textField(form, "accessName"),
            credentials: accessCredentialsFromForm(form),
          }),
          fetchOptions: { signal },
        }),
        [201],
        signal,
      );
    } else {
      conflict = await updateAccessConfig(
        clients.cloudflare,
        dialog,
        form,
        {
          reviewedRevision: get(reviewedVersion$),
          replace: get(sshReplaceAccessToken$),
        },
        signal,
      );
    }
    signal.throwIfAborted();
    if (dialog.identity !== (await get(sshIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    set(invalidateSsh$);
    if (get(dialog$) !== dialog || !get(sshEnabled$)) {
      return;
    }
    if (conflict) {
      set(conflict$, conflict);
      return;
    }
    set(closeSshDialog$);
  },
);

export const sshConflictReview$ = computed(async (get) => {
  const dialog = await get(sshDialog$);
  const conflict = get(conflict$);
  if (
    !dialog ||
    (conflict !== SSH_ERROR_CODES.GENERATION_CONFLICT &&
      conflict !== SSH_ERROR_CODES.ACCESS_REVISION_CONFLICT &&
      conflict !== SSH_ERROR_CODES.ACCESS_IN_USE &&
      conflict !== SSH_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT &&
      conflict !== SSH_ERROR_CODES.CREDENTIAL_IN_USE)
  ) {
    return null;
  }
  if (dialog.config) {
    const config = (await get(sshCloudflareConfigs$))?.find((value) => {
      return value.id === dialog.config?.id;
    });
    return config ? { ...dialog, config } : null;
  }
  if (dialog.credential) {
    const credential = (await get(sshCredentials$))?.find((value) => {
      return value.id === dialog.credential?.id;
    });
    return credential ? { ...dialog, credential } : null;
  }
  if (dialog.connection) {
    const connection = (await get(sshConnections$))?.find((value) => {
      return value.id === dialog.connection?.id;
    });
    return connection ? { ...dialog, connection } : null;
  }
  return null;
});

export const acceptSshConflictReview$ = command(
  async ({ get, set }, reviewed: SshDialogState, signal: AbortSignal) => {
    const current = await get(sshDialog$);
    signal.throwIfAborted();
    if (
      !current ||
      reviewed.identity !== current.identity ||
      reviewed.kind !== current.kind ||
      reviewed.config?.id !== current.config?.id ||
      reviewed.credential?.id !== current.credential?.id ||
      reviewed.connection?.id !== current.connection?.id
    ) {
      return;
    }
    set(
      reviewedVersion$,
      reviewed.config?.revision ??
        reviewed.credential?.revision ??
        reviewed.connection?.generation ??
        null,
    );
    set(conflict$, null);
  },
);

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string") {
    throw new Error(`Missing SSH form field: ${name}`);
  }
  return value;
}

function authenticationFromForm(
  form: FormData,
  editor: { readonly method: string },
) {
  return editor.method === "password"
    ? { method: "password" as const, password: textField(form, "password") }
    : {
        method: "private_key" as const,
        privateKey: textField(form, "privateKey"),
        passphrase: textField(form, "passphrase") || null,
      };
}
function credentialFromForm(
  form: FormData,
  editor: { readonly method: string },
) {
  return createSshCredentialRequestSchema.parse({
    name: textField(form, "credentialName"),
    username: textField(form, "username"),
    authentication: authenticationFromForm(form, editor),
  });
}
async function saveCredentialForm(
  client: InitClientReturn<typeof sshCredentialsContract, InitClientArgs>,
  dialog: SshDialogState,
  form: FormData,
  editor: {
    readonly method: string;
    readonly replace: boolean;
    readonly reviewedRevision: number | null;
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (dialog.kind === "create-credential") {
    await accept(
      client.create({
        body: credentialFromForm(form, editor),
        fetchOptions: { signal },
      }),
      [201],
      signal,
    );
  } else if (
    dialog.kind === "edit-credential" ||
    dialog.kind === "delete-credential"
  ) {
    const credential = dialog.credential;
    if (!credential) {
      throw new Error("SSH credential editor requires a credential");
    }
    const params = { credentialId: credential.id };
    if (dialog.kind === "delete-credential") {
      const result = await accept(
        client.delete({
          params,
          body: {
            expectedRevision: editor.reviewedRevision ?? credential.revision,
          },
          fetchOptions: { signal },
        }),
        [204, 404, 409],
        signal,
      );
      return result.status === 204 ? null : result.body.error.code;
    }
    const name = textField(form, "credentialName").trim();
    const username = textField(form, "username").trim();
    if (
      name === credential.name &&
      username === credential.username &&
      !editor.replace
    ) {
      return null;
    }
    const body = updateSshCredentialRequestSchema.parse({
      expectedRevision: editor.reviewedRevision ?? credential.revision,
      ...(name !== credential.name ? { name } : {}),
      ...(username !== credential.username ? { username } : {}),
      ...(editor.replace
        ? { authentication: authenticationFromForm(form, editor) }
        : {}),
    });
    const result = await accept(
      client.update({
        params,
        body,
        fetchOptions: { signal },
      }),
      [200, 404, 409],
      signal,
    );
    return result.status === 200 ? null : result.body.error.code;
  }
  return null;
}

function hostFieldsFromForm(
  dialog: SshDialogState,
  form: FormData,
  editor: { readonly selection: string | null; readonly method: string },
  transport: { readonly mode: string; readonly configId: string | null },
) {
  if (dialog.kind !== "create" && dialog.kind !== "edit") {
    return undefined;
  }
  return {
    displayName: textField(form, "displayName"),
    host: textField(form, "host"),
    port:
      transport.mode === "cloudflare_access"
        ? 443
        : Number(textField(form, "port")),
    transport:
      transport.mode === "cloudflare_access"
        ? {
            type: "cloudflare_access",
            ...(transport.configId === "new"
              ? {
                  create: {
                    name: textField(form, "accessName"),
                    credentials: accessCredentialsFromForm(form),
                  },
                }
              : { configId: transport.configId }),
          }
        : { type: "direct" },
    credential:
      editor.selection === "new"
        ? { create: credentialFromForm(form, editor) }
        : { id: editor.selection },
  };
}

export const saveSsh$ = command(
  async ({ get, set }, form: FormData, parentSignal: AbortSignal) => {
    const signal = set(resetFormSave$, parentSignal);
    const dialog = await get(sshDialog$);
    signal.throwIfAborted();
    if (!dialog) {
      return;
    }
    const clients = await get(sshClients$);
    signal.throwIfAborted();
    if (clients.identity !== dialog.identity) {
      return;
    }
    const editor = get(credentialEditor$);
    let conflicted: string | null = null;
    if (
      ["create-credential", "edit-credential", "delete-credential"].includes(
        dialog.kind,
      )
    ) {
      conflicted = await saveCredentialForm(
        clients.credentials,
        dialog,
        form,
        { ...editor, reviewedRevision: get(reviewedVersion$) },
        signal,
      );
    } else {
      const client = clients.connections;
      const transport = get(transportEditor$);
      const fields = hostFieldsFromForm(dialog, form, editor, transport);
      if (dialog.kind === "create") {
        const body = createSshConnectionRequestSchema.parse(fields);
        const result = await accept(
          client.create({ body, fetchOptions: { signal } }),
          [201, 404],
          signal,
        );
        conflicted = result.status === 201 ? null : result.body.error.code;
      } else {
        const connection = dialog.connection;
        if (!connection) {
          throw new Error("SSH edit requires a connection");
        }
        const params = { connectionId: connection.id };
        if (dialog.kind === "delete") {
          await accept(
            client.delete({ params, fetchOptions: { signal } }),
            [204],
            signal,
          );
        } else if (dialog.kind === "reset") {
          const result = await accept(
            client.resetHostKey({
              params,
              body: {
                expectedGeneration:
                  get(reviewedVersion$) ?? connection.generation,
              },
              fetchOptions: { signal },
            }),
            [200, 409],
            signal,
          );
          conflicted = result.status === 409 ? result.body.error.code : null;
        } else {
          const body = updateSshConnectionRequestSchema.parse({
            expectedGeneration: get(reviewedVersion$) ?? connection.generation,
            ...fields,
          });
          const result = await accept(
            client.update({ params, body, fetchOptions: { signal } }),
            [200, 404, 409],
            signal,
          );
          conflicted = result.status === 200 ? null : result.body.error.code;
        }
      }
    }
    signal.throwIfAborted();
    if (dialog.identity !== (await get(sshIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    if (get(dialog$) !== dialog) {
      return;
    }
    if (!conflicted) {
      set(dialog$, null);
    }
    set(conflict$, conflicted);
    set(reload$, (value) => {
      return value + 1;
    });
  },
);

export const currentAgentSshAccess$ = computed(async (get) => {
  get(reload$);
  const identity = await get(sshIdentity$);
  if (!identity) {
    return null;
  }
  const [agent, summary] = await Promise.all([
    get(currentAgent$),
    get(sshSummary$),
  ]);
  if (!agent || !summary || summary.configuredCount === 0) {
    return null;
  }
  const result = await accept(
    (await get(sshClients$)).access.get({
      params: { agentId: agent.agentId },
    }),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200
    ? { identity, agentId: agent.agentId, ...result.body }
    : null;
});
export const updateAgentSshAccess$ = command(
  async (
    { get, set },
    agentId: string,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
    const clients = await get(sshClients$);
    signal.throwIfAborted();
    const [summary, visibleAgents] = await Promise.all([
      get(sshSummary$),
      get(agents$),
    ]);
    signal.throwIfAborted();
    if (
      !summary ||
      summary.configuredCount === 0 ||
      !visibleAgents.some((agent) => {
        return agent.agentId === agentId;
      })
    ) {
      return;
    }
    await accept(
      clients.access.update({
        params: { agentId },
        body: { enabled },
        fetchOptions: { signal },
      }),
      [200],
      signal,
    );
    signal.throwIfAborted();
    if (clients.identity !== (await get(sshIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    set(invalidateSsh$);
  },
);

export const sshAgentAccessRows$ = computed(async (get) => {
  const summary = await get(sshSummary$);
  if (!summary) {
    return null;
  }
  if (summary.configuredCount === 0) {
    return [];
  }
  const [visibleAgents, clients] = await Promise.all([
    get(agents$),
    get(sshClients$),
  ]);
  const rows = await Promise.all(
    visibleAgents.map(async (agent) => {
      const result = await accept(
        clients.access.get({ params: { agentId: agent.agentId } }),
        [200, 404],
        undefined,
        { showErrorToast: false },
      );
      return result.status === 200
        ? { agent, enabled: result.body.enabled }
        : null;
    }),
  );
  return rows.filter((row) => {
    return row !== null;
  });
});

// Keep the owner attached when views retain this read during a background refresh.
export const sshAgentAccessSnapshot$ = computed(async (get) => {
  const [identity, rows] = await Promise.all([
    get(sshIdentity$),
    get(sshAgentAccessRows$),
  ]);
  return { identity, rows };
});

const accessManagementIdentity$ = state<string | null>(null);
const accessSearch$ = state("");
export const sshAccessSearch$ = computed((get) => {
  return get(accessSearch$);
});
export const searchSshAccess$ = command(({ set }, value: string) => {
  return set(accessSearch$, value);
});
export const sshAccessManagementOpen$ = computed(async (get) => {
  const identity = get(accessManagementIdentity$);
  return identity !== null && identity === (await get(sshIdentity$));
});
export const closeSshAccessManagement$ = command(({ set }) => {
  set(accessManagementIdentity$, null);
  set(accessSearch$, "");
});
export const openSshAccessManagement$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const identity = await get(sshIdentity$);
    signal.throwIfAborted();
    set(accessManagementIdentity$, identity);
    set(accessSearch$, "");
    set(invalidateSsh$);
  },
);
