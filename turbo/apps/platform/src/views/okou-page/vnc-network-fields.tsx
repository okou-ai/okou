import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Checkbox,
  Input,
  Textarea,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import {
  VNC_CA_BUNDLE_MAX_LENGTH,
  VNC_HOST_MAX_LENGTH,
} from "@okouai/api-contracts/contracts/vnc-transport";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import { tailscaleConfigs$ } from "../../signals/tailscale.ts";
import {
  chooseVncTransport$,
  chooseVncKdcTransport$,
  chooseVncNetworkConfig$,
  editVncOriginTls$,
  vncTransport$,
  vncKdcTransport$,
  vncNetworkConfigId$,
  vncKdcNetworkConfigId$,
  vncOriginTlsEnabled$,
  vncOriginTlsServerName$,
  vncOriginTlsTrust$,
  vncOriginTlsCaBundle$,
} from "../../signals/vnc.ts";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import { RemoteConnectionMethodHelp } from "./remote-field-help.tsx";

interface NetworkConfigOption {
  readonly id: string;
  readonly name: string;
  readonly scope: "personal" | "organization";
}

function VncNetworkConfigGroups({
  configs,
}: {
  readonly configs: readonly NetworkConfigOption[];
}) {
  const { t } = useTranslation();
  return (["personal", "organization"] as const).map((scope) => {
    const scoped = configs.filter((config) => {
      return config.scope === scope;
    });
    return scoped.length > 0 ? (
      <SelectGroup key={scope}>
        <SelectLabel>
          {scope === "personal"
            ? t(($) => {
                return $.cloudflareAccess.personal;
              })
            : t(($) => {
                return $.cloudflareAccess.organization;
              })}
        </SelectLabel>
        {scoped.map((config) => {
          return (
            <SelectItem key={config.id} value={config.id}>
              {config.name}
            </SelectItem>
          );
        })}
      </SelectGroup>
    ) : null;
  });
}

function VncNetworkEmpty({
  id,
  type,
}: {
  readonly id: string;
  readonly type: "cloudflare_access" | "tailscale";
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  return (
    <p id={id} className="text-sm leading-relaxed text-muted-foreground">
      {t(
        ($) => {
          return guided
            ? $.remoteConnectionHelp.networkEmpty
            : $.vnc.native.empty;
        },
        {
          provider: t(($) => {
            return type === "cloudflare_access"
              ? $.cloudflareAccess.title
              : $.tailscale.title;
          }),
        },
      )}
    </p>
  );
}

function VncNetworkConfig({
  role,
  type,
  disabled,
}: {
  readonly role: "rfb" | "kdc";
  readonly type: "cloudflare_access" | "tailscale";
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const access = useLoadable(cloudflareAccessConfigs$);
  const tailscale = useLoadable(tailscaleConfigs$);
  const configs = type === "cloudflare_access" ? access : tailscale;
  if (configs.state === "loading") {
    return (
      <p role="status">
        {t(($) => {
          return $.vnc.native.loading;
        })}
      </p>
    );
  }
  if (configs.state === "hasError") {
    return (
      <div role="alert" className="grid gap-2 text-sm text-muted-foreground">
        <p>
          {t(($) => {
            return $.vnc.native.loadFailed;
          })}
        </p>
      </div>
    );
  }
  return (
    <VncNetworkConfigSelection
      role={role}
      type={type}
      disabled={disabled}
      available={configs.data}
    />
  );
}

function VncNetworkConfigSelection({
  role,
  type,
  disabled,
  available,
}: {
  readonly role: "rfb" | "kdc";
  readonly type: "cloudflare_access" | "tailscale";
  readonly disabled: boolean;
  readonly available: readonly NetworkConfigOption[] | null;
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const id = useGet(
    role === "rfb" ? vncNetworkConfigId$ : vncKdcNetworkConfigId$,
  );
  const choose = useSet(chooseVncNetworkConfig$);
  const items =
    available?.map((config) => {
      return { value: config.id, label: config.name };
    }) ?? [];
  return (
    <div className="grid min-w-0 gap-2 text-sm">
      <label htmlFor={`vnc-${role}-network-config`}>
        {t(($) => {
          return guided
            ? $.remoteControlSetup.network
            : $.vnc.native.configuration;
        })}
      </label>
      <Select
        items={items}
        disabled={disabled || items.length === 0}
        value={id || null}
        onValueChange={(value) => {
          choose(role, value);
        }}
      >
        <SelectTrigger
          id={`vnc-${role}-network-config`}
          aria-describedby={
            available?.length === 0 ? `vnc-${role}-network-empty` : undefined
          }
        >
          <SelectValue
            placeholder={
              available?.length === 0
                ? t(
                    ($) => {
                      return $.remoteConnectionHelp.networkEmptyPlaceholder;
                    },
                    {
                      provider:
                        type === "tailscale"
                          ? "Tailscale"
                          : "Cloudflare Access",
                    },
                  )
                : t(($) => {
                    return $.vnc.native.select;
                  })
            }
          />
        </SelectTrigger>
        <SelectContent>
          <VncNetworkConfigGroups configs={available ?? []} />
        </SelectContent>
      </Select>
      {id &&
        !available?.some((config) => {
          return config.id === id;
        }) && (
          <p role="alert">
            {t(($) => {
              return $.vnc.native.needsRebind;
            })}
          </p>
        )}
      {available?.length === 0 && (
        <VncNetworkEmpty id={`vnc-${role}-network-empty`} type={type} />
      )}
      {available === null && (
        <p role="alert">
          {t(($) => {
            return $.vnc.unavailable;
          })}
        </p>
      )}
      {!guided && (
        <p className="text-muted-foreground">
          {type === "cloudflare_access"
            ? t(($) => {
                return $.vnc.native.gatewayHelp;
              })
            : t(($) => {
                return $.vnc.native.peerHelp;
              })}
        </p>
      )}
    </div>
  );
}

export function VncNetworkFields({
  role,
  disabled,
  protectedRoute = false,
  hideConnectionDetails = false,
}: {
  readonly role: "rfb" | "kdc";
  readonly disabled: boolean;
  readonly protectedRoute?: boolean;
  readonly hideConnectionDetails?: boolean;
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const type = useGet(role === "rfb" ? vncTransport$ : vncKdcTransport$);
  const chooseRfb = useSet(chooseVncTransport$);
  const chooseKdc = useSet(chooseVncKdcTransport$);
  const items = [
    {
      value: "direct",
      label: t(($) => {
        return guided ? $.remoteControlSetup.direct : $.vnc.transport.direct;
      }),
    },
    {
      value: "ssh",
      label: t(($) => {
        return $.vnc.transport.ssh;
      }),
    },
    {
      value: "cloudflare_access",
      label: t(($) => {
        return $.cloudflareAccess.title;
      }),
    },
    {
      value: "tailscale",
      label: t(($) => {
        return $.tailscale.title;
      }),
    },
  ];
  return (
    <div className="grid min-w-0 gap-4">
      <div className="grid gap-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label htmlFor={`vnc-${role}-route`}>
            {role === "rfb"
              ? t(($) => {
                  return guided
                    ? $.remoteControlSetup.connectionMethod
                    : $.vnc.transport.title;
                })
              : t(($) => {
                  return $.vnc.kerberos.kdcRoute;
                })}
          </label>
          {guided && role === "rfb" && <RemoteConnectionMethodHelp />}
        </div>
        <Select
          items={items}
          disabled={disabled}
          value={type}
          onValueChange={role === "rfb" ? chooseRfb : chooseKdc}
        >
          <SelectTrigger id={`vnc-${role}-route`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => {
              return (
                <SelectItem
                  key={item.value}
                  value={item.value}
                  disabled={protectedRoute && item.value === "direct"}
                >
                  {item.label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        {guided && role === "rfb" && (
          <p className="text-muted-foreground">
            {t(($) => {
              return type === "direct"
                ? $.remoteConnectionHelp.directRoute
                : type === "ssh"
                  ? $.remoteConnectionHelp.sshRoute
                  : type === "tailscale"
                    ? $.remoteConnectionHelp.tailscaleRoute
                    : $.remoteConnectionHelp.cloudflareRoute;
            })}
          </p>
        )}
      </div>
      {(type === "cloudflare_access" || type === "tailscale") && (
        <VncNetworkConfig role={role} type={type} disabled={disabled} />
      )}
      {role === "rfb" && type === "cloudflare_access" && (
        <div hidden={hideConnectionDetails}>
          {guided && !protectedRoute ? (
            <details className="rounded-lg border border-divider p-3">
              <summary className="cursor-pointer rounded-md text-sm text-muted-foreground hover:text-foreground">
                {t(($) => {
                  return $.remoteConnectionHelp.advancedNetwork;
                })}
              </summary>
              <div className="pt-4">
                <VncOriginTlsFields required={false} disabled={disabled} />
              </div>
            </details>
          ) : (
            <VncOriginTlsFields required={protectedRoute} disabled={disabled} />
          )}
        </div>
      )}
    </div>
  );
}

function VncOriginTlsFields({
  required,
  disabled,
}: {
  readonly required: boolean;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const originTlsEnabled = useGet(vncOriginTlsEnabled$);
  const serverName = useGet(vncOriginTlsServerName$);
  const trust = useGet(vncOriginTlsTrust$);
  const caBundle = useGet(vncOriginTlsCaBundle$);
  const edit = useSet(editVncOriginTls$);
  const enabled = required || originTlsEnabled;
  const trusts = [
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
  return (
    <fieldset className="grid min-w-0 gap-3" disabled={disabled}>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={enabled}
          disabled={required || disabled}
          onCheckedChange={(checked) => {
            edit({ originTlsEnabled: checked });
          }}
        />
        {t(($) => {
          return $.vnc.native.originTls;
        })}
      </label>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return guided
            ? $.remoteConnectionHelp.originTls
            : $.vnc.native.originTlsHelp;
        })}
      </p>
      {enabled && (
        <>
          <label className="grid gap-2 text-sm">
            <span>
              {t(($) => {
                return $.vnc.native.originServerName;
              })}
            </span>
            <Input
              required
              maxLength={VNC_HOST_MAX_LENGTH}
              value={serverName}
              onChange={(event) => {
                edit({ originTlsServerName: event.currentTarget.value });
              }}
            />
          </label>
          <div className="grid gap-2 text-sm">
            <label htmlFor="vnc-origin-tls-trust">
              {t(($) => {
                return $.vnc.native.originTrust;
              })}
            </label>
            <Select
              items={trusts}
              value={trust}
              disabled={disabled}
              onValueChange={(value) => {
                if (value === "system" || value === "custom_ca") {
                  edit({ originTlsTrust: value });
                }
              }}
            >
              <SelectTrigger id="vnc-origin-tls-trust">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {trusts.map((item) => {
                  return (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          {trust === "custom_ca" && (
            <label className="grid gap-2 text-sm">
              <span>
                {t(($) => {
                  return $.vnc.native.originCaBundle;
                })}
              </span>
              <Textarea
                required
                maxLength={VNC_CA_BUNDLE_MAX_LENGTH}
                value={caBundle}
                onChange={(event) => {
                  edit({ originTlsCaBundle: event.currentTarget.value });
                }}
              />
            </label>
          )}
        </>
      )}
    </fieldset>
  );
}
