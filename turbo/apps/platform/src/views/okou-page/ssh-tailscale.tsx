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
import {
  chooseSshTailscaleConfig$,
  sshTransportEditor$,
} from "../../signals/ssh.ts";
import { tailscaleConfigs$ } from "../../signals/tailscale.ts";
import { TailscaleFields } from "./tailscale-fields.tsx";
import { SshLoadError } from "./ssh-load-error.tsx";

export function TailscaleSelection({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const configs = useLoadable(tailscaleConfigs$);
  const available = configs.state === "hasData" ? configs.data : null;
  const editor = useGet(sshTransportEditor$);
  const choose = useSet(chooseSshTailscaleConfig$);
  const items = [
    ...(configs.state === "hasData" && configs.data
      ? configs.data.map((config) => {
          return { value: config.id, label: config.name };
        })
      : []),
    {
      value: "new",
      label: t(($) => {
        return $.tailscale.createNew;
      }),
    },
  ];
  return (
    <fieldset className="grid min-w-0 gap-4">
      <legend className="mb-3 text-sm font-semibold">
        {t(($) => {
          return $.tailscale.title;
        })}
      </legend>
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
                return $.tailscale.title;
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
                      {available
                        .filter((config) => {
                          return config.scope === scope;
                        })
                        .map((config) => {
                          return (
                            <SelectItem key={config.id} value={config.id}>
                              {config.name}
                            </SelectItem>
                          );
                        })}
                      {scope === "personal" && (
                        <SelectItem value="new">
                          {t(($) => {
                            return $.tailscale.createNew;
                          })}
                        </SelectItem>
                      )}
                    </SelectGroup>
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
      {editor.tailscaleConfigId === "new" && (
        <div className="grid gap-4 rounded-lg border bg-muted/30 p-4">
          <TailscaleFields config={null} disabled={disabled} />
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.tailscale.addressHelp;
        })}
      </p>
    </fieldset>
  );
}
