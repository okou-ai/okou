import type { ReactNode } from "react";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import { RemoteNetworkCredentialHelp } from "./remote-network-help.tsx";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Input, Checkbox } from "@okouai/ui";
import {
  TAILSCALE_CREDENTIAL_MAX_LENGTH,
  type TailscaleConfig,
} from "@okouai/api-contracts/contracts/tailscale";
import {
  mountTailscaleSecrets$,
  replaceTailscaleCredentials$,
  tailscaleReplaceCredentials$,
} from "../../signals/tailscale.ts";
import { TailscaleSetupGuide } from "./tailscale-setup-guide.tsx";

function TailscaleCredentials() {
  const { t } = useTranslation();
  const mount = useSet(mountTailscaleSecrets$);
  const guided = useGet(remoteControlGuidedEnabled$);
  return (
    <fieldset ref={mount} className="grid min-w-0 gap-4">
      <label className="grid gap-2">
        {t(($) => {
          return guided ? $.remoteNetworkGuide.clientId : $.tailscale.clientId;
        })}
        <Input
          name="tailscaleClientId"
          type="password"
          required
          maxLength={TAILSCALE_CREDENTIAL_MAX_LENGTH}
          pattern="[!-~]+"
          autoComplete="new-password"
          spellCheck={false}
        />
      </label>
      <label className="grid gap-2">
        {t(($) => {
          return guided
            ? $.remoteNetworkGuide.clientSecret
            : $.tailscale.clientSecret;
        })}
        <Input
          name="tailscaleClientSecret"
          type="password"
          required
          maxLength={TAILSCALE_CREDENTIAL_MAX_LENGTH}
          pattern="[!-~]+"
          autoComplete="new-password"
          spellCheck={false}
        />
      </label>
    </fieldset>
  );
}

function TailscaleTags({
  config,
  guided,
}: {
  readonly config: TailscaleConfig | null;
  readonly guided: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2">
      <label className="grid gap-2">
        {t(($) => {
          return $.tailscale.tags;
        })}
        <Input
          name="tailscaleTags"
          required
          maxLength={1200}
          defaultValue={
            config?.tags.join(", ") ?? (guided ? "tag:okou" : undefined)
          }
          aria-describedby="tailscale-tags-help"
        />
      </label>
      <span id="tailscale-tags-help" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.tailscale.tagsHelp;
        })}
      </span>
    </div>
  );
}

export function TailscaleFields({
  config,
  disabled,
  scopeField,
}: {
  readonly config: TailscaleConfig | null;
  readonly disabled: boolean;
  readonly scopeField?: ReactNode;
}) {
  const { t } = useTranslation();
  const replace = useGet(tailscaleReplaceCredentials$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const setReplace = useSet(replaceTailscaleCredentials$);
  return (
    <div className="grid min-w-0 gap-4">
      <div className="contents">
        <label className="grid gap-2">
          {t(($) => {
            return guided
              ? $.remoteNetworkScope.networkName
              : $.cloudflareAccess.name;
          })}
          <Input
            name="tailscaleName"
            placeholder={t(($) => {
              return $.cloudflareAccess.namePlaceholder;
            })}
            required
            pattern=".*\S.*"
            maxLength={128}
            defaultValue={config?.name}
          />
        </label>
        {scopeField}
        {config === null && !guided && <TailscaleSetupGuide />}

        {!guided && <TailscaleTags config={config} guided={false} />}
        {config && (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={replace}
              disabled={disabled}
              onCheckedChange={(checked) => {
                return setReplace(checked === true);
              }}
            />
            {t(($) => {
              return $.tailscale.replace;
            })}
          </label>
        )}
        {(!config || replace) && <TailscaleCredentials />}
        {guided && (!config || replace) && (
          <RemoteNetworkCredentialHelp provider="tailscale" />
        )}
        {guided && (
          <details>
            <summary className="cursor-pointer text-[13px] text-muted-foreground">
              {t(($) => {
                return $.tailscale.tags;
              })}
            </summary>
            <div className="pt-3">
              <TailscaleTags config={config} guided />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
