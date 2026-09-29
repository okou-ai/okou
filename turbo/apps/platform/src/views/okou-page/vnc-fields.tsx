import { useGet, useLoadable, useSet } from "ccstate-react";
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
  SegmentControl,
  SegmentControlItem,
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
  type VncCredentialResponse,
} from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  chooseVncCredential$,
  chooseVncLoopbackHost$,
  editVncDestinationHost$,
  editVncServerName$,
  editVncCaBundle$,
  chooseVncProfile$,
  chooseVncSshConnection$,
  chooseVncTransport$,
  chooseVncTrust$,
  replaceVncAuthentication$,
  vncEditor$,
  vncCredentials$,
  invalidateVnc$,
  mountVncSecret$,
  vncAuthMethodForProfile,
  vncCredentialMatchesProfile,
  type VncProfile,
} from "../../signals/vnc.ts";
import { invalidateSsh$, sshConnections$ } from "../../signals/ssh.ts";

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
  return (
    <label className="grid gap-2 text-sm">
      <span>
        {t(($) => {
          return $.vnc.displayName;
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
  const apple = isAppleProfile(editor.profile);
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
            name="port"
            type="number"
            required
            min={1}
            max={65_535}
            defaultValue={connection?.port ?? 5900}
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

export function VncSecurityProfileField({
  profile,
  disabled,
}: {
  readonly profile: VncProfile;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const chooseProfile = useSet(chooseVncProfile$);
  const profileItems = [
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
      value: "x509_plain",
      label: t(($) => {
        return $.vnc.security.x509Plain;
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
  return (
    <>
      <label htmlFor="vnc-profile" className="text-sm">
        {t(($) => {
          return $.vnc.security.profileLabel;
        })}
      </label>
      <Select
        items={profileItems}
        value={profile}
        onValueChange={(value, details) => {
          if (
            value !== "x509_none" &&
            value !== "x509_vnc" &&
            value !== "x509_plain" &&
            value !== "apple_vnc_password" &&
            value !== "apple_dh" &&
            value !== "apple_srp" &&
            value !== "apple_rsa_srp"
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
      <p
        role={profile === "x509_none" ? "alert" : undefined}
        className={
          profile === "x509_none"
            ? "rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
            : "text-sm text-muted-foreground"
        }
      >
        {profile === "x509_none"
          ? t(($) => {
              return $.vnc.security.x509NoneHelp;
            })
          : profile === "apple_vnc_password"
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
                    : t(($) => {
                        return $.vnc.security.x509PlainHelp;
                      })}
      </p>
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
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const chooseTransport = useSet(chooseVncTransport$);
  return (
    <div className="grid min-w-0 gap-4">
      {!isAppleProfile(editor.profile) && (
        <div className="grid gap-2">
          <span id="vnc-connection-mode" className="text-sm">
            {t(($) => {
              return $.vnc.transport.title;
            })}
          </span>
          <SegmentControl
            className="justify-self-start"
            aria-labelledby="vnc-connection-mode"
            disabled={disabled}
            value={editor.transport}
            onValueChange={chooseTransport}
          >
            <SegmentControlItem value="direct">
              {t(($) => {
                return $.vnc.transport.direct;
              })}
            </SegmentControlItem>
            <SegmentControlItem value="ssh">
              {t(($) => {
                return $.vnc.transport.ssh;
              })}
            </SegmentControlItem>
          </SegmentControl>
        </div>
      )}
      {editor.transport === "ssh" && (
        <VncSshConnectionFields disabled={disabled} />
      )}
    </div>
  );
}

function isAppleProfile(profile: VncProfile): boolean {
  return (
    profile === "apple_vnc_password" ||
    profile === "apple_dh" ||
    profile === "apple_srp" ||
    profile === "apple_rsa_srp"
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
  if (isAppleProfile(editor.profile)) {
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
  const profileItems = [
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
            value !== "x509_plain" &&
            value !== "apple_dh" &&
            value !== "apple_srp" &&
            value !== "apple_rsa_srp"
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
  return (
    <div className="grid gap-1 text-sm">
      <span className="text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.authentication;
        })}
      </span>
      <span>
        {method === "vnc_password"
          ? t(($) => {
              return $.vnc.credential.method;
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

function VncAuthenticationInputs({
  credential,
  method,
}: {
  readonly credential: VncCredentialResponse | null;
  readonly method: VncCredentialResponse["authMethod"];
}) {
  const { t } = useTranslation();
  const mountSecret = useSet(mountVncSecret$);
  return (
    <div key={method} className="grid gap-4">
      {method !== "vnc_password" && (
        <div className="grid gap-2 text-sm">
          <label htmlFor="vnc-username">
            {t(($) => {
              return $.vnc.credential.username;
            })}
          </label>
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
              credential && credential.authMethod !== "vnc_password"
                ? credential.username
                : ""
            }
            aria-describedby="vnc-username-help"
            placeholder={t(($) => {
              return $.vnc.credential.usernameHint;
            })}
          />
          <p id="vnc-username-help" className="text-muted-foreground">
            {method === "apple_dh_username_password"
              ? t(($) => {
                  return $.vnc.credential.appleDhFieldHelp;
                })
              : method === "apple_rsa_srp_username_password"
                ? t(($) => {
                    return $.vnc.credential.appleRsaSrpUsernameHelp;
                  })
                : t(($) => {
                    return $.vnc.credential.usernameHelp;
                  })}
          </p>
        </div>
      )}
      <div className="grid gap-2 text-sm">
        <label htmlFor="vnc-password">
          {method === "vnc_password"
            ? t(($) => {
                return $.vnc.credential.password;
              })
            : t(($) => {
                return $.vnc.credential.usernamePassword;
              })}
        </label>
        <Input
          ref={mountSecret}
          id="vnc-password"
          name="password"
          type="password"
          required
          autoComplete="new-password"
          aria-describedby="vnc-password-help"
          maxLength={
            method === "vnc_password"
              ? undefined
              : method === "apple_dh_username_password"
                ? APPLE_DH_FIELD_MAX_BYTES
                : VNC_USERNAME_PASSWORD_MAX_BYTES
          }
          pattern={method === "vnc_password" ? "[ -~]{1,8}" : undefined}
          placeholder={
            method === "vnc_password"
              ? t(($) => {
                  return $.vnc.credential.passwordHint;
                })
              : t(($) => {
                  return $.vnc.credential.usernamePasswordHint;
                })
          }
        />
        <p id="vnc-password-help" className="text-muted-foreground">
          {method === "vnc_password"
            ? t(($) => {
                return $.vnc.credential.passwordHelp;
              })
            : method === "apple_dh_username_password"
              ? t(($) => {
                  return $.vnc.credential.appleDhFieldHelp;
                })
              : t(($) => {
                  return $.vnc.credential.usernamePasswordHelp;
                })}
        </p>
      </div>
    </div>
  );
}

export function VncCredentialFields({
  credential,
  disabled,
  showMethodSelection,
}: {
  readonly credential: VncCredentialResponse | null;
  readonly disabled: boolean;
  readonly showMethodSelection: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const selectedMethod = vncAuthMethodForProfile(editor.profile);
  const method =
    credential?.authMethod ??
    (selectedMethod === "none" ? "vnc_password" : selectedMethod);
  return (
    <div className="grid gap-4">
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
      {showMethodSelection && !credential && (
        <VncAuthenticationMethodSelector
          disabled={disabled}
          profile={editor.profile}
        />
      )}
      {credential && <VncAuthenticationMethod method={method} />}
      {credential && (
        <VncAuthenticationReplacement
          disabled={disabled}
          replace={editor.replace}
        />
      )}
      {(!credential || editor.replace) && (
        <VncAuthenticationInputs credential={credential} method={method} />
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

export function VncCredentialSelection({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const credentials = useLoadable(vncCredentials$);
  const editor = useGet(vncEditor$);
  const choose = useSet(chooseVncCredential$);
  const compatibleCredentials =
    credentials.state === "hasData" && credentials.data
      ? credentials.data.filter((credential) => {
          return vncCredentialMatchesProfile(credential, editor.profile);
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
    editor.selection !== "" &&
    editor.selection !== "new" &&
    credentials.state === "hasData" &&
    credentials.data !== null &&
    !compatibleCredentials.some((credential) => {
      return credential.id === editor.selection;
    });
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend className="mb-3 text-sm font-semibold">
        <label htmlFor="vnc-credential">
          {t(($) => {
            return $.vnc.credential.label;
          })}
        </label>
      </legend>
      <div className="grid gap-2">
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
      {selectedCredentialUnavailable && (
        <p role="alert" className="text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.errors.credentialUnavailable;
          })}
        </p>
      )}
      {editor.selection === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <VncCredentialFields
            credential={null}
            disabled={disabled}
            showMethodSelection={false}
          />
        </div>
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
