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
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import {
  isVncKerberosMethod,
  VNC_KERBEROS_VERSION,
  VNC_KERBEROS_VERSION_HEADER,
  type VncKerberosMethod,
  kerberosPrincipalSchema,
  kerberosServicePrincipalSchema,
} from "@okouai/api-contracts/contracts/vnc-kerberos";
import {
  encodeAndClearKerberosMaterial,
  canonicalKerberosKeytab,
  canonicalKerberosTicket,
} from "@okouai/api-contracts/contracts/vnc-kerberos-format";
import { now } from "../lib/time.ts";
import {
  isVncRsaAesSecurityType,
  isVncRsaAesAuthenticationOnly,
} from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import {
  RSA_AES_PROFILES,
  isRsaAesProfile,
  rsaAesProfile,
  type RsaAesProfile,
} from "./vnc-rsa-aes.ts";
import { accept } from "../lib/accept.ts";
import { authenticatedSessionKey$, clerk$, user$ } from "./auth.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import { apiClient$ } from "./api-client.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import { invalidateRemoteAccess$ } from "./remote-access-refresh.ts";
import {
  onRef,
  resetSignal,
  settle,
  waitForOperation,
  withCleanup,
} from "./utils.ts";

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
  set(invalidateVnc$);
});

const vncConnectionsResult$ = computed(async (get) => {
  get(reload$);
  if (!(await get(vncIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(vncClients$)).connections.list({
      extraHeaders: { [VNC_KERBEROS_VERSION_HEADER]: VNC_KERBEROS_VERSION },
    }),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result : null;
});
export const vncConnections$ = computed(async (get) => {
  return (await get(vncConnectionsResult$))?.body.connections ?? null;
});
export const vncKerberosSupported$ = computed(async (get) => {
  return (
    (await get(vncConnectionsResult$))?.headers.get(
      VNC_KERBEROS_VERSION_HEADER,
    ) === VNC_KERBEROS_VERSION
  );
});

export const vncCredentials$ = computed(async (get) => {
  get(reload$);
  if (!(await get(vncIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(vncClients$)).credentials.list({
      extraHeaders: { [VNC_KERBEROS_VERSION_HEADER]: VNC_KERBEROS_VERSION },
    }),
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
export type VncProfile =
  | Exclude<VncSecurity["type"], "qemu_x509_gssapi">
  | VncKerberosMethod
  | "client_certificate_none"
  | "client_certificate_vnc"
  | RsaAesProfile;
export type VncAuthMethod = VncCredentialResponse["authMethod"] | "none";

export function vncAuthMethodForProfile(profile: VncProfile): VncAuthMethod {
  if (isVncKerberosMethod(profile)) {
    return profile;
  }
  if (isRsaAesProfile(profile)) {
    return RSA_AES_PROFILES[profile].method;
  }
  switch (profile) {
    case "x509_none": {
      return "none";
    }
    case "client_certificate_none": {
      return "client_certificate";
    }
    case "client_certificate_vnc": {
      return "client_certificate_vnc_password";
    }
    case "x509_vnc":
    case "apple_vnc_password": {
      return "vnc_password";
    }
    case "x509_plain": {
      return "username_password";
    }
    case "qemu_x509_sasl": {
      return "qemu_scram_sha256";
    }
    case "apple_dh": {
      return "apple_dh_username_password";
    }
    case "apple_srp": {
      return "apple_srp_username_password";
    }
    case "apple_rsa_srp": {
      return "apple_rsa_srp_username_password";
    }
  }
  void (profile satisfies never);
  throw new Error("Unsupported VNC profile");
}

function vncProfileForAuthMethod(
  method: VncCredentialResponse["authMethod"],
): VncProfile {
  if (isVncKerberosMethod(method)) {
    return method;
  }
  switch (method) {
    case "rsa_aes_password": {
      return "rsa_aes_ra2";
    }
    case "rsa_aes_username_password": {
      return "rsa_aes_ra2_username_password";
    }
    case "client_certificate": {
      return "client_certificate_none";
    }
    case "client_certificate_vnc_password": {
      return "client_certificate_vnc";
    }
    case "vnc_password": {
      return "x509_vnc";
    }
    case "username_password": {
      return "x509_plain";
    }
    case "qemu_scram_sha256": {
      return "qemu_x509_sasl";
    }
    case "apple_dh_username_password": {
      return "apple_dh";
    }
    case "apple_srp_username_password": {
      return "apple_srp";
    }
    case "apple_rsa_srp_username_password": {
      return "apple_rsa_srp";
    }
  }
  void (method satisfies never);
  throw new Error("Unsupported VNC authentication method");
}

export function vncCredentialMatchesProfile(
  credential: VncCredentialResponse,
  profile: VncProfile,
) {
  return (
    profile !== "x509_none" &&
    credential.authMethod === vncAuthMethodForProfile(profile)
  );
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

export function vncProfileForConnection(
  connection: VncConnectionResponse,
): VncProfile {
  if (connection.security.type === "qemu_x509_gssapi") {
    if (!connection.kerberosAuthentication) {
      throw new Error("Missing VNC Kerberos source");
    }
    return connection.kerberosAuthentication;
  }
  if (isVncRsaAesSecurityType(connection.security.type)) {
    if (
      !("rsaAesAuthentication" in connection) ||
      !connection.rsaAesAuthentication
    ) {
      throw new Error(
        "VNC RSA-AES connection is missing its authentication method",
      );
    }
    return rsaAesProfile(
      connection.security.type,
      connection.rsaAesAuthentication,
    );
  }
  if (
    "clientCertificateAuthentication" in connection &&
    connection.clientCertificateAuthentication
  ) {
    return connection.clientCertificateAuthentication === "client_certificate"
      ? "client_certificate_none"
      : "client_certificate_vnc";
  }
  return connection.security.type;
}

function initialVncProfile(
  connection: VncConnectionResponse | null,
  credential: VncCredentialResponse | null,
): VncProfile {
  return connection
    ? vncProfileForConnection(connection)
    : credential
      ? vncProfileForAuthMethod(credential.authMethod)
      : "x509_vnc";
}

function requiresSshLoopback(profile: VncProfile): boolean {
  if (isRsaAesProfile(profile)) {
    return isVncRsaAesAuthenticationOnly(RSA_AES_PROFILES[profile].type);
  }
  return (
    profile === "apple_vnc_password" ||
    profile === "apple_dh" ||
    profile === "apple_srp" ||
    profile === "apple_rsa_srp"
  );
}

const editor$ = state({
  selection: "",
  profile: "x509_vnc" as VncProfile,
  trust: "system" as "system" | "custom_ca",
  transport: "direct" as "direct" | "ssh",
  sshConnectionId: "",
  kdcSshConnectionId: "",
  kdcHost: "",
  loopbackHost: "127.0.0.1" as "127.0.0.1" | "::1",
  destinationHost: "",
  tlsServerName: "",
  caBundle: "",
  rsaServerKeySha256: "",
  rsaImportedModulusBits: null as number | null,
  replace: false,
});
const uncertain$ = state(false);
const saveMessage$ = state<string | null>(null);
const conflict$ = state(false);
const resetSave$ = resetSignal();
const resetRsaImport$ = resetSignal();
const resetKerberosImport$ = resetSignal();
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
      set(resetKerberosImport$);
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
      (profile === "x509_none" ||
        profile === "x509_vnc" ||
        profile === "client_certificate_none" ||
        profile === "client_certificate_vnc" ||
        profile === "x509_plain" ||
        profile === "qemu_x509_sasl" ||
        (profile !== null && isVncKerberosMethod(profile)) ||
        profile === "apple_vnc_password" ||
        profile === "apple_dh" ||
        profile === "apple_srp" ||
        profile === "apple_rsa_srp" ||
        isRsaAesProfile(profile))
    ) {
      set(resetRsaImport$);
      set(resetKerberosImport$);
      set(editor$, (current): Editor => {
        return current.profile === profile
          ? current
          : {
              ...current,
              profile,
              selection: "",
              transport: requiresSshLoopback(profile)
                ? "ssh"
                : current.transport,
            };
      });
    }
  },
);
export const chooseVncLoopbackHost$ = command(
  ({ get, set }, host: string | null) => {
    if (!get(editorLocked$) && (host === "127.0.0.1" || host === "::1")) {
      const loopbackHost: Editor["loopbackHost"] = host;
      set(editor$, (current): Editor => {
        return { ...current, loopbackHost };
      });
    }
  },
);
export const editVncDestinationHost$ = command(({ get, set }, host: string) => {
  if (!get(editorLocked$)) {
    set(editor$, (current) => {
      return { ...current, destinationHost: host };
    });
  }
});
export const editVncServerName$ = command(({ get, set }, name: string) => {
  if (!get(editorLocked$)) {
    set(editor$, (current) => {
      return { ...current, tlsServerName: name };
    });
  }
});
export const editVncCaBundle$ = command(({ get, set }, bundle: string) => {
  if (!get(editorLocked$)) {
    set(editor$, (current) => {
      return { ...current, caBundle: bundle };
    });
  }
});
export const editVncRsaPin$ = command(({ get, set }, pin: string) => {
  if (!get(editorLocked$)) {
    set(resetRsaImport$);
    set(editor$, (current) => {
      return {
        ...current,
        rsaServerKeySha256: pin,
        rsaImportedModulusBits: null,
      };
    });
  }
});
export const importVncRsaKey$ = command(
  async ({ get, set }, form: HTMLFormElement, parentSignal: AbortSignal) => {
    const signal = set(resetRsaImport$, parentSignal);
    const dialog = await get(vncDialog$);
    signal.throwIfAborted();
    if (
      !dialog ||
      get(editorLocked$) ||
      !isRsaAesProfile(get(editor$).profile)
    ) {
      return;
    }
    const pin = get(editor$).rsaServerKeySha256;
    const profile = get(editor$).profile;
    const publicKeyPem = textField(form, "serverPublicKeyPem");
    const clients = await get(vncClients$);
    signal.throwIfAborted();
    if (clients.identity !== dialog.identity) {
      return;
    }
    const result = await accept(
      clients.connections.inspectRsaKey({
        body: { publicKeyPem },
        fetchOptions: { signal },
      }),
      [200, 400, 404],
      signal,
      { showErrorToast: false },
    );
    signal.throwIfAborted();
    if (
      get(dialog$) !== dialog ||
      get(editorLocked$) ||
      (await get(vncIdentity$)) !== dialog.identity ||
      get(editor$).rsaServerKeySha256 !== pin ||
      get(editor$).profile !== profile
    ) {
      return;
    }
    signal.throwIfAborted();
    if (
      result.status !== 200 ||
      textField(form, "serverPublicKeyPem") !== publicKeyPem
    ) {
      // The displayed public-key draft must still be the material inspected.
      // Do not associate a late old fingerprint with a newly edited PEM.
      set(saveMessage$, VNC_ERROR_CODES.INVALID_INPUT);
      return;
    }
    set(editor$, (current) => {
      return {
        ...current,
        rsaServerKeySha256: result.body.serverKeySha256,
        rsaImportedModulusBits: result.body.modulusBits,
      };
    });
    set(saveMessage$, null);
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
      (transport !== "direct" || !requiresSshLoopback(get(editor$).profile))
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
export const chooseVncKdcSsh$ = command(({ get, set }, id: string | null) => {
  if (id === null || get(editorLocked$)) {
    return;
  }
  set(editor$, (current) => {
    return {
      ...current,
      kdcSshConnectionId: id === "direct" ? "" : id,
      kdcHost: id === "direct" ? "" : "127.0.0.1",
    };
  });
});
export const editVncKdcHost$ = command(({ get, set }, host: string) => {
  if (!get(editorLocked$)) {
    set(editor$, (current) => {
      return { ...current, kdcHost: host };
    });
  }
});
export const replaceVncAuthentication$ = command(
  ({ get, set }, replace: boolean) => {
    if (get(editorLocked$)) {
      return;
    }
    set(editor$, (current) => {
      return { ...current, replace };
    });
    set(resetKerberosImport$);
  },
);

export const closeVncDialog$ = command(({ set }) => {
  set(resetKerberosImport$);
  set(resetSave$);
  set(resetRsaImport$);
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
    kdcSshConnectionId: "",
    kdcHost: "",
    loopbackHost: "127.0.0.1",
    destinationHost: "",
    tlsServerName: "",
    caBundle: "",
    rsaServerKeySha256: "",
    rsaImportedModulusBits: null,
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
          set(resetRsaImport$);
          set(resetKerberosImport$);
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

export const mountVncCertificateSecret$ = onRef(
  command((_context, input: HTMLTextAreaElement, signal: AbortSignal) => {
    signal.addEventListener(
      "abort",
      () => {
        input.value = "";
      },
      { once: true },
    );
  }),
);

export const importVncKerberos$ = command(
  async (
    { get, set },
    form: HTMLFormElement,
    file: File,
    parentSignal: AbortSignal,
  ) => {
    const signal = set(resetKerberosImport$, parentSignal);
    const dialog = await get(vncDialog$);
    signal.throwIfAborted();
    const profile = get(editor$).profile;
    const field = form.elements.namedItem("kerberosMaterial");
    if (
      !dialog ||
      get(editorLocked$) ||
      !(field instanceof HTMLInputElement) ||
      (profile !== "qemu_kerberos_ticket" && profile !== "qemu_kerberos_keytab")
    ) {
      return;
    }
    field.value = "";
    if (file.size === 0 || file.size > 65_536) {
      set(saveMessage$, VNC_ERROR_CODES.INVALID_INPUT);
      return;
    }
    const principal = [
      textField(form, "kerberosRealm"),
      textField(form, "kerberosComponents"),
    ];
    const target =
      profile === "qemu_kerberos_ticket"
        ? [
            textField(form, "kerberosTicketRealm"),
            textField(form, "kerberosTicketInstance"),
          ]
        : null;
    let bytes: Uint8Array | undefined;
    const result = await settle(
      withCleanup(
        (async () => {
          bytes = new Uint8Array(await file.arrayBuffer());
          signal.throwIfAborted();
          if (
            get(dialog$) !== dialog ||
            get(editor$).profile !== profile ||
            !form.isConnected ||
            get(editorLocked$) ||
            (await get(vncIdentity$)) !== dialog.identity ||
            principal[0] !== textField(form, "kerberosRealm") ||
            principal[1] !== textField(form, "kerberosComponents")
          ) {
            return;
          }
          signal.throwIfAborted();
          const initiator = kerberosPrincipalSchema.parse({
            realm: principal[0],
            components: principal[1]!.split("\n"),
          });
          const canonical = target
            ? canonicalKerberosTicket(
                bytes,
                initiator,
                kerberosServicePrincipalSchema.parse({
                  realm: target[0],
                  components: ["vnc", target[1]],
                }),
                Math.floor(now() / 1000),
              ).bytes
            : canonicalKerberosKeytab(bytes, initiator);
          field.value = encodeAndClearKerberosMaterial(canonical);
          set(saveMessage$, null);
        })(),
        () => {
          bytes?.fill(0);
        },
      ),
      signal,
    );
    if (!result.ok) {
      field.value = "";
      set(saveMessage$, VNC_ERROR_CODES.INVALID_INPUT);
    }
  },
);
export const invalidateVncKerberosImport$ = command(
  ({ set }, form: HTMLFormElement) => {
    set(resetKerberosImport$);
    const field = form.elements.namedItem("kerberosMaterial");
    if (field instanceof HTMLInputElement) {
      field.value = "";
    }
  },
);

function initialVncSecurityFields(
  connection: VncConnectionResponse | null,
): Pick<Editor, "trust" | "tlsServerName" | "caBundle" | "rsaServerKeySha256"> {
  const security = connection?.security;
  return {
    trust: security && "trust" in security ? security.trust.mode : "system",
    tlsServerName:
      security && "serverName" in security ? (security.serverName ?? "") : "",
    caBundle:
      security && "trust" in security && security.trust.mode === "custom_ca"
        ? security.trust.caBundle
        : "",
    rsaServerKeySha256:
      security && "serverKeySha256" in security ? security.serverKeySha256 : "",
  };
}

function initialVncEditor(
  kind: VncDialogState["kind"],
  connection: VncConnectionResponse | null,
  credential: VncCredentialResponse | null,
): Editor {
  const sshConnectionId = connection ? vncSshConnectionId(connection) : null;
  const profile = initialVncProfile(connection, credential);
  return {
    selection:
      connection && "credentialId" in connection
        ? connection.credentialId
        : kind === "create"
          ? ""
          : "new",
    profile,
    ...initialVncSecurityFields(connection),
    transport:
      sshConnectionId || requiresSshLoopback(profile) ? "ssh" : "direct",
    sshConnectionId: sshConnectionId ?? "",
    kdcSshConnectionId:
      connection?.security.type === "qemu_x509_gssapi" &&
      connection.security.kdc?.transport.type === "ssh"
        ? connection.security.kdc.transport.connectionId
        : "",
    kdcHost:
      connection?.security.type === "qemu_x509_gssapi"
        ? (connection.security.kdc?.host ?? "")
        : "",
    loopbackHost: connection?.host === "::1" ? "::1" : "127.0.0.1",
    destinationHost: connection?.host ?? "",
    rsaImportedModulusBits: null,
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
  if (!(
    input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement
  )) {
    throw new Error(`Missing VNC form field: ${name}`);
  }
  // Uncertain drafts are disabled, so FormData would omit their values.
  return input.value;
}

function kerberosCredentialFields(
  form: HTMLFormElement,
  profile: VncKerberosMethod,
) {
  const initiator = {
    realm: textField(form, "kerberosRealm"),
    components: textField(form, "kerberosComponents").split("\n"),
  };
  return {
    authentication:
      profile === "qemu_kerberos_ticket"
        ? {
            method: profile,
            initiator,
            service: {
              realm: textField(form, "kerberosTicketRealm"),
              components: ["vnc", textField(form, "kerberosTicketInstance")],
            },
            ticketCache: textField(form, "kerberosMaterial"),
          }
        : profile === "qemu_kerberos_keytab"
          ? {
              method: profile,
              initiator,
              keytab: textField(form, "kerberosMaterial"),
            }
          : {
              method: profile,
              initiator,
              password: textField(form, "password"),
            },
  };
}

function credentialFields(form: HTMLFormElement, profile: VncProfile) {
  const name = textField(form, "credentialName");
  if (isVncKerberosMethod(profile)) {
    return { name, ...kerberosCredentialFields(form, profile) };
  }
  if (isRsaAesProfile(profile)) {
    const method = RSA_AES_PROFILES[profile].method;
    return {
      name,
      authentication:
        method === "rsa_aes_password"
          ? { method, password: textField(form, "password") }
          : {
              method,
              username: textField(form, "username"),
              password: textField(form, "password"),
            },
    };
  }
  switch (profile) {
    case "x509_none": {
      throw new Error("Certificate-free X509None has no credential to create");
    }
    case "client_certificate_none": {
      return {
        name,
        authentication: {
          method: "client_certificate" as const,
          certificateChain: textField(form, "certificateChain"),
          privateKey: textField(form, "privateKey"),
        },
      };
    }
    case "client_certificate_vnc": {
      return {
        name,
        authentication: {
          method: "client_certificate_vnc_password" as const,
          certificateChain: textField(form, "certificateChain"),
          privateKey: textField(form, "privateKey"),
          password: textField(form, "password"),
        },
      };
    }
    case "x509_vnc":
    case "apple_vnc_password": {
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
    case "qemu_x509_sasl": {
      return {
        name,
        authentication: {
          method: "qemu_scram_sha256" as const,
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
    case "apple_rsa_srp": {
      return {
        name,
        authentication: {
          method: "apple_rsa_srp_username_password" as const,
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
  readonly kdcSshConnectionId: string;
  readonly kdcHost: string;
  readonly loopbackHost: "127.0.0.1" | "::1";
  readonly destinationHost: string;
  readonly tlsServerName: string;
  readonly caBundle: string;
  readonly rsaServerKeySha256: string;
  readonly rsaImportedModulusBits: number | null;
  readonly replace: boolean;
}

function connectionFields(form: HTMLFormElement, editor: Editor) {
  const serverName =
    requiresSshLoopback(editor.profile) || isRsaAesProfile(editor.profile)
      ? ""
      : editor.tlsServerName.trim();
  return {
    displayName: textField(form, "displayName"),
    host: requiresSshLoopback(editor.profile)
      ? editor.loopbackHost
      : editor.destinationHost,
    port: Number(textField(form, "port")),
    transport:
      editor.transport === "ssh"
        ? { type: "ssh" as const, connectionId: editor.sshConnectionId }
        : { type: "direct" as const },
    credential:
      editor.profile === "x509_none"
        ? { type: "none" as const }
        : editor.selection === "new"
          ? { create: credentialFields(form, editor.profile) }
          : { id: editor.selection },
    security: isRsaAesProfile(editor.profile)
      ? {
          type: RSA_AES_PROFILES[editor.profile].type,
          serverKeySha256: editor.rsaServerKeySha256,
        }
      : requiresSshLoopback(editor.profile)
        ? { type: editor.profile }
        : {
            type:
              editor.profile === "client_certificate_none"
                ? ("x509_none" as const)
                : editor.profile === "client_certificate_vnc"
                  ? ("x509_vnc" as const)
                  : isVncKerberosMethod(editor.profile)
                    ? ("qemu_x509_gssapi" as const)
                    : editor.profile,
            ...(isVncKerberosMethod(editor.profile)
              ? {
                  service: {
                    realm: textField(form, "kerberosServiceRealm"),
                    components: [
                      "vnc",
                      textField(form, "kerberosServiceInstance"),
                    ],
                  },
                  ...(editor.profile === "qemu_kerberos_ticket"
                    ? {}
                    : {
                        kdc: {
                          host: textField(form, "kdcHost"),
                          port: Number(textField(form, "kdcPort")),
                          transport: textField(form, "kdcSshConnectionId")
                            ? {
                                type: "ssh" as const,
                                connectionId: textField(
                                  form,
                                  "kdcSshConnectionId",
                                ),
                              }
                            : { type: "direct" as const },
                          ticketLifetimeSeconds: Number(
                            textField(form, "kerberosLifetime"),
                          ),
                          renewableLifetimeSeconds: Number(
                            textField(form, "kerberosRenewableLifetime"),
                          ),
                        },
                      }),
                }
              : {}),
            ...(serverName ? { serverName } : {}),
            trust:
              editor.trust === "system"
                ? { mode: "system" as const }
                : {
                    mode: "custom_ca" as const,
                    caBundle: editor.caBundle,
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
