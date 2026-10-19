import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
import { RemoteTailscaleCredentialHelp } from "./remote-network-help.tsx";
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
  return (
    <fieldset ref={mount} className="grid min-w-0 gap-4">
      <label className="grid gap-2">
        {t(($) => {
          return $.tailscale.clientId;
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
          return $.tailscale.clientSecret;
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

export function TailscaleFields({
  config,
  disabled,
}: {
  readonly config: TailscaleConfig | null;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const replace = useGet(tailscaleReplaceCredentials$);
  const guided = useGet(remoteControlGuidedEnabled$);
  const setReplace = useSet(replaceTailscaleCredentials$);
  return (
    <div className="grid min-w-0 gap-4">
      <label className="grid gap-2">
        {t(($) => {
          return $.cloudflareAccess.name;
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
      {config === null &&
        (guided ? (
          <details>
            <summary className="cursor-pointer rounded-md p-2 text-sm hover:bg-gray-50">
              {t(($) => {
                return $.remoteControlSetup.details;
              })}
            </summary>
            <RemoteTailscaleCredentialHelp />
          </details>
        ) : (
          <TailscaleSetupGuide />
        ))}
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
    </div>
  );
}
