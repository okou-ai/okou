import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Input,
  Textarea,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@okouai/ui";
import type { VncConnectionResponse } from "@okouai/api-contracts/contracts/vnc-connections";
import type { VncCredentialResponse } from "@okouai/api-contracts/contracts/vnc-credentials";
import {
  isVncKerberosMethod,
  type VncKerberosMethod,
} from "@okouai/api-contracts/contracts/vnc-kerberos";
import {
  chooseVncKdcSsh$,
  editVncKdcHost$,
  importVncKerberos$,
  invalidateVncKerberosImport$,
  mountVncSecret$,
  vncEditor$,
  vncKerberosSupported$,
} from "../../signals/vnc.ts";
import { sshConnections$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function useKerberosProfileItems() {
  const { t } = useTranslation();
  const supported = useLoadable(vncKerberosSupported$);
  return supported.state === "hasData" && supported.data
    ? [
        {
          value: "qemu_kerberos_ticket",
          label: t(($) => {
            return $.vnc.kerberos.ticket;
          }),
        },
        {
          value: "qemu_kerberos_keytab",
          label: t(($) => {
            return $.vnc.kerberos.keytab;
          }),
        },
        {
          value: "qemu_kerberos_password",
          label: t(($) => {
            return $.vnc.kerberos.password;
          }),
        },
      ]
    : [];
}

export function KerberosCredentialInputs({
  credential,
  method,
}: {
  readonly credential: VncCredentialResponse | null;
  readonly method: VncKerberosMethod;
}) {
  const { t } = useTranslation();
  const importFile = useSet(importVncKerberos$);
  const invalidateImport = useSet(invalidateVncKerberosImport$);
  const pageSignal = useGet(pageSignal$);
  const mountSecret = useSet(mountVncSecret$);
  const existing =
    credential &&
    isVncKerberosMethod(credential.authMethod) &&
    "initiator" in credential
      ? credential
      : null;
  return (
    <div
      className="grid gap-3"
      onInput={(event) => {
        if (
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement
        ) {
          if (event.target.form) {
            invalidateImport(event.target.form);
          }
        }
      }}
    >
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.kerberos.realm;
          })}
        </span>
        <Input
          name="kerberosRealm"
          required
          maxLength={255}
          defaultValue={existing?.initiator.realm ?? ""}
          readOnly={existing !== null}
        />
      </label>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.kerberos.initiator;
          })}
        </span>
        <Textarea
          name="kerberosComponents"
          required
          maxLength={2048}
          defaultValue={existing?.initiator.components.join("\n") ?? ""}
          readOnly={existing !== null}
          aria-describedby="vnc-kerberos-components-help"
        />
      </label>
      <p
        id="vnc-kerberos-components-help"
        className="text-sm text-muted-foreground"
      >
        {t(($) => {
          return $.vnc.kerberos.componentsHelp;
        })}
      </p>
      {method === "qemu_kerberos_ticket" && (
        <>
          <label className="grid gap-2 text-sm">
            <span>
              {t(($) => {
                return $.vnc.kerberos.serviceRealm;
              })}
            </span>
            <Input
              name="kerberosTicketRealm"
              required
              maxLength={255}
              defaultValue={
                existing?.authMethod === "qemu_kerberos_ticket"
                  ? existing.service.realm
                  : ""
              }
              readOnly={existing !== null}
            />
          </label>
          <label className="grid gap-2 text-sm">
            <span>
              {t(($) => {
                return $.vnc.kerberos.serviceInstance;
              })}
            </span>
            <Input
              name="kerberosTicketInstance"
              required
              maxLength={255}
              defaultValue={
                existing?.authMethod === "qemu_kerberos_ticket"
                  ? existing.service.components[1]
                  : ""
              }
              readOnly={existing !== null}
            />
          </label>
        </>
      )}
      {method !== "qemu_kerberos_password" && (
        <>
          <label className="grid gap-2 text-sm">
            <span>
              {method === "qemu_kerberos_ticket"
                ? t(($) => {
                    return $.vnc.kerberos.ticketFile;
                  })
                : t(($) => {
                    return $.vnc.kerberos.keytabFile;
                  })}
            </span>
            <Input
              type="file"
              data-testid="vnc-kerberos-file"
              onChange={(event) => {
                const form = event.currentTarget.form,
                  file = event.currentTarget.files?.[0];
                if (form) {
                  invalidateImport(form);
                }
                if (form && file) {
                  detach(
                    importFile(form, file, pageSignal),
                    Reason.DomCallback,
                  );
                }
              }}
            />
          </label>
          <Input ref={mountSecret} type="hidden" name="kerberosMaterial" />
        </>
      )}
      <p className="text-sm text-muted-foreground">
        {method === "qemu_kerberos_ticket"
          ? t(($) => {
              return $.vnc.kerberos.offlineHelp;
            })
          : t(($) => {
              return $.vnc.kerberos.onlineHelp;
            })}
      </p>
    </div>
  );
}

export function KerberosConnectionFields({
  connection,
}: {
  readonly connection: VncConnectionResponse | null;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  if (!isVncKerberosMethod(editor.profile)) {
    return null;
  }
  const saved =
    connection?.security.type === "qemu_x509_gssapi"
      ? connection.security
      : null;
  return (
    <fieldset className="grid gap-3">
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.kerberos.serviceRealm;
          })}
        </span>
        <Input
          name="kerberosServiceRealm"
          required
          maxLength={255}
          defaultValue={saved?.service.realm ?? ""}
        />
      </label>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.kerberos.serviceInstance;
          })}
        </span>
        <Input
          name="kerberosServiceInstance"
          required
          maxLength={255}
          defaultValue={saved?.service.components[1] ?? ""}
        />
      </label>
      {editor.profile !== "qemu_kerberos_ticket" && (
        <KerberosKdcFields saved={saved} />
      )}
    </fieldset>
  );
}

function KerberosKdcFields({
  saved,
}: {
  readonly saved: Extract<
    VncConnectionResponse["security"],
    { type: "qemu_x509_gssapi" }
  > | null;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const hosts = useLoadable(sshConnections$);
  const choose = useSet(chooseVncKdcSsh$);
  const editHost = useSet(editVncKdcHost$);
  const routes = [
    {
      value: "direct",
      label: t(($) => {
        return $.vnc.transport.direct;
      }),
    },
    ...(hosts.state === "hasData" && hosts.data
      ? hosts.data.map((host) => {
          return { value: host.id, label: host.displayName };
        })
      : []),
  ];
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.kerberos.onlineHelp;
        })}
      </p>
      <label htmlFor="vnc-kdc-route" className="text-sm">
        {t(($) => {
          return $.vnc.kerberos.kdcRoute;
        })}
      </label>
      <Select
        items={routes}
        value={editor.kdcSshConnectionId || "direct"}
        onValueChange={(value) => {
          return choose(value);
        }}
      >
        <SelectTrigger id="vnc-kdc-route">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {routes.map((route) => {
            return (
              <SelectItem key={route.value} value={route.value}>
                {route.label}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <Input
        name="kdcSshConnectionId"
        type="hidden"
        value={editor.kdcSshConnectionId}
        readOnly
      />
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.kerberos.kdcHost;
          })}
        </span>
        <Input
          name="kdcHost"
          required
          value={editor.kdcHost}
          onChange={(event) => {
            return editHost(event.currentTarget.value);
          }}
          pattern={
            editor.kdcSshConnectionId
              ? String.raw`(127\.0\.0\.1|::1)`
              : undefined
          }
          maxLength={253}
        />
      </label>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.port;
          })}
        </span>
        <Input
          name="kdcPort"
          type="number"
          min={1}
          max={65_535}
          required
          defaultValue={saved?.kdc?.port ?? 88}
        />
      </label>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.kerberos.lifetime;
          })}
        </span>
        <Input
          name="kerberosLifetime"
          type="number"
          min={1}
          max={7200}
          required
          defaultValue={saved?.kdc?.ticketLifetimeSeconds ?? 1200}
        />
      </label>
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.kerberos.renewableLifetime;
          })}
        </span>
        <Input
          name="kerberosRenewableLifetime"
          type="number"
          min={0}
          max={7200}
          required
          defaultValue={saved?.kdc?.renewableLifetimeSeconds ?? 7200}
        />
      </label>
    </>
  );
}
