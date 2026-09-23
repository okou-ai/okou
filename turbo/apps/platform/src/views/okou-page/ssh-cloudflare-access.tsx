import { useGet, useLoadable, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";

import {
  chooseSshAccessConfig$,
  sshTransportEditor$,
} from "../../signals/ssh.ts";
import { cloudflareAccessConfigs$ } from "../../signals/cloudflare-access.ts";
import {
  AccessFields,
  CloudflareAccessLoadError,
} from "./cloudflare-access.tsx";

export function AccessSelection({ disabled }: { readonly disabled: boolean }) {
  const { t } = useTranslation();
  const configs = useLoadable(cloudflareAccessConfigs$);
  const editor = useGet(sshTransportEditor$);
  const choose = useSet(chooseSshAccessConfig$);
  const configItems = [
    ...(configs.state === "hasData" && configs.data
      ? configs.data.map((config) => {
          return { value: config.id, label: config.name };
        })
      : []),
    {
      value: "new",
      label: t(($) => {
        return $.cloudflareAccess.createNew;
      }),
    },
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
              {configItems.map((item) => {
                return (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                );
              })}
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
      {editor.configId === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <AccessFields config={null} />
        </div>
      )}
    </fieldset>
  );
}
