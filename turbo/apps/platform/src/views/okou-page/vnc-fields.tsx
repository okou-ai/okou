import { Info } from "lucide-react";
import { RemoteSecretInput } from "./remote-secret-input.tsx";
import { authenticatedSessionKey$ } from "../../signals/auth.ts";
import { useLastResolved, useGet, useLoadable, useSet } from "ccstate-react";
import { VncAuthenticationLabel } from "./vnc-authentication-label.tsx";
import {
  RemoteLoginPicker,
  RemoteSelectedLogin,
} from "./remote-login-controls.tsx";
import {
  remoteControlGuidedEnabled$,
  remoteSetup$,
  chooseRemoteVncProfile$,
} from "../../signals/remote-control-setup.ts";
import { RemoteUsernameHelp } from "./remote-editor-frame.tsx";
import { useTranslation } from "react-i18next";
import {
  Button,
  Checkbox,
  Input,
  Textarea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import {
  VNC_CA_BUNDLE_MAX_LENGTH,
  VNC_HOST_MAX_LENGTH,
  type VncConnectionResponse,
} from "@okouai/api-contracts/contracts/vnc-connections";
import type { SshConnectionResponse } from "@okouai/api-contracts/contracts/ssh-connections";
import {
  VNC_DISPLAY_NAME_MAX_LENGTH,
  VNC_USERNAME_MAX_BYTES,
  VNC_USERNAME_PASSWORD_MAX_BYTES,
  APPLE_DH_FIELD_MAX_BYTES,
  APPLE_RSA_SRP_USERNAME_MAX_BYTES,
  VNC_CLIENT_CHAIN_PEM_MAX_LENGTH,
  VNC_CLIENT_KEY_PEM_MAX_LENGTH,
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  editVncRsaPin$,
  importVncRsaKey$,
  chooseVncCredential$,
  chooseVncLoopbackHost$,
  editVncDestinationHost$,
  editVncServerName$,
  editVncCaBundle$,
  chooseVncProfile$,
  chooseVncSshConnection$,
  chooseVncTrust$,
  replaceVncAuthentication$,
  vncEditor$,
  vncProfile$,
  vncTransport$,
  vncCredentialSelection$,
  vncDialog$,
  vncCredentials$,
  invalidateVnc$,
  mountVncSecret$,
  mountVncCertificateSecret$,
  vncAuthMethodForProfile,
  vncCredentialMatchesProfile,
  requiresVncProtectiveRoute,
  type VncProfile,
} from "../../signals/vnc.ts";
import { invalidateSsh$, sshConnections$ } from "../../signals/ssh.ts";
import {
  RSA_AES_PROFILES,
  isRsaAesProfile,
} from "../../signals/vnc-rsa-aes.ts";
import { useRsaAesProfileLabels } from "./vnc-rsa-aes-labels.ts";
import {
  VNC_RSA_AES_FIELD_MAX_BYTES,
  VNC_RSA_PUBLIC_KEY_MAX_BYTES,
  isVncRsaAesAuthenticationOnly,
} from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { isVncKerberosMethod } from "@okouai/api-contracts/contracts/vnc-kerberos";
import { VncNetworkFields } from "./vnc-network-fields.tsx";
import {
  KerberosCredentialInputs,
  useKerberosProfileItems,
} from "./vnc-kerberos-fields.tsx";

// Fast feedback for literal destinations; the API remains authoritative for
// canonicalization and all other host / route validation.
function isPrivateIpv4Literal(host: string): boolean {
  const parts = host.split(".");
  if (
    parts.length !== 4 ||
    !parts.every((part) => {
      return /^\d{1,3}$/u.test(part) && Number(part) <= 255;
    })
  ) {
    return false;
  }
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

export function isPrivateVncLiteral(host: string): boolean {
  // The API strips one terminal dot before classifying both IP versions.
  const value = host.endsWith(".") ? host.slice(0, -1) : host;
  if (isPrivateIpv4Literal(value)) {
    return true;
  }
  if (!value.includes(":")) {
    return false;
  }
  // Match the API's canonical IPv6 interpretation, including expanded and
  // IPv4-mapped forms; an invalid literal is left to form/API validation.
  const url = `http://[${value}]`;
  if (!URL.canParse(url)) {
    return false;
  }
  const address = new URL(url).hostname.slice(1, -1);
  if (address === "::" || address === "::1") {
    return true;
  }
  const first = Number.parseInt(address.split(":", 1)[0] ?? "", 16);
  if ((first & 0xfe_00) === 0xfc_00 || (first & 0xff_c0) === 0xfe_80) {
    return true;
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(address);
  if (!mapped?.[1] || !mapped[2]) {
    return false;
  }
  const high = Number.parseInt(mapped[1], 16);
  const low = Number.parseInt(mapped[2], 16);
  return isPrivateIpv4Literal(
    `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`,
  );
}

export function VncDisplayNameField({
  connection,
}: {
  readonly connection: VncConnectionResponse | null;
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  return (
    <label className="grid gap-2 text-sm">
      <span>
        {t(($) => {
          return guided ? $.remoteControlSetup.name : $.vnc.displayName;
        })}
      </span>
      <Input
        name="displayName"
        required
        maxLength={VNC_DISPLAY_NAME_MAX_LENGTH}
        defaultValue={connection?.displayName ?? ""}
        placeholder={t(($) => {
          return $.vnc.displayNameHint;
        })}
      />
      {guided && (
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.nameHelp;
          })}
        </span>
      )}
    </label>
  );
}

export function VncEndpointFields({
  connection,
}: {
  readonly connection: VncConnectionResponse | null;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const chooseLoopback = useSet(chooseVncLoopbackHost$);
  const editDestination = useSet(editVncDestinationHost$);
  const apple =
    requiresVncProtectiveRoute(editor.profile) && editor.transport === "ssh";
  const privateDirect =
    !apple &&
    editor.transport === "direct" &&
    isPrivateVncLiteral(editor.destinationHost);
  const loopbackItems = [
    { value: "127.0.0.1", label: "127.0.0.1" },
    { value: "::1", label: "::1" },
  ];
  return (
    <div className="grid gap-3">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
        {apple ? (
          <div className="grid min-w-0 gap-2 text-sm">
            <label htmlFor="vnc-loopback-host">
              {t(($) => {
                return $.vnc.host;
              })}
            </label>
            <Select
              items={loopbackItems}
              value={editor.loopbackHost}
              onValueChange={(value, details) => {
                if (value !== "127.0.0.1" && value !== "::1") {
                  details.cancel();
                  return;
                }
                chooseLoopback(value);
              }}
            >
              <SelectTrigger id="vnc-loopback-host">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {loopbackItems.map((item) => {
                  return (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
        ) : (
          <label className="grid min-w-0 gap-2 text-sm">
            <span>
              {t(($) => {
                return $.vnc.host;
              })}
            </span>
            <Input
              name="host"
              required
              maxLength={VNC_HOST_MAX_LENGTH}
              value={editor.destinationHost}
              onChange={(event) => {
                editDestination(event.currentTarget.value);
              }}
              placeholder={t(($) => {
                return $.vnc.hostHint;
              })}
              aria-describedby={
                privateDirect
                  ? "vnc-destination-help vnc-direct-private-error"
                  : "vnc-destination-help"
              }
              aria-invalid={privateDirect}
            />
          </label>
        )}
        <label className="grid gap-2 text-sm">
          <span>
            {t(($) => {
              return $.vnc.port;
            })}
          </span>
          <Input
            key={editor.transport}
            name="port"
            type="number"
            required
            min={1}
            max={65_535}
            defaultValue={
              editor.transport === "cloudflare_access"
                ? 443
                : (connection?.port ?? 5900)
            }
            readOnly={editor.transport === "cloudflare_access"}
            aria-describedby="vnc-destination-help"
          />
        </label>
      </div>
      {privateDirect && (
        <p
          id="vnc-direct-private-error"
          role="alert"
          className="text-sm text-destructive"
        >
          {t(($) => {
            return $.vnc.transport.privateDirectHelp;
          })}
        </p>
      )}
      <p id="vnc-destination-help" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.transport.destinationHelp;
        })}
      </p>
    </div>
  );
}

export function VncClientCertificateWarning() {
  const { t } = useTranslation();
  return (
    <p
      role="alert"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      {t(($) => {
        return $.vnc.security.clientCertificateHelp;
      })}
    </p>
  );
}

export function VncX509NoneWarning() {
  const { t } = useTranslation();
  return (
    <p
      role="alert"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      {t(($) => {
        return $.vnc.security.x509NoneHelp;
      })}
    </p>
  );
}

function VncSecurityProfileHelp({ profile }: { readonly profile: VncProfile }) {
  const { t } = useTranslation();
  const transport = useGet(vncTransport$);
  if (
    requiresVncProtectiveRoute(profile) &&
    (transport === "cloudflare_access" || transport === "tailscale")
  ) {
    return (
      <div className="grid gap-2 text-sm text-muted-foreground">
        <p role="alert">
          {t(($) => {
            return $.vnc.native.protectionHelp;
          })}
        </p>
        {!isRsaAesProfile(profile) && (
          <p>
            {t(($) => {
              return $.vnc.native.macHelp;
            })}
          </p>
        )}
      </div>
    );
  }
  if (isRsaAesProfile(profile)) {
    return (
      <p
        role={
          isVncRsaAesAuthenticationOnly(RSA_AES_PROFILES[profile].type)
            ? "alert"
            : undefined
        }
        className="text-sm text-muted-foreground"
      >
        {t(($) => {
          return isVncRsaAesAuthenticationOnly(RSA_AES_PROFILES[profile].type)
            ? $.vnc.rsaAes.neHelp
            : $.vnc.rsaAes.fullHelp;
        })}
      </p>
    );
  }
  if (profile === "x509_none") {
    return <VncX509NoneWarning />;
  }
  if (isVncKerberosMethod(profile)) {
    return (
      <p className="text-sm text-muted-foreground">
        {profile === "qemu_kerberos_ticket"
          ? t(($) => {
              return $.vnc.kerberos.offlineHelp;
            })
          : t(($) => {
              return $.vnc.kerberos.onlineHelp;
            })}
      </p>
    );
  }
  if (
    profile === "client_certificate_none" ||
    profile === "client_certificate_vnc"
  ) {
    return <VncClientCertificateWarning />;
  }
  return (
    <p className="text-sm text-muted-foreground">
      {profile === "apple_vnc_password"
        ? t(($) => {
            return $.vnc.security.appleVncPasswordHelp;
          })
        : profile === "apple_dh"
          ? t(($) => {
              return $.vnc.security.appleDhHelp;
            })
          : profile === "apple_srp"
            ? t(($) => {
                return $.vnc.security.appleSrpHelp;
              })
            : profile === "apple_rsa_srp"
              ? t(($) => {
                  return $.vnc.security.appleRsaSrpHelp;
                })
              : profile === "x509_vnc"
                ? t(($) => {
                    return $.vnc.security.x509VncHelp;
                  })
                : profile === "qemu_x509_sasl"
                  ? t(($) => {
                      return $.vnc.security.qemuX509SaslHelp;
                    })
                  : t(($) => {
                      return $.vnc.security.x509PlainHelp;
                    })}
    </p>
  );
}

function useVncSecurityProfileItems() {
  const { t } = useTranslation();
  const rsaAesLabels = useRsaAesProfileLabels();
  const kerberosItems = useKerberosProfileItems();
  return [
    ...kerberosItems,
    ...Object.keys(RSA_AES_PROFILES)
      .filter(isRsaAesProfile)
      .map((value) => {
        return {
          value,
          label: rsaAesLabels[value],
        };
      }),
    {
      value: "x509_none",
      label: t(($) => {
        return $.vnc.security.x509None;
      }),
    },
    {
      value: "x509_vnc",
      label: t(($) => {
        return $.vnc.security.x509Vnc;
      }),
    },
    {
      value: "client_certificate_none",
      label: t(($) => {
        return $.vnc.security.clientCertificateNone;
      }),
    },
    {
      value: "client_certificate_vnc",
      label: t(($) => {
        return $.vnc.security.clientCertificateVnc;
      }),
    },
    {
      value: "x509_plain",
      label: t(($) => {
        return $.vnc.security.x509Plain;
      }),
    },
    {
      value: "qemu_x509_sasl",
      label: t(($) => {
        return $.vnc.security.qemuX509Sasl;
      }),
    },
    {
      value: "apple_vnc_password",
      label: t(($) => {
        return $.vnc.security.appleVncPassword;
      }),
    },
    {
      value: "apple_dh",
      label: t(($) => {
        return $.vnc.security.appleDh;
      }),
    },
    {
      value: "apple_srp",
      label: t(($) => {
        return $.vnc.security.appleSrp;
      }),
    },
    {
      value: "apple_rsa_srp",
      label: t(($) => {
        return $.vnc.security.appleRsaSrp;
      }),
    },
  ];
}

function profileGroup(profile: string) {
  if (profile.startsWith("apple_")) {
    return "apple";
  }
  if (isRsaAesProfile(profile)) {
    return "rsa";
  }
  if (profile.startsWith("qemu_")) {
    return "company";
  }
  return "certificate";
}

function VncProfileGuidance({ profile }: { readonly profile: VncProfile }) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  if (!guided) {
    return <VncSecurityProfileHelp profile={profile} />;
  }
  return (
    <>
      <div className="flex items-start gap-3 rounded-lg bg-gray-50 p-3 text-sm text-muted-foreground">
        <Info size={16} className="mt-0.5 shrink-0" aria-hidden />
        <p>
          {t(($) => {
            return $.remoteControlSetup.vncProfileConfirm;
          })}
        </p>
      </div>
      <details className="border-t border-divider pt-4">
        <summary className="cursor-pointer rounded-md py-1 text-[13px] text-muted-foreground hover:text-foreground">
          {t(($) => {
            return $.remoteControlSetup.vncProfileWhy;
          })}
        </summary>
        <div className="grid gap-3 pt-3 text-sm text-muted-foreground">
          <p>
            {t(($) => {
              return $.remoteControlSetup.serviceHelp;
            })}
          </p>
          <VncSecurityProfileHelp profile={profile} />
        </div>
      </details>
    </>
  );
}

function useVncServiceGroups() {
  const { t } = useTranslation();
  return [
    {
      value: "apple",
      label: t(($) => {
        return $.remoteControlSetup.appleGroup;
      }),
    },
    {
      value: "certificate",
      label: t(($) => {
        return $.remoteControlSetup.certificateGroup;
      }),
    },
    {
      value: "rsa",
      label: t(($) => {
        return $.remoteControlSetup.rsaGroup;
      }),
    },
    {
      value: "company",
      label: t(($) => {
        return $.remoteControlSetup.companyGroup;
      }),
    },
  ];
}

export function VncSecurityProfileField({
  profile,
  disabled,
}: {
  readonly profile: VncProfile;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const chooseProfile = useSet(chooseRemoteVncProfile$);
  const allItems = useVncSecurityProfileItems();
  const guided = useGet(remoteControlGuidedEnabled$);
  const group = profileGroup(profile);
  const profileItems = guided
    ? allItems.filter((item) => {
        return profileGroup(item.value) === group;
      })
    : allItems;
  const groups = useVncServiceGroups();
  return (
    <>
      {guided && (
        <div className="grid gap-2">
          <label htmlFor="vnc-service-group">
            {t(($) => {
              return $.remoteControlSetup.vncGroup;
            })}
          </label>
          <Select
            items={groups}
            value={group}
            disabled={disabled}
            onValueChange={(value) => {
              const first = allItems.find((item) => {
                return profileGroup(item.value) === value;
              });
              if (first) {
                chooseProfile(first.value);
              }
            }}
          >
            <SelectTrigger id="vnc-service-group">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groups.map((item) => {
                return (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                );
              })}
            </SelectContent>
          </Select>
        </div>
      )}
      <label htmlFor="vnc-profile" className="text-sm">
        {t(($) => {
          return guided
            ? $.remoteControlSetup.vncLoginMethod
            : $.vnc.security.profileLabel;
        })}
      </label>
      <Select
        items={profileItems}
        value={profile}
        onValueChange={(value, details) => {
          if (
            value !== "x509_none" &&
            value !== "x509_vnc" &&
            value !== "client_certificate_none" &&
            value !== "client_certificate_vnc" &&
            value !== "x509_plain" &&
            value !== "qemu_x509_sasl" &&
            !(value !== null && isVncKerberosMethod(value)) &&
            value !== "apple_vnc_password" &&
            value !== "apple_dh" &&
            value !== "apple_srp" &&
            value !== "apple_rsa_srp" &&
            !isRsaAesProfile(value)
          ) {
            details.cancel();
            return;
          }
          chooseProfile(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id="vnc-profile">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {profileItems.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <VncProfileGuidance profile={profile} />
    </>
  );
}

function SshConnectionLabel({
  connection,
}: {
  readonly connection: SshConnectionResponse;
}) {
  return (
    <span className="break-all">
      {connection.displayName} · {connection.host}:{connection.port}
    </span>
  );
}

function VncSshConnectionFields({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const connections = useLoadable(sshConnections$);
  const chooseConnection = useSet(chooseVncSshConnection$);
  const retry = useSet(invalidateSsh$);
  const connectionItems =
    connections.state === "hasData" && connections.data !== null
      ? connections.data.map((connection) => {
          return {
            value: connection.id,
            label: `${connection.displayName} · ${connection.host}:${connection.port}`,
          };
        })
      : [];
  const selectedUnavailable =
    editor.transport === "ssh" &&
    editor.sshConnectionId !== "" &&
    connections.state === "hasData" &&
    connections.data !== null &&
    !connections.data.some((connection) => {
      return connection.id === editor.sshConnectionId;
    });
  return (
    <div className="grid min-w-0 gap-2">
      <label htmlFor="vnc-ssh-connection" className="text-sm">
        {t(($) => {
          return $.vnc.transport.sshConnection;
        })}
      </label>
      {connections.state === "hasError" ? (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 text-sm"
        >
          <p>
            {t(($) => {
              return $.vnc.transport.loadFailed;
            })}
          </p>
          <Button type="button" variant="outline" onClick={retry}>
            {t(($) => {
              return $.vnc.retry;
            })}
          </Button>
        </div>
      ) : connections.state === "loading" ? (
        <p role="status" className="text-sm">
          {t(($) => {
            return $.vnc.transport.loading;
          })}
        </p>
      ) : connections.data === null ? (
        <p role="alert" className="text-sm">
          {t(($) => {
            return $.vnc.transport.unavailable;
          })}
        </p>
      ) : connections.data.length === 0 ? (
        <p role="alert" className="text-sm">
          {t(($) => {
            return $.vnc.transport.empty;
          })}
        </p>
      ) : (
        <Select
          items={connectionItems}
          value={editor.sshConnectionId}
          onValueChange={(value, details) => {
            if (
              !connectionItems.some((item) => {
                return item.value === value;
              })
            ) {
              details.cancel();
              return;
            }
            chooseConnection(value);
          }}
          disabled={disabled}
        >
          <SelectTrigger id="vnc-ssh-connection" className="min-w-0">
            <SelectValue
              placeholder={t(($) => {
                return $.vnc.transport.select;
              })}
            />
          </SelectTrigger>
          <SelectContent className="w-(--anchor-width)">
            {connections.data.map((connection) => {
              return (
                <SelectItem key={connection.id} value={connection.id}>
                  <SshConnectionLabel connection={connection} />
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}
      {selectedUnavailable && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.transport.selectionUnavailable;
          })}
        </p>
      )}
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.transport.sshHelp;
        })}
      </p>
    </div>
  );
}

export function VncTransportFields({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const profile = useGet(vncProfile$);
  const transport = useGet(vncTransport$);
  const setup = useGet(remoteSetup$);
  const { t } = useTranslation();
  if (setup?.protocol === "vnc" && requiresVncProtectiveRoute(profile)) {
    return (
      <div className="grid gap-4">
        <p className="text-sm">
          {t(($) => {
            return $.vnc.transport.ssh;
          })}
        </p>
        <VncSshConnectionFields disabled={disabled} />
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-4">
      <VncNetworkFields
        role="rfb"
        disabled={disabled}
        protectedRoute={requiresVncProtectiveRoute(profile)}
      />
      {transport === "ssh" && <VncSshConnectionFields disabled={disabled} />}
    </div>
  );
}

function VncRsaPinFields({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const editPin = useSet(editVncRsaPin$);
  const importKey = useSet(importVncRsaKey$);
  const mountSecret = useSet(mountVncCertificateSecret$);
  const signal = useGet(pageSignal$);
  return (
    <div className="grid gap-3 text-sm">
      <label htmlFor="vnc-rsa-pin">
        {t(($) => {
          return $.vnc.rsaAes.pin;
        })}
      </label>
      <Input
        id="vnc-rsa-pin"
        name="serverKeySha256"
        value={editor.rsaServerKeySha256}
        required
        maxLength={64}
        pattern="[a-fA-F0-9]{64}"
        disabled={disabled}
        className="font-mono text-xs"
        aria-describedby="vnc-rsa-pin-help"
        onChange={(event) => {
          editPin(event.currentTarget.value);
        }}
      />
      <p id="vnc-rsa-pin-help" className="text-muted-foreground">
        {t(($) => {
          return $.vnc.rsaAes.pinHelp;
        })}
      </p>
      <label htmlFor="vnc-rsa-public-key">
        {t(($) => {
          return $.vnc.rsaAes.publicKey;
        })}
      </label>
      <Textarea
        id="vnc-rsa-public-key"
        name="serverPublicKeyPem"
        ref={mountSecret}
        maxLength={VNC_RSA_PUBLIC_KEY_MAX_BYTES}
        disabled={disabled}
        autoComplete="off"
        className="min-h-24 font-mono text-xs"
        aria-describedby="vnc-rsa-import-help"
      />
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={(event) => {
          const form = event.currentTarget.form;
          if (!form) {
            throw new Error("RSA key importer requires its VNC form");
          }
          detach(importKey(form, signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return $.vnc.rsaAes.importKey;
        })}
      </Button>
      <p id="vnc-rsa-import-help" className="text-muted-foreground">
        {t(($) => {
          return $.vnc.rsaAes.importHelp;
        })}
      </p>
      {editor.rsaImportedModulusBits !== null && (
        <p role="status">
          {t(
            ($) => {
              return $.vnc.rsaAes.modulusBits;
            },
            {
              bits: editor.rsaImportedModulusBits,
            },
          )}
        </p>
      )}
    </div>
  );
}

export function VncTlsFields({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const choose = useSet(chooseVncTrust$);
  const editServerName = useSet(editVncServerName$);
  const editCaBundle = useSet(editVncCaBundle$);
  const trustItems = [
    {
      value: "system",
      label: t(($) => {
        return $.vnc.security.system;
      }),
    },
    {
      value: "custom_ca",
      label: t(($) => {
        return $.vnc.security.custom;
      }),
    },
  ];
  if (isRsaAesProfile(editor.profile)) {
    return <VncRsaPinFields disabled={disabled} />;
  }
  if (requiresVncProtectiveRoute(editor.profile)) {
    return null;
  }
  return (
    <div className="grid gap-3">
      <label htmlFor="vnc-server-name" className="text-sm">
        {t(($) => {
          return $.vnc.security.serverName;
        })}
      </label>
      <Input
        id="vnc-server-name"
        name="serverName"
        required={editor.transport === "cloudflare_access"}
        maxLength={VNC_HOST_MAX_LENGTH}
        value={editor.tlsServerName}
        onChange={(event) => {
          editServerName(event.currentTarget.value);
        }}
        placeholder={t(($) => {
          return $.vnc.security.serverNameHint;
        })}
        aria-describedby="vnc-server-name-help"
      />
      <p id="vnc-server-name-help" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.security.serverNameHelp;
        })}
      </p>
      <label htmlFor="vnc-trust" className="text-sm">
        {t(($) => {
          return $.vnc.security.title;
        })}
      </label>
      <Select
        items={trustItems}
        value={editor.trust}
        onValueChange={(value, details) => {
          if (value !== "system" && value !== "custom_ca") {
            details.cancel();
            return;
          }
          choose(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id="vnc-trust">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {trustItems.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {editor.trust === "custom_ca" && (
        <div className="grid gap-2 text-sm">
          <label htmlFor="vnc-ca-bundle">
            {t(($) => {
              return $.vnc.security.caBundle;
            })}
          </label>
          <Textarea
            id="vnc-ca-bundle"
            name="caBundle"
            required
            maxLength={VNC_CA_BUNDLE_MAX_LENGTH}
            aria-describedby="vnc-ca-help"
            value={editor.caBundle}
            onChange={(event) => {
              editCaBundle(event.currentTarget.value);
            }}
            placeholder={t(($) => {
              return $.vnc.security.caHint;
            })}
            className="min-h-32 font-mono text-xs"
          />
          <p id="vnc-ca-help" className="text-muted-foreground">
            {t(($) => {
              return $.vnc.security.caHelp;
            })}
          </p>
        </div>
      )}
    </div>
  );
}

function VncAuthenticationMethodSelector({
  disabled,
  profile,
}: {
  readonly disabled: boolean;
  readonly profile: VncProfile;
}) {
  const { t } = useTranslation();
  const chooseProfile = useSet(chooseVncProfile$);
  const kerberosItems = useKerberosProfileItems();
  const profileItems = [
    ...kerberosItems,
    {
      value: "rsa_aes_ra2",
      label: t(($) => {
        return $.vnc.rsaAes.passwordMethod;
      }),
    },
    {
      value: "rsa_aes_ra2_username_password",
      label: t(($) => {
        return $.vnc.rsaAes.usernamePasswordMethod;
      }),
    },
    {
      value: "x509_vnc",
      label: t(($) => {
        return $.vnc.credential.method;
      }),
    },
    {
      value: "x509_plain",
      label: t(($) => {
        return $.vnc.credential.usernamePasswordMethod;
      }),
    },
    {
      value: "qemu_x509_sasl",
      label: t(($) => {
        return $.vnc.security.qemuX509Sasl;
      }),
    },
    {
      value: "client_certificate_none",
      label: t(($) => {
        return $.vnc.security.clientCertificateNone;
      }),
    },
    {
      value: "client_certificate_vnc",
      label: t(($) => {
        return $.vnc.security.clientCertificateVnc;
      }),
    },
    {
      value: "apple_dh",
      label: t(($) => {
        return $.vnc.credential.appleDhMethod;
      }),
    },
    {
      value: "apple_srp",
      label: t(($) => {
        return $.vnc.credential.appleSrpMethod;
      }),
    },
    {
      value: "apple_rsa_srp",
      label: t(($) => {
        return $.vnc.credential.appleRsaSrpMethod;
      }),
    },
  ];
  return (
    <div className="grid gap-2 text-sm">
      <label htmlFor="vnc-auth-method">
        {t(($) => {
          return $.vnc.credential.authentication;
        })}
      </label>
      <Select
        items={profileItems}
        value={profile}
        onValueChange={(value, details) => {
          if (
            value !== "x509_vnc" &&
            value !== "client_certificate_none" &&
            value !== "client_certificate_vnc" &&
            value !== "x509_plain" &&
            value !== "qemu_x509_sasl" &&
            !(value !== null && isVncKerberosMethod(value)) &&
            value !== "apple_dh" &&
            value !== "apple_srp" &&
            value !== "apple_rsa_srp" &&
            !isRsaAesProfile(value)
          ) {
            details.cancel();
            return;
          }
          chooseProfile(value);
        }}
        disabled={disabled}
      >
        <SelectTrigger id="vnc-auth-method">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {profileItems.map((item) => {
            return (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function VncAuthenticationMethod({
  method,
}: {
  readonly method: VncCredentialResponse["authMethod"];
}) {
  const { t } = useTranslation();
  if (isVncKerberosMethod(method)) {
    return (
      <p className="text-sm">
        {method === "qemu_kerberos_ticket"
          ? t(($) => {
              return $.vnc.kerberos.ticket;
            })
          : method === "qemu_kerberos_keytab"
            ? t(($) => {
                return $.vnc.kerberos.keytab;
              })
            : t(($) => {
                return $.vnc.kerberos.password;
              })}
      </p>
    );
  }
  if (method === "rsa_aes_password" || method === "rsa_aes_username_password") {
    return (
      <p className="text-sm">
        {t(($) => {
          return method === "rsa_aes_password"
            ? $.vnc.rsaAes.passwordMethod
            : $.vnc.rsaAes.usernamePasswordMethod;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-1 text-sm">
      <span className="text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.authentication;
        })}
      </span>
      <span>
        {method === "client_certificate"
          ? t(($) => {
              return $.vnc.security.clientCertificateNone;
            })
          : method === "client_certificate_vnc_password"
            ? t(($) => {
                return $.vnc.security.clientCertificateVnc;
              })
            : method === "vnc_password"
              ? t(($) => {
                  return $.vnc.credential.method;
                })
              : method === "qemu_scram_sha256"
                ? t(($) => {
                    return $.vnc.security.qemuX509Sasl;
                  })
                : method === "apple_dh_username_password"
                  ? t(($) => {
                      return $.vnc.credential.appleDhMethod;
                    })
                  : method === "apple_srp_username_password"
                    ? t(($) => {
                        return $.vnc.credential.appleSrpMethod;
                      })
                    : method === "apple_rsa_srp_username_password"
                      ? t(($) => {
                          return $.vnc.credential.appleRsaSrpMethod;
                        })
                      : t(($) => {
                          return $.vnc.credential.usernamePasswordMethod;
                        })}
      </span>
    </div>
  );
}

function VncAuthenticationReplacement({
  disabled,
  replace,
}: {
  readonly disabled: boolean;
  readonly replace: boolean;
}) {
  const { t } = useTranslation();
  const setReplace = useSet(replaceVncAuthentication$);
  return (
    <div className="grid gap-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={replace}
          disabled={disabled}
          onCheckedChange={(checked) => {
            setReplace(checked);
          }}
        />
        {t(($) => {
          return $.vnc.credential.replace;
        })}
      </label>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.replaceHelp;
        })}
      </p>
    </div>
  );
}

function VncClientCertificateInputs({
  optional = false,
}: {
  readonly optional?: boolean;
}) {
  const { t } = useTranslation();
  const mountSecret = useSet(mountVncCertificateSecret$);
  return (
    <>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.credential.certificateChain;
          })}
        </span>
        <Textarea
          ref={mountSecret}
          name="certificateChain"
          required={!optional}
          maxLength={VNC_CLIENT_CHAIN_PEM_MAX_LENGTH}
          className="min-h-32 font-mono text-xs"
          autoComplete="off"
        />
      </label>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.credential.privateKey;
          })}
        </span>
        <Textarea
          ref={mountSecret}
          name="privateKey"
          required={!optional}
          maxLength={VNC_CLIENT_KEY_PEM_MAX_LENGTH}
          className="min-h-32 font-mono text-xs"
          autoComplete="off"
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.clientKeyHelp;
        })}
      </p>
    </>
  );
}

function VncPasswordInput({
  method,
  optional = false,
}: {
  readonly method: VncCredentialResponse["authMethod"];
  readonly optional?: boolean;
}) {
  const { t } = useTranslation();
  const mountSecret = useSet(mountVncSecret$);
  const classic =
    method === "vnc_password" || method === "client_certificate_vnc_password";
  const rsa =
    method === "rsa_aes_password" || method === "rsa_aes_username_password";
  return (
    <div className="grid gap-2 text-sm">
      <label htmlFor="vnc-password">
        {classic
          ? t(($) => {
              return $.vnc.credential.password;
            })
          : t(($) => {
              return $.vnc.credential.usernamePassword;
            })}
      </label>
      <RemoteSecretInput
        ref={mountSecret}
        id="vnc-password"
        name="password"
        required={!optional}
        autoComplete="new-password"
        aria-describedby="vnc-password-help"
        maxLength={
          rsa
            ? VNC_RSA_AES_FIELD_MAX_BYTES
            : classic
              ? undefined
              : method === "apple_dh_username_password"
                ? APPLE_DH_FIELD_MAX_BYTES
                : VNC_USERNAME_PASSWORD_MAX_BYTES
        }
        pattern={
          classic
            ? "[ -~]{1,8}"
            : method === "qemu_scram_sha256"
              ? "[ -~]{1,1023}"
              : undefined
        }
        placeholder={
          optional
            ? t(($) => {
                return $.remoteControlSetup.keepSavedSecret;
              })
            : classic
              ? t(($) => {
                  return $.vnc.credential.passwordHint;
                })
              : t(($) => {
                  return $.vnc.credential.usernamePasswordHint;
                })
        }
      />
      <p id="vnc-password-help" className="text-muted-foreground">
        {rsa
          ? t(($) => {
              return $.vnc.rsaAes.fieldHelp;
            })
          : classic
            ? t(($) => {
                return $.vnc.credential.passwordHelp;
              })
            : method === "apple_dh_username_password"
              ? t(($) => {
                  return $.vnc.credential.appleDhFieldHelp;
                })
              : method === "qemu_scram_sha256"
                ? t(($) => {
                    return $.vnc.credential.qemuScramPasswordHelp;
                  })
                : t(($) => {
                    return $.vnc.credential.usernamePasswordHelp;
                  })}
      </p>
    </div>
  );
}

function VncAuthenticationInputs({
  credential,
  method,
  optional = false,
}: {
  readonly credential: VncCredentialResponse | null;
  readonly method: VncCredentialResponse["authMethod"];
  readonly optional?: boolean;
}) {
  const { t } = useTranslation();
  const certificate =
    method === "client_certificate" ||
    method === "client_certificate_vnc_password";
  if (isVncKerberosMethod(method)) {
    return (
      <div key={method} className="grid gap-4">
        <KerberosCredentialInputs credential={credential} method={method} />
        {method === "qemu_kerberos_password" && (
          <VncPasswordInput method={method} optional={optional} />
        )}
      </div>
    );
  }
  return (
    <div key={method} className="grid gap-4">
      {certificate && <VncClientCertificateInputs optional={optional} />}
      {method !== "vnc_password" &&
        method !== "rsa_aes_password" &&
        !certificate && (
          <div className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="vnc-username">
                {t(($) => {
                  return $.vnc.credential.username;
                })}
              </label>
              <RemoteUsernameHelp />
            </div>
            <Input
              id="vnc-username"
              name="username"
              required
              maxLength={
                method === "apple_dh_username_password"
                  ? APPLE_DH_FIELD_MAX_BYTES
                  : method === "apple_rsa_srp_username_password"
                    ? APPLE_RSA_SRP_USERNAME_MAX_BYTES
                    : VNC_USERNAME_MAX_BYTES
              }
              defaultValue={
                credential && "username" in credential
                  ? credential.username
                  : ""
              }
              pattern={
                method === "qemu_scram_sha256"
                  ? "(?!.*[,=])[!-~]{1,255}"
                  : undefined
              }
              aria-describedby="vnc-username-help"
              placeholder={t(($) => {
                return $.vnc.credential.usernameHint;
              })}
            />
            <p id="vnc-username-help" className="text-muted-foreground">
              {method === "rsa_aes_username_password"
                ? t(($) => {
                    return $.vnc.rsaAes.fieldHelp;
                  })
                : method === "apple_dh_username_password"
                  ? t(($) => {
                      return $.vnc.credential.appleDhFieldHelp;
                    })
                  : method === "apple_rsa_srp_username_password"
                    ? t(($) => {
                        return $.vnc.credential.appleRsaSrpUsernameHelp;
                      })
                    : method === "qemu_scram_sha256"
                      ? t(($) => {
                          return $.vnc.credential.qemuScramUsernameHelp;
                        })
                      : t(($) => {
                          return $.vnc.credential.usernameHelp;
                        })}
            </p>
          </div>
        )}
      {method !== "client_certificate" && (
        <VncPasswordInput method={method} optional={optional} />
      )}
    </div>
  );
}

function savedVncAuthenticationMethod(
  credential: VncCredentialResponse | null,
  profile: VncProfile,
) {
  const selectedMethod = vncAuthMethodForProfile(profile);
  return (
    credential?.authMethod ??
    (selectedMethod === "none" ? "vnc_password" : selectedMethod)
  );
}

export function VncCredentialFields({
  credential,
  disabled,
  showMethodSelection,
  connectionLogin = false,
}: {
  readonly credential: VncCredentialResponse | null;
  readonly disabled: boolean;
  readonly showMethodSelection: boolean;
  readonly connectionLogin?: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const setup = useGet(remoteSetup$);
  const guided = connectionLogin || (setup !== null && !credential);
  const method = savedVncAuthenticationMethod(credential, editor.profile);
  return (
    <div className="grid gap-4">
      {guided ? (
        <input
          type="hidden"
          name="credentialName"
          defaultValue={credential?.name ?? ""}
        />
      ) : (
        <label className="grid gap-2 text-sm">
          <span>
            {t(($) => {
              return $.vnc.credential.name;
            })}
          </span>
          <Input
            name="credentialName"
            required
            maxLength={VNC_DISPLAY_NAME_MAX_LENGTH}
            defaultValue={credential?.name ?? ""}
            placeholder={t(($) => {
              return $.vnc.credential.nameHint;
            })}
          />
        </label>
      )}
      {showMethodSelection && !credential && (
        <VncAuthenticationMethodSelector
          disabled={disabled}
          profile={editor.profile}
        />
      )}
      {credential && <VncAuthenticationMethod method={method} />}
      {connectionLogin && credential && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.keepSavedLoginHelp;
          })}
        </p>
      )}
      {credential && !connectionLogin && (
        <VncAuthenticationReplacement
          disabled={disabled}
          replace={editor.replace}
        />
      )}
      {(!credential || editor.replace || connectionLogin) && (
        <VncAuthenticationInputs
          credential={credential}
          method={method}
          optional={connectionLogin && credential !== null}
        />
      )}
    </div>
  );
}

function VncCredentialLoadError() {
  const { t } = useTranslation();
  const retry = useSet(invalidateVnc$);
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 text-sm"
    >
      <p>
        {t(($) => {
          return $.vnc.loadFailed;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          retry();
        }}
      >
        {t(($) => {
          return $.vnc.retry;
        })}
      </Button>
    </div>
  );
}

function useVncCredentialSelection() {
  const { t } = useTranslation();
  const credentials = useLoadable(vncCredentials$);
  const profile = useGet(vncProfile$);
  const selection = useGet(vncCredentialSelection$);
  const choose = useSet(chooseVncCredential$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const lastDialog = useLastResolved(vncDialog$);
  const sessionKey = useGet(authenticatedSessionKey$);
  const dialog = lastDialog?.sessionKey === sessionKey ? lastDialog : null;
  const login =
    guided &&
    dialog?.kind === "edit" &&
    dialog.loginCredential?.id === editor.selection &&
    vncCredentialMatchesProfile(dialog.loginCredential, editor.profile)
      ? dialog.loginCredential
      : null;
  const compatibleCredentials =
    credentials.state === "hasData" && credentials.data
      ? credentials.data.filter((credential) => {
          return vncCredentialMatchesProfile(credential, profile);
        })
      : [];
  const credentialItems = [
    ...compatibleCredentials.map((credential) => {
      return { value: credential.id, label: credential.name };
    }),
    {
      value: "new",
      label: t(($) => {
        return $.vnc.credential.createNew;
      }),
    },
  ];
  const selectedCredentialUnavailable =
    selection !== "" &&
    selection !== "new" &&
    credentials.state === "hasData" &&
    credentials.data !== null &&
    !compatibleCredentials.some((credential) => {
      return credential.id === selection;
    });
  return {
    credentials,
    editor,
    guided,
    login,
    choose,
    compatibleCredentials,
    credentialItems,
    selectedCredentialUnavailable,
  };
}

function VncSavedLoginPicker({
  disabled,
  credentials,
}: {
  readonly disabled: boolean;
  readonly credentials: readonly VncCredentialResponse[];
}) {
  const choose = useSet(chooseVncCredential$);
  return (
    <RemoteLoginPicker
      protocol="vnc"
      disabled={disabled}
      choose={(value) => {
        choose(value);
      }}
      items={credentials.map((credential) => {
        return {
          value: credential.id,
          label:
            credential.hosts
              .map((host) => {
                return host.displayName;
              })
              .join(", ") || credential.name,
          description: (
            <>
              <VncAuthenticationLabel method={credential.authMethod} />
              {"username" in credential ? ` · ${credential.username}` : ""}
            </>
          ),
        };
      })}
    />
  );
}

function VncCredentialMenu({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const { guided, credentials, credentialItems, editor, choose } =
    useVncCredentialSelection();
  return (
    <div
      hidden={
        guided && credentials.state === "hasData" && credentials.data !== null
      }
      className="grid gap-2"
    >
      {credentials.state === "hasError" ? (
        <VncCredentialLoadError />
      ) : credentials.state === "loading" ? (
        <p role="status" className="text-sm">
          {t(($) => {
            return $.vnc.loading;
          })}
        </p>
      ) : credentials.data === null ? (
        <p role="alert" className="text-sm">
          {t(($) => {
            return $.vnc.unavailable;
          })}
        </p>
      ) : (
        <Select
          items={credentialItems}
          value={editor.selection}
          onValueChange={(value, details) => {
            if (value === null) {
              details.cancel();
              return;
            }
            choose(value);
          }}
          disabled={disabled}
        >
          <SelectTrigger id="vnc-credential" className="min-w-0">
            <SelectValue
              placeholder={t(($) => {
                return $.vnc.credential.select;
              })}
            />
          </SelectTrigger>
          <SelectContent className="w-(--anchor-width)">
            {credentialItems.map((item) => {
              return (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  className={item.value === "new" ? undefined : "break-all"}
                >
                  {item.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

export function VncCredentialSelection({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const {
    editor,
    guided,
    login,
    choose,
    compatibleCredentials,
    credentialItems,
    selectedCredentialUnavailable,
  } = useVncCredentialSelection();
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend hidden={guided} className="mb-3 text-sm font-semibold">
        <label htmlFor="vnc-credential">
          {t(($) => {
            return $.vnc.credential.label;
          })}
        </label>
      </legend>
      <VncCredentialMenu disabled={disabled} />
      {selectedCredentialUnavailable && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.errors.credentialUnavailable;
          })}
        </p>
      )}
      {login && (
        <VncCredentialFields
          credential={login}
          disabled={disabled}
          showMethodSelection={false}
          connectionLogin
        />
      )}
      {guided && !login && editor.selection && editor.selection !== "new" && (
        <RemoteSelectedLogin
          disabled={disabled}
          label={
            credentialItems.find((item) => {
              return item.value === editor.selection;
            })?.label
          }
          chooseNew={() => {
            choose("new");
          }}
        />
      )}
      {editor.selection === "new" && (
        <div
          className={
            guided
              ? "grid gap-4"
              : "grid gap-4 rounded-lg border bg-muted/30 p-4"
          }
        >
          <VncCredentialFields
            credential={null}
            disabled={disabled}
            showMethodSelection={false}
            connectionLogin={guided}
          />
        </div>
      )}
      {guided && (
        <VncSavedLoginPicker
          disabled={disabled}
          credentials={compatibleCredentials}
        />
      )}
    </fieldset>
  );
}

export function VncCredentialImpact({
  credential,
}: {
  readonly credential: VncCredentialResponse;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p>
        {credential.hosts.length > 0
          ? t(
              ($) => {
                return $.vnc.credential.sharedHelp;
              },
              { count: credential.hosts.length },
            )
          : t(($) => {
              return $.vnc.credential.unused;
            })}
      </p>
      {credential.hosts.length > 0 && (
        <ul className="list-inside list-disc">
          {credential.hosts.map((host) => {
            return (
              <li key={host.id} className="break-all">
                {host.displayName}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
