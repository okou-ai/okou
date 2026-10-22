import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import {
  chooseSshTailscaleConfig$,
  sshConnectionModeEditor$,
} from "../../signals/ssh.ts";
import { tailscaleConfigs$ } from "../../signals/tailscale.ts";
import { TailscaleFields } from "./tailscale-fields.tsx";
import { SshLoadError } from "./ssh-load-error.tsx";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";

function TailscaleConfigGroup({
  scope,
  configs,
}: {
  readonly scope: "personal" | "organization";
  readonly configs: readonly TailscaleConfig[];
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const scoped = configs.filter((config) => {
    return config.scope === scope;
  });
  if (scope === "organization" && scoped.length === 0) {
    return null;
  }
  return (
    <SelectGroup>
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
      {!guided && scope === "personal" && (
        <SelectItem value="new">
          {t(($) => {
            return $.tailscale.createNew;
          })}
        </SelectItem>
      )}
    </SelectGroup>
  );
}

export function TailscaleSelection({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const configs = useLoadable(tailscaleConfigs$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const available = configs.state === "hasData" ? configs.data : null;
  const editor = useGet(sshConnectionModeEditor$);
  const choose = useSet(chooseSshTailscaleConfig$);
  const items = [
    ...(configs.state === "hasData" && configs.data
      ? configs.data.map((config) => {
          return { value: config.id, label: config.name };
        })
      : []),
    ...(!guided
      ? [
          {
            value: "new",
            label: t(($) => {
              return $.tailscale.createNew;
            }),
          },
        ]
      : []),
  ];
  return (
    <fieldset className="grid min-w-0 gap-4">
      {!guided && (
        <legend className="mb-3 text-sm font-semibold">
          {t(($) => {
            return $.tailscale.title;
          })}
        </legend>
      )}
      {configs.state === "hasError" ? (
        <SshLoadError />
      ) : configs.state === "loading" ? (
        <p role="status">
          {t(($) => {
            return $.tailscale.loading;
          })}
        </p>
      ) : (
        available && (
          <div className="grid gap-2">
            <label htmlFor="ssh-tailscale-config">
              {t(($) => {
                return guided
                  ? $.remoteControlSetup.network
                  : $.tailscale.title;
              })}
            </label>
            <Select
              items={items}
              disabled={disabled}
              value={editor.tailscaleConfigId || null}
              onValueChange={(value, details) => {
                if (value === null) {
                  details.cancel();
                  return;
                }
                choose(value);
              }}
            >
              <SelectTrigger id="ssh-tailscale-config">
                <SelectValue
                  placeholder={t(($) => {
                    return $.tailscale.select;
                  })}
                />
              </SelectTrigger>
              <SelectContent>
                {(["personal", "organization"] as const).map((scope) => {
                  return (
                    <TailscaleConfigGroup
                      key={scope}
                      scope={scope}
                      configs={available}
                    />
                  );
                })}
              </SelectContent>
            </Select>
            {editor.tailscaleConfigId &&
              editor.tailscaleConfigId !== "new" &&
              !available.some((config) => {
                return config.id === editor.tailscaleConfigId;
              }) && (
                <p role="alert">
                  {t(($) => {
                    return $.tailscale.missing;
                  })}
                </p>
              )}
          </div>
        )
      )}
      {!guided && editor.tailscaleConfigId === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <TailscaleFields config={null} disabled={disabled} />
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return guided && available?.length === 0
            ? $.remoteControlSetup.networkManagementHelp
            : guided
              ? $.remoteConnectionHelp.tailscaleRoute
              : $.tailscale.addressHelp;
        })}
      </p>
    </fieldset>
  );
}
