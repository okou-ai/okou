import { VncAuthenticationLabel } from "./vnc-authentication-label.tsx";
import { RemoteCredentialCard } from "./remote-credential-card.tsx";
import { RemoteConnectionSummary } from "./remote-connection-summary.tsx";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button, surfaceVariants } from "@okouai/ui";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";
import type { VncCredentialResponse } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  openVncDialog$,
  vncConnections$,
  vncCredentials$,
  vncAuthMethodForProfile,
  vncSshConnectionId,
  vncProfileForConnection,
  hasNativeVncRoute,
  type VncProfile,
} from "../../signals/vnc.ts";
import {
  openSshDialog$,
  sshConnections$,
  usesTailscaleNetwork,
} from "../../signals/ssh.ts";
import { tailscaleEnabled$ } from "../../signals/tailscale.ts";
import type { SshConnectionResponse } from "@okouai/api-contracts/contracts/ssh-connections";
import { isRsaAesProfile } from "../../signals/vnc-rsa-aes.ts";
import { useRsaAesProfileLabels } from "./vnc-rsa-aes-labels.ts";
import { isVncRsaAesAuthenticationOnly } from "@okouai/api-contracts/contracts/vnc-rsa-aes";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  VncClientCertificateWarning,
  VncX509NoneWarning,
} from "./vnc-fields.tsx";
import { VncLoadError } from "./vnc-load-error.tsx";
import { VncAttention, VncHostWarning } from "./vnc-connection-status.tsx";
import { RemoteHostDefaultToggle } from "./remote-access-controls.tsx";
import { VncNativeRoute } from "./vnc-native-route.tsx";

function isX509Security(
  security: VncConnectionResponse["security"],
): security is Extract<
  VncConnectionResponse["security"],
  {
    type:
      | "x509_none"
      | "x509_vnc"
      | "x509_plain"
      | "qemu_x509_sasl"
      | "qemu_x509_gssapi";
  }
> {
  return (
    security.type === "x509_none" ||
    security.type === "x509_vnc" ||
    security.type === "x509_plain" ||
    security.type === "qemu_x509_sasl" ||
    security.type === "qemu_x509_gssapi"
  );
}

function VncProfileLabel({ profile }: { readonly profile: VncProfile }) {
  const { t } = useTranslation();
  const rsaAesLabels = useRsaAesProfileLabels();
  if (isRsaAesProfile(profile)) {
    return rsaAesLabels[profile];
  }
  switch (profile) {
    case "client_certificate_none": {
      return t(($) => {
        return $.vnc.security.clientCertificateNone;
      });
    }
    case "client_certificate_vnc": {
      return t(($) => {
        return $.vnc.security.clientCertificateVnc;
      });
    }
    case "x509_none": {
      return t(($) => {
        return $.vnc.security.x509None;
      });
    }
    case "x509_vnc": {
      return t(($) => {
        return $.vnc.security.x509Vnc;
      });
    }
    case "x509_plain": {
      return t(($) => {
        return $.vnc.security.x509Plain;
      });
    }
    case "qemu_x509_sasl": {
      return t(($) => {
        return $.vnc.security.qemuX509Sasl;
      });
    }
    case "qemu_kerberos_ticket": {
      return t(($) => {
        return $.vnc.kerberos.ticket;
      });
    }
    case "qemu_kerberos_keytab": {
      return t(($) => {
        return $.vnc.kerberos.keytab;
      });
    }
    case "qemu_kerberos_password": {
      return t(($) => {
        return $.vnc.kerberos.password;
      });
    }
    case "apple_vnc_password": {
      return t(($) => {
        return $.vnc.security.appleVncPassword;
      });
    }
    case "apple_dh": {
      return t(($) => {
        return $.vnc.security.appleDh;
      });
    }
    case "apple_srp": {
      return t(($) => {
        return $.vnc.security.appleSrp;
      });
    }
    case "apple_rsa_srp": {
      return t(($) => {
        return $.vnc.security.appleRsaSrp;
      });
    }
  }
  void (profile satisfies never);
  return null;
}

function VncRebindWarning({
  tailscale,
  sshConnection,
}: {
  readonly tailscale: boolean;
  readonly sshConnection: SshConnectionResponse | null | undefined;
}) {
  const { t } = useTranslation();
  const enabled = useGet(tailscaleEnabled$);
  const open = useSet(openSshDialog$);
  const signal = useGet(pageSignal$);
  return (
    <div className="grid gap-3">
      <p
        role="alert"
        className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
      >
        {t(($) => {
          return tailscale
            ? enabled
              ? $.tailscale.vncRebind
              : $.vnc.transport.sshTailscaleNeedsRebind
            : $.vnc.transport.sshNeedsRebind;
        })}
      </p>
      {(!tailscale || enabled) && sshConnection && (
        <Button
          type="button"
          variant="outline"
          className="justify-self-start"
          onClick={() => {
            return detach(
              open("edit", sshConnection, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.tailscale.rebindAction;
          })}
        </Button>
      )}
    </div>
  );
}

function VncHostIdentity({
  connection,
}: {
  readonly connection: VncConnectionResponse;
}) {
  const { t } = useTranslation();
  const profile = vncProfileForConnection(connection);
  const certificateMethod =
    "clientCertificateAuthentication" in connection
      ? connection.clientCertificateAuthentication
      : undefined;
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_minmax(0,1fr)] gap-x-6 gap-y-3 text-sm leading-relaxed sm:grid-cols-[7.25rem_minmax(0,1fr)]">
      {"credentialName" in connection && (
        <>
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.remoteControlSetup.loginHeading;
            })}
          </dt>
          <dd className="min-w-0 break-words">{connection.credentialName}</dd>
        </>
      )}
      <dt className="text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.vncLoginMethod;
        })}
      </dt>
      <dd className="min-w-0 break-words">
        <VncProfileLabel profile={profile} />
      </dd>
      <dt className="text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.authentication;
        })}
      </dt>
      <dd className="min-w-0 break-words">
        <VncAuthenticationLabel
          method={certificateMethod ?? vncAuthMethodForProfile(profile)}
        />
      </dd>
      {isX509Security(connection.security) && (
        <>
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.vnc.security.serverName;
            })}
          </dt>
          <dd className="min-w-0 break-all">
            {connection.security.serverName ?? connection.host}
          </dd>
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.vnc.security.title;
            })}
          </dt>
          <dd className="min-w-0 break-words">
            {connection.security.trust.mode === "system"
              ? t(($) => {
                  return $.vnc.security.system;
                })
              : t(($) => {
                  return $.vnc.security.custom;
                })}
          </dd>
        </>
      )}
      {"serverKeySha256" in connection.security && (
        <>
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.vnc.rsaAes.pin;
            })}
          </dt>
          <dd className="min-w-0 break-all font-mono text-xs leading-6">
            {connection.security.serverKeySha256}
          </dd>
        </>
      )}
    </dl>
  );
}

export function VncHostProfileDetails({
  connection,
  detail = false,
}: {
  readonly connection: VncConnectionResponse;
  readonly detail?: boolean;
}) {
  const { t } = useTranslation();
  const certificateMethod =
    "clientCertificateAuthentication" in connection
      ? connection.clientCertificateAuthentication
      : undefined;
  const profile = vncProfileForConnection(connection);
  return (
    <>
      {detail && <VncHostIdentity connection={connection} />}
      {certificateMethod ? (
        <VncClientCertificateWarning />
      ) : connection.security.type === "x509_none" ? (
        <VncX509NoneWarning />
      ) : null}
      {"serverKeySha256" in connection.security && (
        <>
          {!detail && (
            <p className="break-all font-mono text-xs">
              {t(($) => {
                return $.vnc.rsaAes.pin;
              })}
              : {connection.security.serverKeySha256}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {t(($) => {
              return isVncRsaAesAuthenticationOnly(connection.security.type)
                ? hasNativeVncRoute(connection)
                  ? $.vnc.native.protectionHelp
                  : $.vnc.rsaAes.neHelp
                : $.vnc.rsaAes.fullHelp;
            })}
          </p>
        </>
      )}
      {!detail && (
        <p className="text-sm text-muted-foreground">
          <VncProfileLabel profile={profile} />
          {" · "}
          <VncAuthenticationLabel
            method={certificateMethod ?? vncAuthMethodForProfile(profile)}
          />
          {isX509Security(connection.security) ? (
            <>
              {" "}
              {" · "}{" "}
              {connection.security.trust.mode === "system"
                ? t(($) => {
                    return $.vnc.security.system;
                  })
                : t(($) => {
                    return $.vnc.security.custom;
                  })}
            </>
          ) : null}
        </p>
      )}
    </>
  );
}

function VncHostRouteDetails({
  connection,
  sshConnection,
}: {
  readonly connection: VncConnectionResponse;
  readonly sshConnection: SshConnectionResponse | null | undefined;
}) {
  const { t } = useTranslation();
  const sshConnectionId = vncSshConnectionId(connection);
  return (
    <>
      {connection.transport?.type === "cloudflare_access" ||
      connection.transport?.type === "tailscale" ? (
        <VncNativeRoute transport={connection.transport} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {sshConnectionId
            ? t(($) => {
                return $.vnc.transport.ssh;
              })
            : t(($) => {
                return $.vnc.transport.direct;
              })}
        </p>
      )}
      {sshConnectionId && (
        <p className="break-all text-sm">
          {t(($) => {
            return $.vnc.transport.via;
          })}{" "}
          {sshConnection?.displayName ??
            t(($) => {
              return $.vnc.transport.selectionUnavailable;
            })}
        </p>
      )}
      {connection.security.type === "qemu_x509_gssapi" &&
        connection.security.kdc && (
          <p className="break-all text-sm text-muted-foreground">
            {t(($) => {
              return $.vnc.kerberos.kdcRoute;
            })}
            : {connection.security.kdc.host}:{connection.security.kdc.port}
            <VncNativeRoute transport={connection.security.kdc.transport} />
          </p>
        )}
    </>
  );
}

function VncHostSecurity({
  connection,
  sshConnection,
  detail,
}: {
  readonly connection: VncConnectionResponse;
  readonly sshConnection: SshConnectionResponse | null | undefined;
  readonly detail: boolean;
}) {
  const { t } = useTranslation();
  const destination = `${connection.host.includes(":") ? `[${connection.host}]` : connection.host}:${connection.port}`;
  return (
    <details
      open={!detail}
      className={detail ? "border-t border-divider pt-4" : undefined}
    >
      <summary
        hidden={!detail}
        className="cursor-pointer rounded-md text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t(($) => {
          return $.remoteControlSetup.securityAndPermissions;
        })}
      </summary>
      <div className={detail ? "grid gap-5 pt-5" : "grid gap-3"}>
        {!detail && (
          <>
            <VncHostRouteDetails
              connection={connection}
              sshConnection={sshConnection}
            />
            <p className="break-all text-sm">
              {t(($) => {
                return $.vnc.transport.destination;
              })}
              {": "}
              {destination}
            </p>
            {isX509Security(connection.security) ? (
              <p className="break-all text-sm">
                {t(($) => {
                  return $.vnc.security.serverName;
                })}
                {": "}
                {connection.security.serverName ?? connection.host}
              </p>
            ) : null}
            {"credentialName" in connection && (
              <p className="break-all text-sm text-muted-foreground">
                {connection.credentialName}
              </p>
            )}
          </>
        )}
        <VncHostProfileDetails connection={connection} detail={detail} />
        <RemoteHostDefaultToggle protocol="vnc" connectionId={connection.id} />
      </div>
    </details>
  );
}

export function VncHostCard({
  connection,
  detail = false,
}: {
  readonly connection: VncConnectionResponse;
  readonly detail?: boolean;
}) {
  const { t } = useTranslation();
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  const sshConnections = useLoadable(sshConnections$);
  const sshConnectionId = vncSshConnectionId(connection);
  const sshConnection =
    sshConnectionId !== null && sshConnections.state === "hasData"
      ? sshConnections.data?.find((candidate) => {
          return candidate.id === sshConnectionId;
        })
      : null;
  const sshTransport =
    sshConnection && "transport" in sshConnection
      ? sshConnection.transport
      : null;
  const needsSshRebind =
    typeof sshTransport === "object" &&
    sshTransport !== null &&
    "needsRebind" in sshTransport;
  const tailscale = usesTailscaleNetwork(sshConnection);
  return (
    <article
      className={
        detail ? "grid gap-4" : surfaceVariants({ className: "grid gap-3 p-5" })
      }
    >
      {detail ? (
        <RemoteConnectionSummary
          connection={connection}
          protocol="vnc"
          route={
            <VncHostRouteDetails
              connection={connection}
              sshConnection={sshConnection}
            />
          }
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="break-all font-semibold">
              {connection.displayName}
            </h2>
            <span className="text-sm text-muted-foreground">
              {t(($) => {
                return needsSshRebind
                  ? $.vnc.transport.sshNeedsRebindStatus
                  : $.vnc.configured;
              })}
            </span>
          </div>
        </>
      )}
      {needsSshRebind && (
        <VncRebindWarning tailscale={tailscale} sshConnection={sshConnection} />
      )}
      <VncHostSecurity
        connection={connection}
        sshConnection={sshConnection}
        detail={detail}
      />
      <VncHostWarning
        connectionId={connection.id}
        generation={connection.generation}
        createdAt={connection.createdAt}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          variant={detail ? "quiet" : "outline"}
          onClick={() => {
            detach(open("edit", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return detail ? $.remoteControlSetup.editConnection : $.vnc.edit;
          })}
        </Button>
        <Button
          variant={detail ? "quiet" : "outline"}
          onClick={() => {
            detach(open("delete", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return detail
              ? $.remoteControlSetup.deleteConnection
              : $.vnc.delete;
          })}
        </Button>
      </div>
    </article>
  );
}

export function VncHosts() {
  const { t } = useTranslation();
  const hosts = useLoadable(vncConnections$);
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  if (hosts.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.vnc.loading;
        })}
      </p>
    );
  }
  if (hosts.state === "hasError") {
    return <VncLoadError />;
  }
  if (!hosts.data) {
    return (
      <p>
        {t(($) => {
          return $.vnc.unavailable;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      {hosts.data.length > 0 ? <VncAttention connections={hosts.data} /> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.vnc.summary;
            },
            { count: hosts.data.length },
          )}
        </p>
        <Button
          onClick={() => {
            detach(open("create", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.vnc.add;
          })}
        </Button>
      </div>
      {hosts.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.empty;
          })}
        </p>
      )}
      {hosts.data.map((connection) => {
        return <VncHostCard key={connection.id} connection={connection} />;
      })}
    </div>
  );
}

function VncCredentialCard({
  credential,
}: {
  readonly credential: VncCredentialResponse;
}) {
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  return (
    <RemoteCredentialCard
      name={credential.name}
      method={<VncAuthenticationLabel method={credential.authMethod} />}
      username={"username" in credential ? credential.username : undefined}
      hosts={credential.hosts}
      onEdit={() => {
        detach(open("edit-credential", credential, signal), Reason.DomCallback);
      }}
      onDelete={() => {
        detach(
          open("delete-credential", credential, signal),
          Reason.DomCallback,
        );
      }}
    />
  );
}

export function VncCredentials() {
  const { t } = useTranslation();
  const credentials = useLoadable(vncCredentials$);
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  if (credentials.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.vnc.loading;
        })}
      </p>
    );
  }
  if (credentials.state === "hasError") {
    return <VncLoadError />;
  }
  if (!credentials.data) {
    return (
      <p>
        {t(($) => {
          return $.vnc.unavailable;
        })}
      </p>
    );
  }
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {t(
            ($) => {
              return $.vnc.credential.summary;
            },
            { count: credentials.data.length },
          )}
        </p>
        <Button
          variant="neutral"
          onClick={() => {
            detach(open("create-credential", null, signal), Reason.DomCallback);
          }}
        >
          <Plus size={16} aria-hidden="true" />
          {t(($) => {
            return $.vnc.credential.add;
          })}
        </Button>
      </div>
      {credentials.data.length === 0 && (
        <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.credential.empty;
          })}
        </p>
      )}
      {credentials.data.map((credential) => {
        return (
          <VncCredentialCard key={credential.id} credential={credential} />
        );
      })}
    </div>
  );
}
