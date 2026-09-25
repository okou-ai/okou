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
  type VncSecurity,
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
import { invalidateRemoteAccess$ } from "./remote-access-refresh.ts";
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
  set(invalidateRemoteAccess$);
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
export type VncProfile = VncSecurity["type"];
export type VncAuthMethod = VncCredentialResponse["authMethod"];

export function vncAuthMethodForProfile(profile: VncProfile): VncAuthMethod {
  switch (profile) {
    case "x509_vnc": {
      return "vnc_password";
    }
    case "x509_plain": {
      return "username_password";
    }
    case "apple_dh": {
      return "apple_dh_username_password";
    }
    case "apple_srp": {
      return "apple_srp_username_password";
    }
  }
  void (profile satisfies never);
  throw new Error("Unsupported VNC profile");
}

function vncProfileForAuthMethod(method: VncAuthMethod): VncProfile {
  switch (method) {
    case "vnc_password": {
      return "x509_vnc";
    }
    case "username_password": {
      return "x509_plain";
    }
    case "apple_dh_username_password": {
      return "apple_dh";
    }
    case "apple_srp_username_password": {
      return "apple_srp";
    }
  }
  void (method satisfies never);
  throw new Error("Unsupported VNC authentication method");
}

export function vncCredentialMatchesProfile(
  credential: VncCredentialResponse,
  profile: VncProfile,
) {
  return credential.authMethod === vncAuthMethodForProfile(profile);
}

type SshRoutedVncConnection = Extract<
  VncConnectionResponse,
  { readonly transport: unknown }
>;

function isSshRoutedVncConnection(
  connection: VncConnectionResponse,
): connection is SshRoutedVncConnection {
  return "transport" in connection;
}

export function vncSshConnectionId(connection: VncConnectionResponse) {
  return isSshRoutedVncConnection(connection)
    ? connection.transport.connectionId
    : null;
}

function initialVncProfile(
  connection: VncConnectionResponse | null,
  credential: VncCredentialResponse | null,
): VncProfile {
  if (connection) {
    return connection.security.type;
  }
  return credential
    ? vncProfileForAuthMethod(credential.authMethod)
    : "x509_vnc";
}

const editor$ = state({
  selection: "",
  profile: "x509_vnc" as VncProfile,
  trust: "system" as "system" | "custom_ca",
  transport: "direct" as "direct" | "ssh",
  sshConnectionId: "",
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
export const chooseVncCredential$ = command(
  ({ get, set }, selection: string | null) => {
    if (selection !== null && !get(editorLocked$)) {
      set(editor$, (current) => {
        return { ...current, selection };
      });
    }
  },
);
export const chooseVncProfile$ = command(
  ({ get, set }, profile: string | null) => {
    if (
      !get(editorLocked$) &&
      (profile === "x509_vnc" ||
        profile === "x509_plain" ||
        profile === "apple_dh" ||
        profile === "apple_srp")
    ) {
      set(editor$, (current): Editor => {
        return current.profile === profile
          ? current
          : {
              ...current,
              profile,
              selection: "",
              transport:
                profile === "apple_dh" || profile === "apple_srp"
                  ? "ssh"
                  : current.transport,
            };
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
export const chooseVncTransport$ = command(
  ({ get, set }, transport: string | null) => {
    if (
      !get(editorLocked$) &&
      (transport === "direct" || transport === "ssh") &&
      (transport !== "direct" ||
        (get(editor$).profile !== "apple_dh" &&
          get(editor$).profile !== "apple_srp"))
    ) {
      set(editor$, (current): Editor => {
        return { ...current, transport };
      });
    }
  },
);
export const chooseVncSshConnection$ = command(
  ({ get, set }, sshConnectionId: string | null) => {
    if (sshConnectionId !== null && !get(editorLocked$)) {
      set(editor$, (current): Editor => {
        return { ...current, sshConnectionId };
      });
    }
  },
);
export const replaceVncAuthentication$ = command(
  ({ get, set }, replace: boolean) => {
    if (get(editorLocked$)) {
      return;
    }
    set(editor$, (current) => {
      return { ...current, replace };
    });
  },
);

export const closeVncDialog$ = command(({ set }) => {
  set(resetSave$);
  set(dialog$, null);
  set(uncertain$, false);
  set(saveMessage$, null);
  set(conflict$, false);
  set(editor$, {
    selection: "",
    profile: "x509_vnc",
    trust: "system",
    transport: "direct",
    sshConnectionId: "",
    replace: false,
  });
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

function initialVncEditor(
  kind: VncDialogState["kind"],
  connection: VncConnectionResponse | null,
  credential: VncCredentialResponse | null,
): Editor {
  const sshConnectionId = connection ? vncSshConnectionId(connection) : null;
  return {
    selection: connection?.credentialId ?? (kind === "create" ? "" : "new"),
    profile: initialVncProfile(connection, credential),
    trust:
      connection?.security.type === "apple_dh" ||
      connection?.security.type === "apple_srp"
        ? "system"
        : (connection?.security.trust.mode ?? "system"),
    transport:
      sshConnectionId ||
      initialVncProfile(connection, credential) === "apple_dh" ||
      initialVncProfile(connection, credential) === "apple_srp"
        ? "ssh"
        : "direct",
    sshConnectionId: sshConnectionId ?? "",
    replace: false,
  };
}

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
    set(editor$, initialVncEditor(kind, connection, credential));
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
      const compatible = credentials.value.filter((credential) => {
        return vncCredentialMatchesProfile(credential, get(editor$).profile);
      });
      const selection =
        compatible.length === 0
          ? "new"
          : compatible.length === 1
            ? compatible[0]!.id
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

function credentialFields(form: HTMLFormElement, profile: VncProfile) {
  const name = textField(form, "credentialName");
  switch (profile) {
    case "x509_vnc": {
      return {
        name,
        authentication: {
          method: "vnc_password" as const,
          password: textField(form, "password"),
        },
      };
    }
    case "x509_plain": {
      return {
        name,
        authentication: {
          method: "username_password" as const,
          username: textField(form, "username"),
          password: textField(form, "password"),
        },
      };
    }
    case "apple_dh": {
      return {
        name,
        authentication: {
          method: "apple_dh_username_password" as const,
          username: textField(form, "username"),
          password: textField(form, "password"),
        },
      };
    }
    case "apple_srp": {
      return {
        name,
        authentication: {
          method: "apple_srp_username_password" as const,
          username: textField(form, "username"),
          password: textField(form, "password"),
        },
      };
    }
  }
  void (profile satisfies never);
  throw new Error("Unsupported VNC profile");
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
  readonly profile: VncProfile;
  readonly trust: "system" | "custom_ca";
  readonly transport: "direct" | "ssh";
  readonly sshConnectionId: string;
  readonly replace: boolean;
}

function connectionFields(form: HTMLFormElement, editor: Editor) {
  const serverName =
    editor.profile === "apple_dh" || editor.profile === "apple_srp"
      ? ""
      : textField(form, "serverName").trim();
  return {
    displayName: textField(form, "displayName"),
    host: textField(form, "host"),
    port: Number(textField(form, "port")),
    transport:
      editor.transport === "ssh"
        ? { type: "ssh" as const, connectionId: editor.sshConnectionId }
        : { type: "direct" as const },
    credential:
      editor.selection === "new"
        ? { create: credentialFields(form, editor.profile) }
        : { id: editor.selection },
    security:
      editor.profile === "apple_dh" || editor.profile === "apple_srp"
        ? { type: editor.profile }
        : {
            type: editor.profile,
            ...(serverName ? { serverName } : {}),
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
      credentialFields(form, editor.profile),
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
      ? {
          authentication: credentialFields(
            form,
            vncProfileForAuthMethod(credential.authMethod),
          ).authentication,
        }
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
