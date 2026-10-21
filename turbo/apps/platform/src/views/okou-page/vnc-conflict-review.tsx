import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Button } from "@okouai/ui";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";
import type { VncCredentialResponse } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  acceptVncConflictReview$,
  vncConflict$,
  vncConflictReview$,
  vncSaveMessage$,
  vncSshConnectionId,
  retryVnc$,
  isVncReviewableConflict,
  type VncConflictReviewState,
  type VncDialogState,
} from "../../signals/vnc.ts";
import { sshConnections$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VncCredentialImpact } from "./vnc-fields.tsx";
import { VncHostProfileDetails } from "./vnc-management.tsx";
import { VncAuthenticationLabel } from "./vnc-authentication-label.tsx";
import { VncLoadError } from "./vnc-load-error.tsx";
import { VncNativeRoute } from "./vnc-native-route.tsx";

function SavedSshDetails({ id }: { readonly id: string | null }) {
  const connections = useLoadable(sshConnections$);
  const { t } = useTranslation();
  if (!id) {
    return t(($) => {
      return $.vnc.transport.direct;
    });
  }
  if (connections.state === "loading") {
    return t(($) => {
      return $.vnc.transport.loading;
    });
  }
  if (connections.state === "hasError") {
    return t(($) => {
      return $.vnc.transport.loadFailed;
    });
  }
  const connection = connections.data?.find((candidate) => {
    return candidate.id === id;
  });
  return connection
    ? `${connection.displayName} · ${connection.host}:${connection.port}`
    : t(($) => {
        return $.vnc.transport.selectionUnavailable;
      });
}

function ConnectionDetails({
  connection,
}: {
  readonly connection: VncConnectionResponse;
}) {
  const { t } = useTranslation();
  const security = connection.security;
  return (
    <div className="grid min-w-0 gap-2 break-all">
      <p className="font-medium">{connection.displayName}</p>
      <p>
        {t(($) => {
          return $.vnc.transport.destination;
        })}
        :{" "}
        {connection.host.includes(":")
          ? `[${connection.host}]`
          : connection.host}
        :{connection.port}
      </p>
      <p>
        {t(($) => {
          return $.vnc.transport.title;
        })}
        :{" "}
        {connection.transport?.type === "cloudflare_access" ||
        connection.transport?.type === "tailscale" ? (
          <VncNativeRoute transport={connection.transport} />
        ) : (
          <SavedSshDetails id={vncSshConnectionId(connection)} />
        )}
      </p>
      {"credentialName" in connection && <p>{connection.credentialName}</p>}
      <VncHostProfileDetails connection={connection} />
      {"trust" in security && (
        <>
          <p>
            {t(($) => {
              return $.vnc.security.title;
            })}
            :{" "}
            {t(($) => {
              return security.trust.mode === "system"
                ? $.vnc.security.system
                : $.vnc.security.custom;
            })}
          </p>
          <p>
            {t(($) => {
              return $.vnc.security.serverName;
            })}
            : {security.serverName ?? connection.host}
          </p>
          {security.trust.mode === "custom_ca" && (
            <details>
              <summary className="cursor-pointer">
                {t(($) => {
                  return $.vnc.security.caBundle;
                })}
              </summary>
              <pre className="whitespace-pre-wrap text-xs">
                {security.trust.caBundle}
              </pre>
            </details>
          )}
        </>
      )}
      {security.type === "qemu_x509_gssapi" && (
        <>
          <p>
            {t(($) => {
              return $.vnc.kerberos.serviceRealm;
            })}
            : {security.service.realm}
          </p>
          <p>
            {t(($) => {
              return $.vnc.kerberos.serviceInstance;
            })}
            : {security.service.components.join("/")}
          </p>
          {security.kdc && (
            <>
              <p>
                {t(($) => {
                  return $.vnc.kerberos.kdcHost;
                })}
                : {security.kdc.host}:{security.kdc.port}
              </p>
              <p>
                {t(($) => {
                  return $.vnc.kerberos.kdcRoute;
                })}
                :{" "}
                {security.kdc.transport.type === "cloudflare_access" ||
                security.kdc.transport.type === "tailscale" ? (
                  <VncNativeRoute transport={security.kdc.transport} />
                ) : (
                  <SavedSshDetails
                    id={
                      security.kdc.transport.type === "ssh"
                        ? security.kdc.transport.connectionId
                        : null
                    }
                  />
                )}
              </p>
              <p>
                {t(($) => {
                  return $.vnc.kerberos.lifetime;
                })}
                : {security.kdc.ticketLifetimeSeconds}
              </p>
              <p>
                {t(($) => {
                  return $.vnc.kerberos.renewableLifetime;
                })}
                : {security.kdc.renewableLifetimeSeconds}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}

function CredentialDetails({
  credential,
}: {
  readonly credential: VncCredentialResponse;
}) {
  return (
    <div className="grid gap-2 break-all">
      <p className="font-medium">{credential.name}</p>
      <p>
        <VncAuthenticationLabel method={credential.authMethod} />
      </p>
      {"username" in credential && <p>{credential.username}</p>}
      {"initiator" in credential && (
        <p>
          {credential.initiator.components.join("/")}@
          {credential.initiator.realm}
        </p>
      )}
      {"service" in credential && (
        <p>
          {credential.service.components.join("/")}@{credential.service.realm}
        </p>
      )}
      <VncCredentialImpact credential={credential} />
    </div>
  );
}

function VncConflictReviewActions({
  dialog,
  reviewed,
}: {
  readonly dialog: VncDialogState;
  readonly reviewed: VncConflictReviewState;
}) {
  const { t } = useTranslation();
  const accept = useSet(acceptVncConflictReview$);
  const retry = useSet(retryVnc$);
  const signal = useGet(pageSignal$);
  const destructive =
    dialog.kind === "delete" || dialog.kind === "delete-credential";
  const incompatible =
    dialog.kind === "edit-credential" &&
    reviewed.credential?.authMethod !== dialog.credential?.authMethod;
  const inUse =
    reviewed.kind === "delete-credential" &&
    reviewed.credential.hosts.length > 0;
  return (
    <>
      <p role={incompatible || inUse ? "alert" : undefined}>
        {t(($) => {
          return inUse
            ? $.vnc.credential.inUse
            : incompatible
              ? $.vnc.saveRecovery.incompatible
              : destructive
                ? $.vnc.saveRecovery.deleteHelp
                : $.vnc.saveRecovery.keepHelp;
        })}
      </p>
      {inUse && (
        <Button type="button" variant="outline" onClick={retry}>
          {t(($) => {
            return $.global.actions.tryAgain;
          })}
        </Button>
      )}
      <Button
        type="button"
        variant="outline"
        disabled={incompatible || inUse}
        onClick={() => {
          detach(accept(reviewed, signal), Reason.DomCallback);
        }}
      >
        {t(($) => {
          return destructive
            ? $.vnc.saveRecovery.keepDeletion
            : $.vnc.saveRecovery.keepChanges;
        })}
      </Button>
    </>
  );
}

export function VncConflictReview({
  dialog,
}: {
  readonly dialog: VncDialogState;
}) {
  const { t } = useTranslation();
  const conflict = useGet(vncConflict$);
  const message = useGet(vncSaveMessage$);
  const review = useLoadable(vncConflictReview$);
  if (!conflict || !isVncReviewableConflict(dialog, message)) {
    return null;
  }
  const current = review.state === "hasData" ? review.data : null;
  return (
    <section
      aria-label={t(($) => {
        return $.vnc.saveRecovery.latest;
      })}
      className="grid gap-3 rounded-lg border p-4 text-sm"
    >
      <h3 className="font-semibold">
        {t(($) => {
          return $.vnc.saveRecovery.latest;
        })}
      </h3>
      {review.state === "loading" && (
        <p role="status">
          {t(($) => {
            return $.vnc.loading;
          })}
        </p>
      )}
      {review.state === "hasError" && <VncLoadError />}
      {review.state === "hasData" && !current && (
        <p role="alert">
          {t(($) => {
            return $.vnc.saveRecovery.unavailable;
          })}
        </p>
      )}
      {current && (
        <>
          <p>
            {t(
              ($) => {
                return $.vnc.saveRecovery.version;
              },
              {
                version:
                  current.loginCredential &&
                  message === "VNC_CREDENTIAL_REVISION_CONFLICT"
                    ? current.loginCredential.revision
                    : current.kind === "edit" || current.kind === "delete"
                      ? current.connection.generation
                      : current.credential.revision,
              },
            )}
          </p>
          {current.connection && (
            <ConnectionDetails connection={current.connection} />
          )}
          {current.credential && (
            <CredentialDetails credential={current.credential} />
          )}
          {current.loginCredential && (
            <CredentialDetails credential={current.loginCredential} />
          )}
          <VncConflictReviewActions dialog={dialog} reviewed={current} />
        </>
      )}
    </section>
  );
}
