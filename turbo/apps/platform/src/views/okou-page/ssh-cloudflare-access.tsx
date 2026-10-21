import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import type { ScopedCloudflareAccessConfig } from "@okouai/api-contracts/contracts/cloudflare-access";

import {
  chooseSshAccessConfig$,
  sshConnectionModeEditor$,
} from "../../signals/ssh.ts";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import {
  AccessFields,
  CloudflareAccessLoadError,
} from "./cloudflare-access.tsx";

function AccessConfigOptions({
  configs,
}: {
  readonly configs: readonly ScopedCloudflareAccessConfig[];
}) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const personal = configs.filter((config) => {
    return config.scope === "personal";
  });
  const organization = configs.filter((config) => {
    return config.scope === "organization";
  });
  return (
    <>
      <SelectGroup>
        <SelectLabel>
          {t(($) => {
            return $.cloudflareAccess.personal;
          })}
        </SelectLabel>
        {personal.map((config) => {
          return (
            <SelectItem key={config.id} value={config.id}>
              {config.name}
            </SelectItem>
          );
        })}
        {!guided && (
          <SelectItem value="new">
            {t(($) => {
              return $.cloudflareAccess.createNew;
            })}
          </SelectItem>
        )}
      </SelectGroup>
      {organization.length > 0 && (
        <SelectGroup>
          <SelectLabel>
            {t(($) => {
              return $.cloudflareAccess.organization;
            })}
          </SelectLabel>
          {organization.map((config) => {
            return (
              <SelectItem key={config.id} value={config.id}>
                {config.name}
              </SelectItem>
            );
          })}
        </SelectGroup>
      )}
    </>
  );
}

export function AccessSelection({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const guided = useGet(remoteControlGuidedEnabled$);
  const configs = useLoadable(cloudflareAccessConfigs$);
  const editor = useGet(sshConnectionModeEditor$);
  const choose = useSet(chooseSshAccessConfig$);
  const configItems = [
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
              return $.cloudflareAccess.createNew;
            }),
          },
        ]
      : []),
  ];
  if (configs.state === "hasData" && configs.data === null) {
    return (
      <p role="alert" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.cloudflareAccess.unavailable;
        })}
      </p>
    );
  }
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend className="mb-3 text-sm font-semibold">
        {t(($) => {
          return $.cloudflareAccess.title;
        })}
      </legend>
      {configs.state === "hasError" ? (
        <CloudflareAccessLoadError />
      ) : configs.state === "loading" ? (
        <p role="status">
          {t(($) => {
            return $.cloudflareAccess.loading;
          })}
        </p>
      ) : configs.data ? (
        <div className="grid gap-2">
          <label htmlFor="ssh-access-config">
            {t(($) => {
              return $.cloudflareAccess.configuration;
            })}
          </label>
          <Select
            items={configItems}
            disabled={disabled}
            value={editor.configId || null}
            onValueChange={(value, details) => {
              if (value === null) {
                details.cancel();
                return;
              }
              choose(value);
            }}
          >
            <SelectTrigger id="ssh-access-config">
              <SelectValue
                placeholder={t(($) => {
                  return $.cloudflareAccess.select;
                })}
              />
            </SelectTrigger>
            <SelectContent>
              <AccessConfigOptions configs={configs.data} />
            </SelectContent>
          </Select>
          {editor.configId &&
            editor.configId !== "new" &&
            !configs.data.some((config) => {
              return config.id === editor.configId;
            }) && (
              <p role="alert">
                {t(($) => {
                  return $.cloudflareAccess.missing;
                })}
              </p>
            )}
        </div>
      ) : null}
      {guided && configs.state === "hasData" && configs.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.remoteControlSetup.networkManagementHelp;
          })}
        </p>
      )}
      {!guided && editor.configId === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <AccessFields config={null} />
        </div>
      )}
    </fieldset>
  );
}
