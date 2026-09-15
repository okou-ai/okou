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
export const mountSshForm$ = onRef(
  command(({ set }, form: HTMLFormElement, signal: AbortSignal) => {
    signal.addEventListener("abort", () => {
      form.reset();
      set(cancelSshPrivateKeyFile$);
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
  const enabled = get(featureSwitch$)[FeatureSwitchKey.SshAccess];
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
    | "delete-credential";
  readonly credential: SshCredentialResponse | null;
  readonly connection: SshConnectionResponse | null;
}
const dialog$ = state<SshDialogState | null>(null);
const view$ = state<"hosts" | "credentials">("hosts");
export const sshView$ = computed((get) => {
  return get(view$);
});
export const changeSshView$ = command(({ set }, value: string) => {
  if (value === "hosts" || value === "credentials") {
    set(view$, value);
  }
});
const credentialEditor$ = state({
  selection: "new",
  method: "private_key",
  replace: false,
});
export const sshCredentialEditor$ = computed((get) => {
  return get(credentialEditor$);
});
export const chooseSshCredential$ = command(({ set }, value: string | null) => {
  if (value === null) {
    return;
  }
  set(cancelSshPrivateKeyFile$);
  set(credentialEditor$, (current) => {
    return { ...current, selection: value };
  });
});
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
export const sshConflict$ = computed((get) => {
  return get(conflict$);
});
export const sshDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
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
      catchUpCommand$: catchUpSsh$,
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
    set(cancelSshPrivateKeyFile$);
    set(credentialEditor$, {
      selection: connection?.credentialId ?? "new",
      method: "private_key",
      replace: false,
    });
    set(dialog$, { identity, kind, connection, credential: null });
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
    set(cancelSshPrivateKeyFile$);
    set(credentialEditor$, {
      selection: "new",
      method: credential?.authMethod ?? "private_key",
      replace: false,
    });
    set(dialog$, { identity, kind, connection: null, credential });
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
  editor: { readonly method: string; readonly replace: boolean },
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
          body: { expectedRevision: credential.revision },
          fetchOptions: { signal },
        }),
        [204, 404, 409],
        signal,
      );
      return result.status === 204 ? null : result.body.error.code;
    }
    const body = updateSshCredentialRequestSchema.parse({
      expectedRevision: credential.revision,
      name: textField(form, "credentialName"),
      username: textField(form, "username"),
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

export const saveSsh$ = command(
  async ({ get, set }, form: FormData, signal: AbortSignal) => {
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
        editor,
        signal,
      );
    } else {
      const client = clients.connections;
      const fields =
        dialog.kind === "create" || dialog.kind === "edit"
          ? {
              displayName: textField(form, "displayName"),
              host: textField(form, "host"),
              port: Number(textField(form, "port")),
              credential:
                editor.selection === "new"
                  ? { create: credentialFromForm(form, editor) }
                  : { id: editor.selection },
            }
          : undefined;
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
              body: { expectedGeneration: connection.generation },
              fetchOptions: { signal },
            }),
            [200, 409],
            signal,
          );
          conflicted = result.status === 409 ? result.body.error.code : null;
        } else {
          const body = updateSshConnectionRequestSchema.parse({
            expectedGeneration: connection.generation,
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
    set(dialog$, null);
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
