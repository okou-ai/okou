import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { resetRemoteLogin$ } from "./remote-login.ts";
import type {
  InitClientReturn,
  InitClientArgs,
} from "@okouai/api-contracts/client/types";
import { command, computed, state } from "ccstate";
import { sshCredentialsContract } from "@okouai/api-contracts/client/ssh-credentials";
import {
  createSshCredentialRequestSchema,
  updateSshCredentialRequestSchema,
  SSH_PRIVATE_KEY_MAX_LENGTH,
} from "@okouai/api-contracts/validators/ssh-credentials";
import type { SshCredentialResponse } from "@okouai/api-contracts/contracts/ssh-credentials";
import { SSH_ERROR_CODES } from "@okouai/api-contracts/contracts/ssh-errors";
import { CLOUDFLARE_ACCESS_ERROR_CODES } from "@okouai/api-contracts/contracts/cloudflare-access-errors";
import { TAILSCALE_ERROR_CODES } from "@okouai/api-contracts/contracts/tailscale-errors";
import {
  invalidateRemoteAccess$,
  invalidateVncObservationConfiguration$,
  remoteHostDefaultsReload$,
} from "./remote-access-refresh.ts";
import {
  invalidateTailscale$,
  tailscaleConfigs$,
  tailscaleFieldsFromForm,
} from "./tailscale.ts";
import { sshConnectionsContract } from "@okouai/api-contracts/client/ssh-connections";
import type {
  SshConnectionResponse,
  SshConnectionMode,
} from "@okouai/api-contracts/contracts/ssh-connections";
import {
  createSshConnectionRequestSchema,
  updateSshConnectionRequestSchema,
} from "@okouai/api-contracts/validators/ssh-connections";
import { authenticatedSessionKey$, clerk$, user$ } from "./auth.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import { apiClient$ } from "./api-client.ts";
import {
  cloudflareAccessConfigs$,
  invalidateCloudflareAccess$,
} from "./cloudflare-access.ts";
import { i18n } from "../i18n/index.ts";
import { accept } from "../lib/accept.ts";
import { sortByName, sortRemoteHosts } from "../lib/remote-resource-order.ts";
import { locale$ } from "./locale.ts";
import {
  createDeferredPromise,
  detach,
  onRef,
  Reason,
  resetSignal,
  settle,
  withCleanup,
} from "./utils.ts";

type PrivateKeyFileError = "size";
const resetPrivateKeyRead$ = resetSignal();
export const cancelSshPrivateKeyFile$ = command(({ set }) => {
  set(resetPrivateKeyRead$);
});
const resetFormSave$ = resetSignal();
export const mountSshForm$ = onRef(
  command(({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const mounted = get(dialog$);
    signal.addEventListener("abort", () => {
      form.reset();
      if (get(dialog$)?.instanceId === mounted?.instanceId) {
        set(resetFormSave$);
        set(abandonSshSave$);
        set(cancelSshPrivateKeyFile$);
      }
    });
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

export const importSshPrivateKeyFile$ = command(
  async (
    { set },
    input: HTMLInputElement | null,
    parentSignal: AbortSignal,
  ): Promise<PrivateKeyFileError | null> => {
    set(cancelSshPrivateKeyFile$);
    const file = input?.files?.[0];
    if (input) {
      input.value = "";
    }
    if (!file || !input) {
      return null;
    }
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
    // Keep native form validation active while replacing an optional existing key.
    privateKey.setCustomValidity(
      i18n.t(($) => {
        return $.ssh.fileReading;
      }),
    );
    const clearReadConstraint = () => {
      return privateKey.setCustomValidity("");
    };
    signal.addEventListener("abort", clearReadConstraint, { once: true });
    const aborted = createDeferredPromise<never>(signal);
    // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
    const result = await withCleanup(
      // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
      settle(Promise.race([file.text(), aborted.promise]), signal),
      () => {
        signal.removeEventListener("abort", clearReadConstraint);
        if (!signal.aborted) {
          clearReadConstraint();
        }
        if (!aborted.settled()) {
          aborted.reject(new DOMException("File read finished", "AbortError"));
        }
      },
    );
    signal.throwIfAborted();
    if (!result.ok) {
      throw result.error;
    }
    if (result.value.length === 0) {
      return "size";
    }
    privateKey.value = result.value;
    return null;
  },
);

export const sshIdentity$ = computed(async (get) => {
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
    credentials: createClient(sshCredentialsContract, options),
  };
});
export interface SshDialogState {
  readonly instanceId: string;
  readonly identity: string;
  readonly sessionKey: string | null;
  readonly kind:
    | "create"
    | "edit"
    | "delete"
    | "reset"
    | "create-credential"
    | "edit-credential"
    | "delete-credential";
  readonly credential: SshCredentialResponse | null;
  readonly loginCredential?: SshCredentialResponse;
  readonly connectionSaved?: boolean;
  readonly connection: SshConnectionResponse | null;
}
const dialog$ = state<SshDialogState | null>(null);
// Only a non-secret resource ID survives a failed create. Secrets remain in
// the mounted form while an unconfirmed write keeps this operation blocked.
const unresolvedSave$ = state<{
  readonly dialog: SshDialogState;
  readonly id: string | null;
} | null>(null);
const saveMessage$ = state<string | null>(null);
export const sshSaveMessage$ = computed((get) => {
  return get(saveMessage$);
});
export const sshSaveUncertain$ = computed((get) => {
  const attempt = get(unresolvedSave$);
  return attempt !== null && attempt.dialog === get(dialog$);
});
const abandonSshSave$ = command(({ set }) => {
  set(unresolvedSave$, null);
  set(saveMessage$, null);
});

const beginSshSave$ = command(
  ({ set }, dialog: SshDialogState, id: string | null) => {
    set(saveMessage$, null);
    set(unresolvedSave$, { dialog, id });
  },
);
const finishSshSave$ = command(
  (
    { get, set },
    dialog: SshDialogState,
    result:
      | { readonly status: 200 }
      | { readonly status: 201 }
      | { readonly status: 204 }
      | {
          readonly status: 400 | 404 | 409 | 500;
          readonly body: { readonly error: { readonly code: string } };
        },
  ) => {
    if (get(dialog$) !== dialog) {
      return false;
    }
    if (
      result.status === 200 ||
      result.status === 201 ||
      result.status === 204
    ) {
      set(unresolvedSave$, null);
      return true;
    }
    if (result.status === 500) {
      return false;
    }
    set(unresolvedSave$, null);
    if (result.status === 400) {
      set(saveMessage$, result.body.error.code);
    } else {
      set(conflict$, result.body.error.code);
    }
    return false;
  },
);

const connectionModeEditor$ = state<{
  mode: SshConnectionMode;
  configId: string | null;
  tailscaleConfigId: string | null;
}>({
  mode: "direct",
  configId: null,
  tailscaleConfigId: null,
});
export const sshConnectionModeEditor$ = computed((get) => {
  return get(connectionModeEditor$);
});
export const chooseSshConnectionMode$ = command(
  ({ get, set }, mode: SshConnectionMode) => {
    set(connectionModeEditor$, (current) => {
      return { ...current, mode };
    });
    const conflict = get(conflict$);
    if (
      conflict === CLOUDFLARE_ACCESS_ERROR_CODES.NOT_FOUND ||
      conflict === TAILSCALE_ERROR_CODES.NOT_FOUND ||
      (mode === "direct" &&
        conflict === CLOUDFLARE_ACCESS_ERROR_CODES.UNAVAILABLE)
    ) {
      set(conflict$, null);
    }
  },
);
export const chooseSshTailscaleConfig$ = command(
  ({ get, set }, configId: string | null) => {
    if (
      configId === null ||
      get(connectionModeEditor$).tailscaleConfigId === configId
    ) {
      return;
    }
    set(connectionModeEditor$, (current) => {
      return {
        ...current,
        tailscaleConfigId: configId,
      };
    });
    if (get(conflict$) === TAILSCALE_ERROR_CODES.NOT_FOUND) {
      set(conflict$, null);
    }
  },
);
export const chooseSshAccessConfig$ = command(
  ({ get, set }, configId: string | null) => {
    if (configId !== null && configId !== get(connectionModeEditor$).configId) {
      set(connectionModeEditor$, (current) => {
        return { ...current, configId };
      });
      if (get(conflict$) === CLOUDFLARE_ACCESS_ERROR_CODES.NOT_FOUND) {
        set(conflict$, null);
      }
    }
  },
);
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
    if (value === null || value === get(credentialEditor$).selection) {
      return;
    }
    if (get(conflict$) === SSH_ERROR_CODES.CREDENTIAL_NOT_FOUND) {
      set(conflict$, null);
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
const sshCredentialsData$ = computed(async (get) => {
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
export const sshCredentials$ = computed(async (get) => {
  const locale = get(locale$);
  const credentials = await get(sshCredentialsData$);
  return credentials
    ? sortByName(
        credentials.map((credential) => {
          return {
            ...credential,
            hosts: sortRemoteHosts(credential.hosts, locale),
          };
        }),
        locale,
        (credential) => {
          return { name: credential.name, id: credential.id };
        },
      )
    : null;
});
const conflict$ = state<string | null>(null);
export const sshConflict$ = computed((get) => {
  return get(conflict$);
});
export const sshDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
  if (!dialog || dialog.sessionKey !== get(authenticatedSessionKey$)) {
    return null;
  }
  return dialog?.identity === (await get(sshIdentity$)) ? dialog : null;
});
const sshConnectionsData$ = computed(async (get) => {
  get(reload$);
  get(remoteHostDefaultsReload$);
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
export const sshConnections$ = computed(async (get) => {
  const locale = get(locale$);
  const connections = await get(sshConnectionsData$);
  return connections ? sortRemoteHosts(connections, locale) : null;
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
export const closeSshDialog$ = command(({ set }) => {
  set(resetRemoteLogin$);
  set(resetFormSave$);
  set(abandonSshSave$);
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
  set(abandonSshSave$);
  set(cancelSshPrivateKeyFile$);
  set(dialog$, null);
  set(conflict$, null);
  set(invalidateSsh$);
  set(invalidateCloudflareAccess$);
  set(invalidateTailscale$);
});

// Background changes must not discard an open credential form or dialog.
export const invalidateSsh$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
  set(invalidateVncObservationConfiguration$);
  set(invalidateRemoteAccess$);
});

// Defaults belong to an untouched dialog, not to the reactive list. A failed
// list remains unknown until its normal resource notification updates it.
const initializeSshSelection$ = command(
  async (
    { get, set },
    resource: "credential" | "access" | "tailscale",
    signal: AbortSignal,
  ) => {
    const dialog = get(dialog$);
    if (!dialog || (dialog.kind !== "create" && dialog.kind !== "edit")) {
      return;
    }
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const result = await settle<readonly { readonly id: string }[] | null>(
      resource === "credential"
        ? get(sshCredentials$)
        : resource === "tailscale"
          ? get(tailscaleConfigs$)
          : get(cloudflareAccessConfigs$),
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
    const allowCreate =
      resource === "credential" ||
      !get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup];
    const selection =
      items.length === 0
        ? allowCreate
          ? "new"
          : ""
        : items.length === 1
          ? items[0]!.id
          : "";
    if (resource === "credential") {
      set(credentialEditor$, (current) => {
        return {
          ...current,
          selection: current.selection ?? selection,
        };
      });
    } else if (resource === "tailscale") {
      set(connectionModeEditor$, (current) => {
        return {
          ...current,
          tailscaleConfigId: current.tailscaleConfigId ?? selection,
        };
      });
    } else {
      set(connectionModeEditor$, (current) => {
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
      set(initializeSshSelection$, "tailscale", signal),
    ]);
  },
);
export function usesTailscaleNetwork(
  connection: SshConnectionResponse | null | undefined,
) {
  return (
    connection !== null &&
    connection !== undefined &&
    "transport" in connection &&
    (connection.transport.type === "tailscale" ||
      connection.transport.type === "tailscale_ssh")
  );
}

function initialSshConnectionMode(connection: SshConnectionResponse | null): {
  mode: SshConnectionMode;
  configId: string | null;
  tailscaleConfigId: string | null;
} {
  return {
    mode:
      connection && "transport" in connection
        ? connection.transport.type
        : "direct",
    configId:
      connection &&
      "transport" in connection &&
      connection.transport.type === "cloudflare_access"
        ? "configId" in connection.transport
          ? connection.transport.configId
          : ""
        : null,
    tailscaleConfigId:
      connection &&
      "transport" in connection &&
      (connection.transport.type === "tailscale" ||
        connection.transport.type === "tailscale_ssh")
        ? "configId" in connection.transport
          ? connection.transport.configId
          : ""
        : null,
  };
}

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
    const loginCredential =
      kind === "edit" &&
      connection &&
      "credentialId" in connection &&
      get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup]
        ? (await get(sshCredentials$))?.find((credential) => {
            return credential.id === connection.credentialId;
          })
        : undefined;
    signal.throwIfAborted();
    if (identity !== (await get(sshIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    set(resetRemoteLogin$);
    set(conflict$, null);
    set(cancelSshPrivateKeyFile$);
    set(credentialEditor$, {
      selection:
        connection && "credentialId" in connection
          ? connection.credentialId
          : null,
      method: loginCredential?.authMethod ?? "private_key",
      replace: false,
    });
    set(connectionModeEditor$, initialSshConnectionMode(connection));
    set(dialog$, {
      instanceId: crypto.randomUUID(),
      identity,
      sessionKey: get(authenticatedSessionKey$),
      kind,
      connection,
      credential: null,
      ...(loginCredential ? { loginCredential } : {}),
    });
    // Render immediately; an optional Access list must not hold up page entry.
    detach(
      set(initializeSshSelections$, signal),
      Reason.Daemon,
      "ssh selections",
    );
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
    set(resetRemoteLogin$);
    set(conflict$, null);
    set(cancelSshPrivateKeyFile$);
    set(credentialEditor$, {
      selection: "new",
      method: credential?.authMethod ?? "private_key",
      replace: false,
    });
    set(dialog$, {
      instanceId: crypto.randomUUID(),
      identity,
      sessionKey: get(authenticatedSessionKey$),
      kind,
      connection: null,
      credential,
    });
  },
);

function accessCredentialsFromForm(form: HTMLFormElement) {
  return {
    clientId: textField(form, "clientId"),
    clientSecret: textField(form, "clientSecret"),
  };
}

function textField(form: HTMLFormElement, name: string): string {
  const field = form.elements.namedItem(name);
  if (!(
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement
  )) {
    throw new Error(`Missing SSH form field: ${name}`);
  }
  // FormData omits disabled controls, but an uncertain draft must stay frozen.
  return field.value;
}

function authenticationFromForm(
  form: HTMLFormElement,
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
export function sshLoginPatch(
  form: HTMLFormElement,
  credential: SshCredentialResponse,
  method: string,
) {
  const username = textField(form, "username").trim();
  const material = textField(
    form,
    method === "password" ? "password" : "privateKey",
  );
  const replace = method !== credential.authMethod || material.length > 0;
  if (!replace && username === credential.username) {
    return null;
  }
  return updateSshCredentialRequestSchema.safeParse({
    expectedRevision: credential.revision,
    ...(username !== credential.username ? { username } : {}),
    ...(replace
      ? { authentication: authenticationFromForm(form, { method }) }
      : {}),
  });
}

function credentialFromForm(
  form: HTMLFormElement,
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
  form: HTMLFormElement,
  editor: {
    readonly method: string;
    readonly replace: boolean;
  },
  signal: AbortSignal,
): Promise<string | null> {
  if (
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
            expectedRevision: credential.revision,
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
      expectedRevision: credential.revision,
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
  form: HTMLFormElement,
  editor: { readonly selection: string | null; readonly method: string },
  connectionEditor: {
    readonly mode: SshConnectionMode;
    readonly configId: string | null;
    readonly tailscaleConfigId: string | null;
  },
) {
  if (dialog.kind !== "create" && dialog.kind !== "edit") {
    return undefined;
  }
  return {
    displayName: textField(form, "displayName"),
    host: textField(form, "host"),
    port:
      connectionEditor.mode === "cloudflare_access"
        ? 443
        : connectionEditor.mode === "tailscale_ssh"
          ? 22
          : Number(textField(form, "port")),
    transport:
      connectionEditor.mode === "cloudflare_access"
        ? {
            type: "cloudflare_access",
            ...(connectionEditor.configId === "new"
              ? {
                  create: {
                    name: textField(form, "accessName"),
                    credentials: accessCredentialsFromForm(form),
                  },
                }
              : { configId: connectionEditor.configId }),
          }
        : connectionEditor.mode === "tailscale" ||
            connectionEditor.mode === "tailscale_ssh"
          ? {
              type: connectionEditor.mode,
              ...(connectionEditor.tailscaleConfigId === "new"
                ? { create: tailscaleFieldsFromForm(form) }
                : { configId: connectionEditor.tailscaleConfigId }),
            }
          : { type: "direct" },
    ...(connectionEditor.mode === "tailscale_ssh"
      ? { username: textField(form, "tailscaleSshUsername") }
      : {
          credential:
            editor.selection === "new"
              ? { create: credentialFromForm(form, editor) }
              : { id: editor.selection },
        }),
  };
}

const invalidateAfterSshSave$ = command(
  ({ set }, kind: SshDialogState["kind"]) => {
    set(reload$, (value) => {
      return value + 1;
    });
    set(invalidateVncObservationConfiguration$);
    if (kind === "create" || kind === "edit" || kind === "delete") {
      set(invalidateCloudflareAccess$);
      set(invalidateTailscale$);
    }
  },
);

const deleteSshHost$ = command(
  async (
    { get },
    client: InitClientReturn<typeof sshConnectionsContract, InitClientArgs>,
    connection: SshConnectionResponse,
    signal: AbortSignal,
  ) => {
    if (get(conflict$)) {
      return false;
    }
    const result = await accept(
      client.delete({
        params: { connectionId: connection.id },
        body: {
          expectedGeneration: connection.generation,
        },
        fetchOptions: { signal },
      }),
      [204, 404, 409],
      signal,
    );
    return result.status === 204 ? null : result.body.error.code;
  },
);

const saveSshHost$ = command(
  async (
    { get, set },
    dialog: SshDialogState,
    form: HTMLFormElement,
    signal: AbortSignal,
  ) => {
    const clients = await get(sshClients$);
    signal.throwIfAborted();
    if (
      clients.identity !== dialog.identity ||
      get(dialog$) !== dialog ||
      dialog.sessionKey !== get(authenticatedSessionKey$)
    ) {
      return false;
    }
    const editor = get(credentialEditor$);
    let conflicted: string | null = null;
    const client = clients.connections;
    const connectionEditor = get(connectionModeEditor$);
    const fields = hostFieldsFromForm(dialog, form, editor, connectionEditor);
    if (dialog.kind === "create") {
      const id = crypto.randomUUID();
      const parsed = createSshConnectionRequestSchema.safeParse({
        ...fields,
        id,
      });
      if (!parsed.success) {
        set(saveMessage$, SSH_ERROR_CODES.INVALID_INPUT);
        return false;
      }
      const body = parsed.data;
      set(beginSshSave$, dialog, id);
      const result = await accept(
        client.create({ body, fetchOptions: { signal } }),
        [201, 204, 400, 404, 409, 500],
        signal,
      );
      if (!set(finishSshSave$, dialog, result)) {
        return false;
      }
      return {
        savedId: result.status === 201 ? result.body.id : id,
        connection: null,
      };
    }
    const connection = dialog.connection;
    if (!connection) {
      throw new Error("SSH edit requires a connection");
    }
    const params = { connectionId: connection.id };
    if (dialog.kind === "delete") {
      return await set(deleteSshHost$, client, connection, signal);
    } else if (dialog.kind === "reset") {
      const result = await accept(
        client.resetHostKey({
          params,
          body: {
            expectedGeneration: connection.generation,
          },
          fetchOptions: { signal },
        }),
        [200, 409],
        signal,
      );
      conflicted = result.status === 409 ? result.body.error.code : null;
    } else {
      const parsed = updateSshConnectionRequestSchema.safeParse({
        expectedGeneration: connection.generation,
        ...fields,
      });
      if (!parsed.success) {
        set(saveMessage$, SSH_ERROR_CODES.INVALID_INPUT);
        return false;
      }
      const body = parsed.data;
      set(beginSshSave$, dialog, null);
      const result = await accept(
        client.update({ params, body, fetchOptions: { signal } }),
        [200, 400, 404, 409, 500],
        signal,
      );
      if (!set(finishSshSave$, dialog, result)) {
        return false;
      }
      if (result.status === 200) {
        return { savedId: result.body.id, connection: result.body };
      }
    }

    return conflicted;
  },
);

const prepareSshFormSave$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const dialog = await get(sshDialog$);
    signal.throwIfAborted();
    if (!dialog || get(sshSaveUncertain$)) {
      return;
    }
    const clients = await get(sshClients$);
    signal.throwIfAborted();
    if (clients.identity !== dialog.identity) {
      return;
    }
    const editor = get(credentialEditor$);
    if (
      (dialog.kind === "create" || dialog.kind === "edit") &&
      editor.selection === "new" &&
      get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup]
    ) {
      const name = form.elements.namedItem("credentialName");
      if (name instanceof HTMLInputElement) {
        name.value = textField(form, "displayName").trim();
      }
    }
    const login =
      dialog.kind === "edit" &&
      dialog.loginCredential &&
      get(connectionModeEditor$).mode !== "tailscale_ssh" &&
      editor.selection === dialog.loginCredential.id &&
      get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup]
        ? sshLoginPatch(form, dialog.loginCredential, editor.method)
        : null;
    if (login && !login.success) {
      set(saveMessage$, SSH_ERROR_CODES.INVALID_INPUT);
      return;
    }
    return { dialog, clients, editor, login };
  },
);

export const saveSsh$ = command(
  async ({ get, set }, form: HTMLFormElement, parentSignal: AbortSignal) => {
    const signal = set(resetFormSave$, parentSignal);
    const prepared = await set(prepareSshFormSave$, form, signal);
    signal.throwIfAborted();
    if (!prepared) {
      return;
    }
    const { dialog, clients, editor, login } = prepared;
    let savedConnectionId = dialog.connection?.id;
    let activeDialog = dialog;
    let conflicted: string | null = null;
    if (dialog.kind === "create-credential") {
      const id = crypto.randomUUID();
      const body = { ...credentialFromForm(form, editor), id };
      set(beginSshSave$, dialog, id);
      const result = await accept(
        clients.credentials.create({ body, fetchOptions: { signal } }),
        [201, 204, 400, 404, 409, 500],
        signal,
      );
      if (!set(finishSshSave$, dialog, result)) {
        return;
      }
    } else if (["edit-credential", "delete-credential"].includes(dialog.kind)) {
      conflicted = await saveCredentialForm(
        clients.credentials,
        dialog,
        form,
        editor,
        signal,
      );
    } else {
      const result = await set(saveSshHost$, dialog, form, signal);
      if (result === false) {
        return;
      }
      if (typeof result === "object" && result !== null) {
        savedConnectionId = result.savedId;
        if (login?.success && dialog.loginCredential && result.connection) {
          activeDialog = {
            ...dialog,
            connection: result.connection,
            connectionSaved: true,
          };
          set(dialog$, activeDialog);
          set(beginSshSave$, activeDialog, null);
          const savedLogin = await accept(
            clients.credentials.update({
              params: { credentialId: dialog.loginCredential.id },
              body: login.data,
              fetchOptions: { signal },
            }),
            [200, 400, 404, 409, 500],
            signal,
          );
          signal.throwIfAborted();
          if (!set(finishSshSave$, activeDialog, savedLogin)) {
            return;
          }
        }
      } else {
        conflicted = result;
      }
    }
    signal.throwIfAborted();
    if (dialog.identity !== (await get(sshIdentity$))) {
      return;
    }
    signal.throwIfAborted();
    if (get(dialog$) !== activeDialog) {
      return;
    }
    if (!conflicted) {
      set(dialog$, null);
      set(invalidateAfterSshSave$, dialog.kind);
    }
    set(conflict$, conflicted);
    return conflicted ? undefined : savedConnectionId;
  },
);
