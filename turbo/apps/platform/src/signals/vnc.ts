import { resetRemoteLogin$ } from "./remote-login.ts";
import { command, computed, state } from "ccstate";
import type {
  InitClientReturn,
  InitClientArgs,
} from "@okouai/api-contracts/client/types";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { vncConnectionsContract } from "@okouai/api-contracts/client/vnc-connections";
import {
  createVncConnectionRequestSchema,
  updateVncConnectionRequestSchema,
} from "@okouai/api-contracts/validators/vnc-connections";
import type {
  VncConnectionResponse,
  VncSecurity,
  VncTransport,
} from "@okouai/api-contracts/contracts/vnc-connections";
import { vncCredentialsContract } from "@okouai/api-contracts/client/vnc-credentials";
import {
  createVncCredentialRequestSchema,
  updateVncCredentialRequestSchema,
} from "@okouai/api-contracts/validators/vnc-credentials";
import type { VncCredentialResponse } from "@okouai/api-contracts/contracts/vnc-credentials";
import { VNC_ERROR_CODES } from "@okouai/api-contracts/contracts/vnc-errors";
import {
  isVncKerberosMethod,
  kerberosPrincipalSchema,
  kerberosServicePrincipalSchema,
  type VncKerberosMethod,
} from "@okouai/api-contracts/contracts/vnc-kerberos";
import {
  encodeAndClearKerberosMaterial,
  canonicalKerberosKeytab,
  canonicalKerberosTicket,
} from "@okouai/api-contracts/contracts/vnc-kerberos-format";
import { now } from "../lib/time.ts";
import { vncObservationChangedPayloadSchema } from "@okouai/api-contracts/contracts/vnc-connection-observations";
import { setAblyPayloadLoop$ } from "./realtime.ts";
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
import { sortByName, sortRemoteHosts } from "../lib/remote-resource-order.ts";
import { locale$ } from "./locale.ts";
import {
  authenticatedSessionKey$,
  clerk$,
  currentOrgInfo$,
  user$,
} from "./auth.ts";
import { runtimeAuthenticatedIdentity$ } from "./auth-context.ts";
import { apiClient$ } from "./api-client.ts";
import { featureSwitch$ } from "./external/feature-switch.ts";
import {
  invalidateRemoteAccess$,
  invalidateVncObservationConfiguration$,
  vncObservationConfigurationRevision$,
} from "./remote-access-refresh.ts";
import { invalidateCloudflareAccess$ } from "./cloudflare-access.ts";
import { invalidateTailscale$ } from "./tailscale.ts";
import { onRef, resetSignal, settle, withCleanup } from "./utils.ts";

export const vncIdentity$ = computed(async (get) => {
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
const observationsReload$ = state(0);
export const invalidateVnc$ = command(({ set }) => {
  set(reload$, (value) => {
    return value + 1;
  });
  set(invalidateVncObservationConfiguration$);
  set(invalidateRemoteAccess$);
  set(invalidateCloudflareAccess$);
  set(invalidateTailscale$);
});

const vncConnectionsData$ = computed(async (get) => {
  get(reload$);
  if (!(await get(vncIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(vncClients$)).connections.list({}),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.connections : null;
});
export const vncConnections$ = computed(async (get) => {
  const locale = get(locale$);
  const connections = await get(vncConnectionsData$);
  return connections ? sortRemoteHosts(connections, locale) : null;
});

export const vncObservationsSnapshot$ = computed(async (get) => {
  get(observationsReload$);
  const configurationRevision = get(vncObservationConfigurationRevision$);
  const identity = await get(vncIdentity$);
  if (!identity) {
    return { identity, configurationRevision, observations: null };
  }
  const result = await accept(
    (await get(vncClients$)).connections.observations(),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return {
    identity,
    configurationRevision,
    observations: result.status === 200 ? result.body.observations : null,
  };
});

export const invalidateVncObservations$ = command(({ set }) => {
  set(observationsReload$, (value) => {
    return value + 1;
  });
  return false;
});
const onVncObservationChanged$ = command(
  async ({ get, set }, payload: unknown, signal: AbortSignal) => {
    const parsed = vncObservationChangedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      return false;
    }
    const org = await get(currentOrgInfo$);
    signal.throwIfAborted();
    if (org?.id === parsed.data.orgId) {
      set(invalidateVncObservations$);
    }
    return false;
  },
);
export const subscribeVncObservations$ = command(
  ({ set }, signal: AbortSignal) => {
    set(
      setAblyPayloadLoop$,
      {
        topic: "vnc:observations-changed",
        loopCommand$: onVncObservationChanged$,
        initializeCommand$: invalidateVncObservations$,
        options: { runOnSubscribe: true },
      },
      signal,
    );
  },
);

const vncCredentialsData$ = computed(async (get) => {
  get(reload$);
  if (!(await get(vncIdentity$))) {
    return null;
  }
  const result = await accept(
    (await get(vncClients$)).credentials.list({}),
    [200, 404],
    undefined,
    { showErrorToast: false },
  );
  return result.status === 200 ? result.body.credentials : null;
});
export const vncCredentials$ = computed(async (get) => {
  const locale = get(locale$);
  const credentials = await get(vncCredentialsData$);
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
  readonly sessionKey: string;
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
  readonly loginCredential?: VncCredentialResponse;
  readonly connectionSaved?: boolean;
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

export function vncSshConnectionId(connection: VncConnectionResponse) {
  return connection.transport?.type === "ssh"
    ? connection.transport.connectionId
    : null;
}

/** Presentation helper; native routes retain independent RFB/KDC bindings. */
export function hasNativeVncRoute(connection: VncConnectionResponse) {
  const native = (type: string | undefined) => {
    return type === "cloudflare_access" || type === "tailscale";
  };
  return (
    native(connection.transport?.type) ||
    (connection.security.type === "qemu_x509_gssapi" &&
      native(connection.security.kdc?.transport.type))
  );
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

export function requiresVncProtectiveRoute(profile: VncProfile): boolean {
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

const editor$ = state<Editor>({
  selection: "",
  profile: "x509_vnc",
  trust: "system",
  transport: "direct",
  networkConfigId: "",
  kdcTransport: "direct",
  kdcNetworkConfigId: "",
  originTlsEnabled: false,
  originTlsTrust: "system",
  originTlsServerName: "",
  originTlsCaBundle: "",
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
const uncertain$ = state(false);
const notice$ = state<{
  readonly code: string;
  readonly source: "save" | "rsa-import" | "kerberos-import";
} | null>(null);
const conflict$ = state(false);
const resetSave$ = resetSignal();
const resetRsaImport$ = resetSignal();
const resetKerberosImport$ = resetSignal();
const editorLocked$ = computed((get) => {
  return get(uncertain$) || get(conflict$);
});

export const vncDialog$ = computed(async (get) => {
  const dialog = get(dialog$);
  const sessionKey = get(authenticatedSessionKey$);
  return dialog?.sessionKey === sessionKey &&
    dialog.identity === (await get(vncIdentity$))
    ? dialog
    : null;
});
export const vncEditor$ = computed((get) => {
  return get(editor$);
});
export const vncProfile$ = computed((get) => {
  return get(editor$).profile;
});
export const vncTransport$ = computed((get) => {
  return get(editor$).transport;
});
export const vncDirectDestinationHost$ = computed((get) => {
  const editor = get(editor$);
  return editor.transport === "direct" ? editor.destinationHost : null;
});
export const vncSshConnectionId$ = computed((get) => {
  return get(editor$).sshConnectionId;
});
export const vncKdcTransport$ = computed((get) => {
  return get(editor$).kdcTransport;
});
export const vncKdcSshConnectionId$ = computed((get) => {
  return get(editor$).kdcSshConnectionId;
});
export const vncKdcHost$ = computed((get) => {
  return get(editor$).kdcHost;
});
export const vncCredentialSelection$ = computed((get) => {
  return get(editor$).selection;
});
export const vncNetworkConfigId$ = computed((get) => {
  return get(editor$).networkConfigId;
});
export const vncKdcNetworkConfigId$ = computed((get) => {
  return get(editor$).kdcNetworkConfigId;
});
export const vncOriginTlsEnabled$ = computed((get) => {
  return get(editor$).originTlsEnabled;
});
export const vncOriginTlsServerName$ = computed((get) => {
  return get(editor$).originTlsServerName;
});
export const vncOriginTlsTrust$ = computed((get) => {
  return get(editor$).originTlsTrust;
});
export const vncOriginTlsCaBundle$ = computed((get) => {
  return get(editor$).originTlsCaBundle;
});
export const vncSaveUncertain$ = computed((get) => {
  return get(uncertain$);
});
export const vncSaveMessage$ = computed((get) => {
  return get(notice$)?.code ?? null;
});
export const vncNoticeSource$ = computed((get) => {
  return get(notice$)?.source ?? "save";
});
export const clearVncSaveMessage$ = command(({ get, set }) => {
  if (!get(editorLocked$)) {
    set(notice$, null);
  }
});
export const vncConflict$ = computed((get) => {
  return get(conflict$);
});

export const chooseVncCredential$ = command(
  ({ get, set }, selection: string | null) => {
    if (selection !== null && !get(editorLocked$)) {
      set(clearVncSaveMessage$);
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
      set(clearVncSaveMessage$);
      set(resetRsaImport$);
      set(resetKerberosImport$);
      set(editor$, (current): Editor => {
        return current.profile === profile
          ? current
          : {
              ...current,
              profile,
              selection: get(featureSwitch$)[
                FeatureSwitchKey.RemoteControlGuidedSetup
              ]
                ? "new"
                : "",
              transport:
                requiresVncProtectiveRoute(profile) &&
                current.transport === "direct"
                  ? "ssh"
                  : current.transport,
              originTlsEnabled:
                current.originTlsEnabled ||
                (current.transport === "cloudflare_access" &&
                  requiresVncProtectiveRoute(profile)),
            };
      });
    }
  },
);
export const chooseVncLoopbackHost$ = command(
  ({ get, set }, host: string | null) => {
    if (!get(editorLocked$) && (host === "127.0.0.1" || host === "::1")) {
      set(clearVncSaveMessage$);
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
      set(notice$, {
        code: VNC_ERROR_CODES.INVALID_INPUT,
        source: "rsa-import",
      });
      return;
    }
    set(editor$, (current) => {
      return {
        ...current,
        rsaServerKeySha256: result.body.serverKeySha256,
        rsaImportedModulusBits: result.body.modulusBits,
      };
    });
    set(notice$, null);
  },
);

export const chooseVncTrust$ = command(({ get, set }, trust: string | null) => {
  if (!get(editorLocked$) && (trust === "system" || trust === "custom_ca")) {
    set(clearVncSaveMessage$);
    set(editor$, (current): Editor => {
      return { ...current, trust };
    });
  }
});
export const chooseVncTransport$ = command(
  ({ get, set }, transport: string | null) => {
    if (
      !get(editorLocked$) &&
      (transport === "direct" ||
        transport === "ssh" ||
        transport === "cloudflare_access" ||
        transport === "tailscale") &&
      (transport !== "direct" ||
        !requiresVncProtectiveRoute(get(editor$).profile))
    ) {
      set(clearVncSaveMessage$);
      set(editor$, (current): Editor => {
        return {
          ...current,
          transport,
          networkConfigId: "",
          originTlsEnabled:
            current.originTlsEnabled ||
            (transport === "cloudflare_access" &&
              requiresVncProtectiveRoute(current.profile)),
        };
      });
    }
  },
);
export const chooseVncSshConnection$ = command(
  ({ get, set }, sshConnectionId: string | null) => {
    if (sshConnectionId !== null && !get(editorLocked$)) {
      set(clearVncSaveMessage$);
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
  set(clearVncSaveMessage$);
  set(editor$, (current): Editor => {
    return {
      ...current,
      kdcSshConnectionId: id,
      kdcTransport: "ssh",
      kdcHost: "127.0.0.1",
    };
  });
});
export const chooseVncKdcTransport$ = command(
  ({ get, set }, transport: string | null) => {
    if (
      !get(editorLocked$) &&
      (transport === "direct" ||
        transport === "ssh" ||
        transport === "cloudflare_access" ||
        transport === "tailscale")
    ) {
      set(clearVncSaveMessage$);
      set(editor$, (current): Editor => {
        return { ...current, kdcTransport: transport, kdcNetworkConfigId: "" };
      });
    }
  },
);
export const chooseVncNetworkConfig$ = command(
  ({ get, set }, role: "rfb" | "kdc", id: string | null) => {
    if (id !== null && !get(editorLocked$)) {
      set(clearVncSaveMessage$);
      set(editor$, (current) => {
        return role === "rfb"
          ? { ...current, networkConfigId: id }
          : { ...current, kdcNetworkConfigId: id };
      });
    }
  },
);
export const editVncOriginTls$ = command(
  (
    { get, set },
    fields: Partial<
      Pick<
        Editor,
        | "originTlsEnabled"
        | "originTlsTrust"
        | "originTlsServerName"
        | "originTlsCaBundle"
      >
    >,
  ) => {
    if (!get(editorLocked$)) {
      set(clearVncSaveMessage$);
      set(editor$, (current) => {
        return { ...current, ...fields };
      });
    }
  },
);
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
    set(clearVncSaveMessage$);
    set(editor$, (current) => {
      return { ...current, replace };
    });
    set(resetKerberosImport$);
  },
);

export const closeVncDialog$ = command(({ set }) => {
  set(resetRemoteLogin$);
  set(resetKerberosImport$);
  set(resetSave$);
  set(resetRsaImport$);
  set(dialog$, null);
  set(uncertain$, false);
  set(notice$, null);
  set(conflict$, false);
  set(editor$, {
    selection: "",
    profile: "x509_vnc",
    trust: "system",
    transport: "direct",
    networkConfigId: "",
    kdcTransport: "direct",
    kdcNetworkConfigId: "",
    originTlsEnabled: false,
    originTlsTrust: "system",
    originTlsServerName: "",
    originTlsCaBundle: "",
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
        if (get(dialog$)?.creationId === mountedDialog?.creationId) {
          set(resetSave$);
          set(resetRsaImport$);
          set(resetKerberosImport$);
          // StrictMode replays callback refs within the same owner lifetime.
          // Only an actual authority change discards the stored draft here.
          if (get(authenticatedSessionKey$) !== mountedSession) {
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
      set(notice$, {
        code: VNC_ERROR_CODES.INVALID_INPUT,
        source: "kerberos-import",
      });
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
    // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
    const result = await settle(
      // eslint-disable-next-line ccstate/no-with-cleanup -- Legacy 20261022: existing withCleanup only; do not add new usages.
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
          set(notice$, null);
        })(),
        () => {
          bytes?.fill(0);
        },
      ),
      signal,
    );
    if (!result.ok) {
      field.value = "";
      set(notice$, {
        code: VNC_ERROR_CODES.INVALID_INPUT,
        source: "kerberos-import",
      });
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

function initialVncOriginTlsFields(
  connection: VncConnectionResponse | null,
): Pick<
  Editor,
  | "originTlsEnabled"
  | "originTlsTrust"
  | "originTlsServerName"
  | "originTlsCaBundle"
> {
  const origin =
    connection?.transport?.type === "cloudflare_access"
      ? connection.transport.originTls
      : undefined;
  return {
    originTlsEnabled: origin !== undefined,
    originTlsTrust: origin?.trust.mode ?? "system",
    originTlsServerName: origin?.serverName ?? "",
    originTlsCaBundle:
      origin?.trust.mode === "custom_ca" ? origin.trust.caBundle : "",
  };
}

function initialVncKdcFields(
  connection: VncConnectionResponse | null,
): Pick<
  Editor,
  "kdcTransport" | "kdcNetworkConfigId" | "kdcSshConnectionId" | "kdcHost"
> {
  const kdc =
    connection?.security.type === "qemu_x509_gssapi"
      ? connection.security.kdc
      : undefined;
  const transport = kdc?.transport;
  return {
    kdcTransport: transport?.type ?? "direct",
    kdcNetworkConfigId:
      transport && "configId" in transport ? transport.configId : "",
    kdcSshConnectionId: transport?.type === "ssh" ? transport.connectionId : "",
    kdcHost: kdc?.host ?? "",
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
      connection?.transport?.type ??
      (requiresVncProtectiveRoute(profile) ? "ssh" : "direct"),
    networkConfigId:
      connection?.transport && "configId" in connection.transport
        ? connection.transport.configId
        : "",
    ...initialVncOriginTlsFields(connection),
    ...initialVncKdcFields(connection),
    sshConnectionId: sshConnectionId ?? "",
    loopbackHost: connection?.host === "::1" ? "::1" : "127.0.0.1",
    destinationHost: connection?.host ?? "",
    rsaImportedModulusBits: null,
    replace: false,
  };
}

const readVncConnectionLogin$ = command(
  async (
    { get },
    kind: VncDialogState["kind"],
    connection: VncConnectionResponse | null,
    signal: AbortSignal,
  ) => {
    const loginCredential =
      kind === "edit" &&
      connection &&
      "credentialId" in connection &&
      get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup]
        ? (await get(vncCredentials$))?.find((candidate) => {
            return candidate.id === connection.credentialId;
          })
        : undefined;
    signal.throwIfAborted();
    return loginCredential;
  },
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
    const sessionKey = get(authenticatedSessionKey$);
    if (!identity || !sessionKey) {
      return;
    }
    const connection = resource && "host" in resource ? resource : null;
    const credential = resource && "authMethod" in resource ? resource : null;
    const loginCredential = await set(
      readVncConnectionLogin$,
      kind,
      connection,
      signal,
    );
    signal.throwIfAborted();
    if (
      identity !== (await get(vncIdentity$)) ||
      sessionKey !== get(authenticatedSessionKey$)
    ) {
      return;
    }
    signal.throwIfAborted();
    set(closeVncDialog$);
    set(editor$, initialVncEditor(kind, connection, credential));
    const dialog: VncDialogState = {
      identity,
      sessionKey,
      kind,
      connection,
      credential,
      creationId: crypto.randomUUID(),
      ...(loginCredential ? { loginCredential } : {}),
    };
    set(dialog$, dialog);
    if (kind === "create") {
      // eslint-disable-next-line ccstate/no-settle -- Legacy 20261029: existing settle only; do not add new usages.
      const credentials = await settle(get(vncCredentials$), signal);
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
        get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup] ||
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
  readonly transport: VncTransport["type"];
  readonly networkConfigId: string;
  readonly kdcTransport: VncTransport["type"];
  readonly kdcNetworkConfigId: string;
  readonly originTlsEnabled: boolean;
  readonly originTlsTrust: "system" | "custom_ca";
  readonly originTlsServerName: string;
  readonly originTlsCaBundle: string;
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

function connectionTransport(editor: Editor): VncTransport {
  if (editor.transport === "ssh") {
    return { type: "ssh", connectionId: editor.sshConnectionId };
  }
  if (editor.transport === "direct") {
    return { type: "direct" };
  }
  if (editor.transport === "tailscale") {
    return { type: "tailscale", configId: editor.networkConfigId };
  }
  return {
    type: "cloudflare_access",
    configId: editor.networkConfigId,
    ...(editor.originTlsEnabled || requiresVncProtectiveRoute(editor.profile)
      ? {
          originTls: {
            serverName: editor.originTlsServerName,
            trust:
              editor.originTlsTrust === "system"
                ? { mode: "system" as const }
                : {
                    mode: "custom_ca" as const,
                    caBundle: editor.originTlsCaBundle,
                  },
          },
        }
      : {}),
  };
}

function connectionFields(form: HTMLFormElement, editor: Editor) {
  const serverName =
    requiresVncProtectiveRoute(editor.profile) ||
    isRsaAesProfile(editor.profile)
      ? ""
      : editor.tlsServerName.trim();
  return {
    displayName: textField(form, "displayName"),
    host:
      requiresVncProtectiveRoute(editor.profile) && editor.transport === "ssh"
        ? editor.loopbackHost
        : editor.destinationHost,
    port: Number(textField(form, "port")),
    transport: connectionTransport(editor),
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
      : requiresVncProtectiveRoute(editor.profile)
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
                          transport:
                            editor.kdcTransport === "ssh"
                              ? {
                                  type: "ssh" as const,
                                  connectionId: textField(
                                    form,
                                    "kdcSshConnectionId",
                                  ),
                                }
                              : editor.kdcTransport === "direct"
                                ? { type: "direct" as const }
                                : {
                                    type: editor.kdcTransport,
                                    configId: editor.kdcNetworkConfigId,
                                  },
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
        body: {
          expectedGeneration: connection.generation,
        },
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
        body: {
          expectedRevision: credential.revision,
        },
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

export function vncLoginChanged(
  form: HTMLFormElement,
  credential: VncCredentialResponse,
) {
  for (const name of [
    "password",
    "privateKey",
    "certificateChain",
    "kerberosMaterial",
  ]) {
    const input = form.elements.namedItem(name);
    if (
      (input instanceof HTMLInputElement ||
        input instanceof HTMLTextAreaElement) &&
      input.value.length > 0
    ) {
      return true;
    }
  }
  return (
    "username" in credential &&
    textField(form, "username") !== credential.username
  );
}

function vncLoginPatch(
  form: HTMLFormElement,
  credential: VncCredentialResponse,
  profile: VncProfile,
) {
  return vncLoginChanged(form, credential)
    ? updateVncCredentialRequestSchema.safeParse({
        expectedRevision: credential.revision,
        authentication: credentialFields(form, profile).authentication,
      })
    : null;
}

const prepareVncFormSave$ = command(
  async ({ get, set }, form: HTMLFormElement, signal: AbortSignal) => {
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
    const guided =
      get(featureSwitch$)[FeatureSwitchKey.RemoteControlGuidedSetup];
    if (
      guided &&
      (dialog.kind === "create" || dialog.kind === "edit") &&
      editor.selection === "new"
    ) {
      const name = form.elements.namedItem("credentialName");
      if (name instanceof HTMLInputElement) {
        name.value = textField(form, "displayName").trim();
      }
    }
    const login =
      guided &&
      dialog.kind === "edit" &&
      dialog.loginCredential &&
      editor.selection === dialog.loginCredential.id &&
      vncCredentialMatchesProfile(dialog.loginCredential, editor.profile)
        ? vncLoginPatch(form, dialog.loginCredential, editor.profile)
        : null;
    if (login && !login.success) {
      set(notice$, { code: VNC_ERROR_CODES.INVALID_INPUT, source: "save" });
      return;
    }
    const request = dialog.kind.endsWith("-credential")
      ? credentialRequest(clients, dialog, form, editor, signal)
      : connectionRequest(clients, dialog, form, editor, signal);
    if (!request) {
      set(notice$, { code: VNC_ERROR_CODES.INVALID_INPUT, source: "save" });
      return;
    }
    return { dialog, clients, editor, login, request };
  },
);

const handleVncSaveFailure$ = command(
  ({ set }, failure: { readonly status: number; readonly code: string }) => {
    const { status, code } = failure;
    if (status === 500) {
      return;
    }
    set(uncertain$, false);
    set(notice$, { code, source: "save" });
    if (status !== 400) {
      set(resetRsaImport$);
      set(resetKerberosImport$);
      set(conflict$, true);
    }
    return undefined;
  },
);

export const saveVnc$ = command(
  async ({ get, set }, form: HTMLFormElement, parentSignal: AbortSignal) => {
    if (get(uncertain$)) {
      return;
    }
    const signal = set(resetSave$, parentSignal);
    const prepared = await set(prepareVncFormSave$, form, signal);
    signal.throwIfAborted();
    if (!prepared) {
      return;
    }
    const { dialog, clients, login, request } = prepared;
    set(notice$, null);
    set(uncertain$, true);
    let result = await accept<
      Awaited<ReturnType<typeof request>>,
      200 | 201 | 204 | 400 | 404 | 409 | 500
    >(request(), [200, 201, 204, 400, 404, 409, 500], signal);
    signal.throwIfAborted();
    const savedConnectionId =
      (result.status === 200 || result.status === 201) && "host" in result.body
        ? result.body.id
        : dialog.kind === "create"
          ? dialog.creationId
          : dialog.connection?.id;
    if (
      get(dialog$) !== dialog ||
      dialog.identity !== (await get(vncIdentity$))
    ) {
      return;
    }
    signal.throwIfAborted();
    if (
      result.status === 200 &&
      "host" in result.body &&
      login?.success &&
      dialog.loginCredential
    ) {
      const activeDialog = {
        ...dialog,
        connection: result.body,
        connectionSaved: true,
      };
      set(dialog$, activeDialog);
      result = await accept(
        clients.credentials.update({
          params: { credentialId: dialog.loginCredential.id },
          body: login.data,
          fetchOptions: { signal },
        }),
        [200, 400, 404, 409, 500],
        signal,
      );
      signal.throwIfAborted();
      if (
        get(dialog$) !== activeDialog ||
        dialog.identity !== (await get(vncIdentity$))
      ) {
        return;
      }
      signal.throwIfAborted();
    }
    if (
      result.status === 200 ||
      result.status === 201 ||
      result.status === 204
    ) {
      set(closeVncDialog$);
      set(invalidateVnc$);
      return savedConnectionId;
    }
    return set(handleVncSaveFailure$, {
      status: result.status,
      code: result.body.error.code,
    });
  },
);
