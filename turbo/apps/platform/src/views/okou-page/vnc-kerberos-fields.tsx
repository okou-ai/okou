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
} from "../../signals/vnc.ts";
import { sshConnections$ } from "../../signals/ssh.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { VncNetworkFields } from "./vnc-network-fields.tsx";

export function useKerberosProfileItems() {
  const { t } = useTranslation();
  return [
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
  ];
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
        <KerberosTicketServiceFields credential={existing} />
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

function KerberosTicketServiceFields({
  credential,
}: {
  readonly credential: VncCredentialResponse | null;
}) {
  const { t } = useTranslation();
  const service =
    credential?.authMethod === "qemu_kerberos_ticket"
      ? credential.service
      : null;
  return (
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
          defaultValue={service?.realm ?? ""}
          readOnly={credential !== null}
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
          defaultValue={service?.components[1] ?? ""}
          readOnly={credential !== null}
        />
      </label>
    </>
  );
}

export function KerberosConnectionFields({
  connection,
  disabled,
}: {
  readonly connection: VncConnectionResponse | null;
  readonly disabled: boolean;
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
        <KerberosKdcFields saved={saved} disabled={disabled} />
      )}
    </fieldset>
  );
}

type KerberosConnectionSecurity = Extract<
  VncConnectionResponse["security"],
  { type: "qemu_x509_gssapi" }
>;

function KerberosKdcSshFields({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const hosts = useLoadable(sshConnections$);
  const choose = useSet(chooseVncKdcSsh$);
  const routes =
    hosts.state === "hasData" && hosts.data
      ? hosts.data.map((host) => {
          return { value: host.id, label: host.displayName };
        })
      : [];
  return (
    <>
      <label htmlFor="vnc-kdc-ssh" className="text-sm">
        {t(($) => {
          return $.vnc.transport.sshConnection;
        })}
      </label>
      <Select
        items={routes}
        value={editor.kdcSshConnectionId || null}
        disabled={disabled || hosts.state !== "hasData" || !hosts.data}
        onValueChange={(value) => {
          return choose(value);
        }}
      >
        <SelectTrigger id="vnc-kdc-ssh">
          <SelectValue
            placeholder={t(($) => {
              return $.vnc.transport.select;
            })}
          />
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
      {editor.kdcSshConnectionId &&
        hosts.state === "hasData" &&
        !hosts.data?.some((host) => {
          return host.id === editor.kdcSshConnectionId;
        }) && (
          <p role="alert" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.vnc.transport.selectionUnavailable;
            })}
          </p>
        )}
    </>
  );
}

function KerberosKdcFields({
  saved,
  disabled,
}: {
  readonly saved: KerberosConnectionSecurity | null;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const editor = useGet(vncEditor$);
  const editHost = useSet(editVncKdcHost$);
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.vnc.kerberos.onlineHelp;
        })}
      </p>
      <VncNetworkFields role="kdc" disabled={disabled} />
      {editor.kdcTransport === "ssh" && (
        <KerberosKdcSshFields disabled={disabled} />
      )}
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
            editor.kdcTransport === "ssh"
              ? String.raw`(127\.0\.0\.1|::1)`
              : undefined
          }
          maxLength={253}
        />
      </label>
      {editor.kdcTransport === "direct" && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.vnc.transport.privateDirectHelp;
          })}
        </p>
      )}
      <label className="grid gap-2 text-sm">
        <span>
          {t(($) => {
            return $.vnc.kerberos.kdcPort;
          })}
        </span>
        <Input
          key={editor.kdcTransport}
          name="kdcPort"
          type="number"
          min={1}
          max={65_535}
          required
          defaultValue={
            editor.kdcTransport === "cloudflare_access"
              ? 443
              : (saved?.kdc?.port ?? 88)
          }
          readOnly={editor.kdcTransport === "cloudflare_access"}
        />
      </label>
      <KerberosLifetimeFields saved={saved} />
    </>
  );
}

function KerberosLifetimeFields({
  saved,
}: {
  readonly saved: KerberosConnectionSecurity | null;
}) {
  const { t } = useTranslation();
  return (
    <>
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
