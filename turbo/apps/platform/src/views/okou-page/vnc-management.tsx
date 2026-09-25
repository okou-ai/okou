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
  type VncAuthMethod,
  type VncProfile,
} from "../../signals/vnc.ts";
import { sshConnections$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VncCredentialImpact } from "./vnc-fields.tsx";
import { VncLoadError } from "./vnc-load-error.tsx";
import { RemoteHostDefaultToggle } from "./remote-access-controls.tsx";

function isX509Security(
  security: VncConnectionResponse["security"],
): security is Extract<
  VncConnectionResponse["security"],
  { type: "x509_vnc" | "x509_plain" }
> {
  return security.type === "x509_vnc" || security.type === "x509_plain";
}

function VncProfileLabel({ profile }: { readonly profile: VncProfile }) {
  const { t } = useTranslation();
  switch (profile) {
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

function VncAuthenticationLabel({
  method,
}: {
  readonly method: VncAuthMethod;
}) {
  const { t } = useTranslation();
  switch (method) {
    case "vnc_password": {
      return t(($) => {
        return $.vnc.credential.method;
      });
    }
    case "username_password": {
      return t(($) => {
        return $.vnc.credential.usernamePasswordMethod;
      });
    }
    case "apple_dh_username_password": {
      return t(($) => {
        return $.vnc.credential.appleDhMethod;
      });
    }
    case "apple_srp_username_password": {
      return t(($) => {
        return $.vnc.credential.appleSrpMethod;
      });
    }
    case "apple_rsa_srp_username_password": {
      return t(($) => {
        return $.vnc.credential.appleRsaSrpMethod;
      });
    }
  }
  void (method satisfies never);
  return null;
}

function VncRebindWarning() {
  const { t } = useTranslation();
  return (
    <p
      role="alert"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
    >
      {t(($) => {
        return $.vnc.transport.sshNeedsRebind;
      })}
    </p>
  );
}

function VncHostCard({
  connection,
}: {
  readonly connection: VncConnectionResponse;
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
  const needsSshRebind =
    !!sshConnection &&
    "transport" in sshConnection &&
    typeof sshConnection.transport === "object" &&
    sshConnection.transport !== null &&
    "needsRebind" in sshConnection.transport;
  const destination = `${connection.host.includes(":") ? `[${connection.host}]` : connection.host}:${connection.port}`;
  return (
    <article className={surfaceVariants({ className: "grid gap-3 p-5" })}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="break-all font-semibold">{connection.displayName}</h2>
        <span className="text-sm text-muted-foreground">
          {t(($) => {
            return needsSshRebind
              ? $.vnc.transport.sshNeedsRebindStatus
              : $.vnc.configured;
          })}
        </span>
      </div>
      {needsSshRebind && <VncRebindWarning />}
      <p className="text-sm text-muted-foreground">
        {sshConnectionId
          ? t(($) => {
              return $.vnc.transport.ssh;
            })
          : t(($) => {
              return $.vnc.transport.direct;
            })}
      </p>
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
      <p className="break-all text-sm text-muted-foreground">
        {connection.credentialName}
      </p>
      <p className="text-sm text-muted-foreground">
        <VncProfileLabel profile={connection.security.type} />
        {" · "}
        <VncAuthenticationLabel
          method={vncAuthMethodForProfile(connection.security.type)}
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
      <RemoteHostDefaultToggle protocol="vnc" connectionId={connection.id} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            detach(open("edit", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.vnc.edit;
          })}
        </Button>
        <Button
          variant="outline"
          onClick={() => {
            detach(open("delete", connection, signal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.vnc.delete;
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
  const { t } = useTranslation();
  const open = useSet(openVncDialog$);
  const signal = useGet(pageSignal$);
  return (
    <article className={surfaceVariants({ className: "grid gap-3 p-5" })}>
      <h2 className="break-all font-semibold">{credential.name}</h2>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.credential.authentication;
        })}
        {" · "}
        <VncAuthenticationLabel method={credential.authMethod} />
      </p>
      {(credential.authMethod === "username_password" ||
        credential.authMethod === "apple_dh_username_password" ||
        credential.authMethod === "apple_srp_username_password" ||
        credential.authMethod === "apple_rsa_srp_username_password") && (
        <p className="break-all text-sm">{credential.username}</p>
      )}
      <VncCredentialImpact credential={credential} />
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            detach(
              open("edit-credential", credential, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.vnc.credential.edit;
          })}
        </Button>
        <Button
          variant="outline"
          disabled={credential.hosts.length > 0}
          onClick={() => {
            detach(
              open("delete-credential", credential, signal),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.vnc.credential.delete;
          })}
        </Button>
      </div>
      {credential.hosts.length > 0 && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.credential.inUse;
          })}
        </p>
      )}
    </article>
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
