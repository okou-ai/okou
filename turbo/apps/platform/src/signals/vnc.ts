import { command, computed, state } from "ccstate";
import type {
  InitClientReturn,
  InitClientArgs,
} from "@okouai/api-contracts/contracts/trpc-contract";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  vncConnectionsContract,
  createVncConnectionRequestSchema,
  updateVncConnectionRequestSchema,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import {
  vncCredentialsContract,
  createVncCredentialRequestSchema,
  updateVncCredentialRequestSchema,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import { agentVncAccessContract } from "@okouai/api-contracts/contracts/vnc-access";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import { accept } from "../lib/accept.ts";
import { authenticatedSessionKey$, clerk$, user$ } from "./auth.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import { apiClient$ } from "./api-client.ts";
import { reloadAgents$, reloadAgentById$ } from "./agent.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { onRef, resetSignal, settle, waitForOperation } from "./utils.ts";

export const vncIdentity$ = computed(async (get) => {
  if (!get(featureSwitch$)[FeatureSwitchKey.VncAccess]) {
    return null;
  }
  const [user, identity] = await Promise.all([
    get(user$),
    get(runtimeAuthenticatedIdentity$),
  ]);
  return user ? `${identity.orgId}:${user.id}` : null;
});

export const vncClients$ = computed(async (get) => {
  const [identity, clerk] = await Promise.all([get(vncIdentity$), get(clerk$)]);
  const createClient = get(apiClient$);
  const getSession = () => {
    const session = clerk.session;
    if (
      !identity ||
      !get(featureSwitch$)[FeatureSwitchKey.VncAccess] ||
      !session ||
      identity !== `${clerk.organization?.id}:${clerk.user?.id}`
    ) {
      throw new DOMException("VNC owner changed", "AbortError");
    }
    return session;
  };
  const getTokenGuard = () => {
    const session = getSession();
    return () => {
      if (getSession().id !== session.id) {
        throw new DOMException("VNC owner changed", "AbortError");
      }
    };
  };
  const options = { getTokenGuard };
  return {
    identity,
    connections: createClient(vncConnectionsContract, options),
    credentials: createClient(vncCredentialsContract, options),
    access: createClient(agentVncAccessContract, options),
  };
});

const reload$ = state(0);
export const invalidateVnc$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
});

export const retryVnc$ = command(({ set }) => {
  // Grant views also depend on shared Agent data that may have failed to load.
  set(reloadAgents$);
  set(reloadAgentById$);
  set(invalidateVnc$);
});

export const vncConnections$ = computed(async (get) => {
  get(reload$);
  if (!(await get(vncIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(vncClients$)).connections.list(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.connections : null;
});

export const vncCredentials$ = computed(async (get) => {
  get(reload$);
  if (!(await get(vncIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(vncClients$)).credentials.list(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.credentials : null;
});

export const vncSummary$ = computed(async (get) => {
  get(reload$);
  if (!(await get(vncIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(vncClients$)).connections.summary(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body : null;
});

export interface VncDialogState {
  readonly identity: string;
  readonly creationId: string;
  readonly kind:
    | "create"
    | "edit"
    | "delete"
    | "create-credential"
    | "edit-credential"
    | "delete-credential";
  readonly connection: VncConnectionResponse | null;
  readonly credential: VncCredentialResponse | null;
}
const dialog$ = state<VncDialogState | null>(null);
const view$ = state<"hosts" | "credentials">("hosts");
const editor$ = state({
  selection: "",
  trust: "system" as "system" | "custom_ca",
  replace: false,
});
const uncertain$ = state(false);
const saveMessage$ = state<string | null>(null);
const conflict$ = state(false);
const resetSave$ = resetSignal();
const editorLocked$ = computed((get) => {
  return get(uncertain$) || get(conflict$);
});

export const vncDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
  return dialog?.identity === (await get(vncIdentity$)) ? dialog : null;
});
export const vncView$ = computed((get) => {
  return get(view$);
});
export const vncEditor$ = computed((get) => {
  return get(editor$);
});
export const vncSaveUncertain$ = computed((get) => {
  return get(uncertain$);
});
export const vncSaveMessage$ = computed((get) => {
  return get(saveMessage$);
});
export const vncConflict$ = computed((get) => {
  return get(conflict$);
});
export const changeVncView$ = command(({ set }, value: string) => {
  if (value === "hosts" || value === "credentials") {
    set(view$, value);
  }
});
export const chooseVncCredential$ = command(
  ({ get, set }, selection: string | null) => {
    if (selection !== null && !get(editorLocked$)) {
      set(editor$, (current) => {
        return { ...current, selection };
      });
    }
  },
);
export const chooseVncTrust$ = command(({ get, set }, trust: string | null) => {
  if (!get(editorLocked$) && (trust === "system" || trust === "custom_ca")) {
    set(editor$, (current): Editor => {
      return { ...current, trust };
    });
  }
});
export const replaceVncPassword$ = command(({ get, set }, replace: boolean) => {
  if (get(editorLocked$)) {
    return;
  }
  set(editor$, (current) => {
    return { ...current, replace };
  });
});

export const closeVncDialog$ = command(({ set }) => {
  set(resetSave$);
  set(dialog$, null);
  set(uncertain$, false);
  set(saveMessage$, null);
  set(conflict$, false);
  set(editor$, { selection: "", trust: "system", replace: false });
});
export const refreshVnc$ = command(({ set }) => {
  set(closeVncDialog$);
  set(view$, "hosts");
  set(invalidateVnc$);
});
export const mountVncForm$ = onRef(
  command(({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
    const mountedDialog = get(dialog$);
    const mountedSession = get(authenticatedSessionKey$);
    signal.addEventListener(
      "abort",
      () => {
        if (get(dialog$) === mountedDialog) {
          set(resetSave$);
          // StrictMode replays callback refs within the same owner lifetime.
          // Only an actual authority change discards the stored draft here.
          if (
            get(authenticatedSessionKey$) !== mountedSession ||
            !get(featureSwitch$)[FeatureSwitchKey.VncAccess]
          ) {
            set(closeVncDialog$);
          }
        }
        form.reset();
      },
      { once: true },
    );
  }),
);
export const mountVncSecret$ = onRef(
  command((_context, input: HTMLInputElement, signal: AbortSignal) => {
    signal.addEventListener(
      "abort",
      () => {
        input.value = "";
      },
      { once: true },
    );
  }),
);

export const openVncDialog$ = command(
  async (
    { get, set },
    kind: VncDialogState["kind"],
    resource: VncConnectionResponse | VncCredentialResponse | null,
    signal: AbortSignal,
  ) => {
    const identity = await get(vncIdentity$);
    signal.throwIfAborted();
    if (!identity) {
      return;
    }
    const connection = resource && "host" in resource ? resource : null;
    const credential = resource && "authMethod" in resource ? resource : null;
    set(closeVncDialog$);
    set(editor$, {
      selection: connection?.credentialId ?? (kind === "create" ? "" : "new"),
      trust: connection?.security.trust.mode ?? "system",
      replace: false,
    });
    const dialog: VncDialogState = {
      identity,
      kind,
      connection,
      credential,
      creationId: crypto.randomUUID(),
    };
    set(dialog$, dialog);
    if (kind === "create") {
      const credentials = await settle(
        waitForOperation(get(vncCredentials$), signal),
        signal,
      );
      signal.throwIfAborted();
      if (
        get(dialog$) !== dialog ||
        get(editorLocked$) ||
        !credentials.ok ||
        !credentials.value
      ) {
        return;
      }
      // Leave explicit user choices alone while the metadata request settles.
      const selection =
        credentials.value.length === 0
          ? "new"
          : credentials.value.length === 1
            ? credentials.value[0]!.id
            : "";
      set(editor$, (current) => {
        return current.selection === "" ? { ...current, selection } : current;
      });
    }
  },
);

function textField(form: HTMLFormElement, name: string): string {
  const input = form.elements.namedItem(name);
  if (
    !(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)
  ) {
    throw new Error(`Missing VNC form field: ${name}`);
  }
  // Uncertain drafts are disabled, so FormData would omit their values.
  return input.value;
}

function credentialFields(form: HTMLFormElement) {
  return {
    name: textField(form, "credentialName"),
    authentication: {
      method: "vnc_password" as const,
      password: textField(form, "password"),
    },
  };
}

interface VncClients {
  readonly connections: InitClientReturn<
    typeof vncConnectionsContract,
    InitClientArgs
  >;
  readonly credentials: InitClientReturn<
    typeof vncCredentialsContract,
    InitClientArgs
  >;
}
interface Editor {
  readonly selection: string;
  readonly trust: "system" | "custom_ca";
  readonly replace: boolean;
}

function connectionFields(form: HTMLFormElement, editor: Editor) {
  return {
    displayName: textField(form, "displayName"),
    host: textField(form, "host"),
    port: Number(textField(form, "port")),
    credential:
      editor.selection === "new"
        ? { create: credentialFields(form) }
        : { id: editor.selection },
    security: {
      type: "x509_vnc" as const,
      trust:
        editor.trust === "system"
          ? { mode: "system" as const }
          : {
              mode: "custom_ca" as const,
              caBundle: textField(form, "caBundle"),
            },
    },
  };
}

function connectionRequest(
  clients: VncClients,
  dialog: VncDialogState,
  form: HTMLFormElement,
  editor: Editor,
  signal: AbortSignal,
) {
  if (dialog.kind === "create") {
    const body = createVncConnectionRequestSchema.safeParse({
      ...connectionFields(form, editor),
      id: dialog.creationId,
    });
    return body.success
      ? () => {
          return clients.connections.create({
            body: body.data,
            fetchOptions: { signal },
          });
        }
      : null;
  }
  const connection = dialog.connection;
  if (!connection) {
    throw new Error("VNC host editor requires a connection");
  }
  const params = { connectionId: connection.id };
  if (dialog.kind === "delete") {
    return () => {
      return clients.connections.delete({
        params,
        body: { expectedGeneration: connection.generation },
        fetchOptions: { signal },
      });
    };
  }
  const body = updateVncConnectionRequestSchema.safeParse({
    ...connectionFields(form, editor),
    expectedGeneration: connection.generation,
  });
  return body.success
    ? () => {
        return clients.connections.update({
          params,
          body: body.data,
          fetchOptions: { signal },
        });
      }
    : null;
}

function credentialRequest(
  clients: VncClients,
  dialog: VncDialogState,
  form: HTMLFormElement,
  editor: Editor,
  signal: AbortSignal,
) {
  if (dialog.kind === "create-credential") {
    const body = createVncCredentialRequestSchema.safeParse(
      credentialFields(form),
    );
    return body.success
      ? () => {
          return clients.credentials.create({
            body: { ...body.data, id: dialog.creationId },
            fetchOptions: { signal },
          });
        }
      : null;
  }
  const credential = dialog.credential;
  if (!credential) {
    throw new Error("VNC credential editor requires a credential");
  }
  const params = { credentialId: credential.id };
  if (dialog.kind === "delete-credential") {
    return () => {
      return clients.credentials.delete({
        params,
        body: { expectedRevision: credential.revision },
        fetchOptions: { signal },
      });
    };
  }
  const body = updateVncCredentialRequestSchema.safeParse({
    expectedRevision: credential.revision,
    name: textField(form, "credentialName"),
    ...(editor.replace
      ? { authentication: credentialFields(form).authentication }
      : {}),
  });
  return body.success
    ? () => {
        return clients.credentials.update({
          params,
          body: body.data,
          fetchOptions: { signal },
        });
      }
    : null;
}

export const saveVnc$ = command(
  async ({ get, set }, form: HTMLFormElement, parentSignal: AbortSignal) => {
    const signal = set(resetSave$, parentSignal);
    const dialog = await get(vncDialog$);
    signal.throwIfAborted();
    if (!dialog || get(conflict$)) {
      return;
    }
    const clients = await get(vncClients$);
    signal.throwIfAborted();
    if (clients.identity !== dialog.identity) {
      return;
    }
    const editor = get(editor$);
    const request = dialog.kind.endsWith("-credential")
      ? credentialRequest(clients, dialog, form, editor, signal)
      : connectionRequest(clients, dialog, form, editor, signal);
    if (!request) {
      set(saveMessage$, VNC_ERROR_CODES.INVALID_INPUT);
      return;
    }
    const retrying = get(uncertain$);
    set(saveMessage$, null);
    set(uncertain$, true);
    const result = await accept<
      Awaited<ReturnType<typeof request>>,
      200 | 201 | 204 | 400 | 404 | 409 | 500
    >(request(), [200, 201, 204, 400, 404, 409, 500], signal);
    signal.throwIfAborted();
    if (
      get(dialog$) !== dialog ||
      dialog.identity !== (await get(vncIdentity$))
    ) {
      return;
    }
    signal.throwIfAborted();
    if (
      result.status === 200 ||
      result.status === 201 ||
      result.status === 204
    ) {
      set(closeVncDialog$);
      set(invalidateVnc$);
      return;
    }
    if (result.status === 500) {
      return;
    }
    const versionConflict =
      result.body.error.code === VNC_ERROR_CODES.GENERATION_CONFLICT ||
      result.body.error.code === VNC_ERROR_CODES.CREDENTIAL_REVISION_CONFLICT;
    // A later rejection cannot prove that an earlier ambiguous create failed.
    if (retrying && !versionConflict) {
      return;
    }
    set(uncertain$, false);
    set(saveMessage$, result.body.error.code);
    if (result.status !== 400) {
      set(conflict$, true);
      set(invalidateVnc$);
    }
  },
);
