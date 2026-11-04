import { RemoteSecretInput } from "./remote-secret-input.tsx";
import type { ReactNode } from "react";
import { RemoteNetworkCredentialHelp } from "./remote-network-help.tsx";
import { useGet, useSet } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { Input, Checkbox } from "@okouai/ui";
import { TAILSCALE_CREDENTIAL_MAX_LENGTH } from "@okouai/api-contracts/validators/tailscale";
import type { TailscaleConfig } from "@okouai/api-contracts/contracts/tailscale";
import {
  mountTailscaleSecrets$,
  replaceTailscaleCredentials$,
  tailscaleReplaceCredentials$,
} from "../../signals/tailscale.ts";

function TailscaleCredentials() {
  const { t } = useTranslation();
  const mount = useSet(mountTailscaleSecrets$);
  return (
    <fieldset ref={mount} className="grid min-w-0 gap-4">
      <RemoteNetworkCredentialHelp provider="tailscale" />
      <div className="grid gap-2">
        <label htmlFor="tailscale-tailscaleClientId">
          {t(($) => {
            return $.remoteNetworkGuide.clientId;
          })}
        </label>
        <RemoteSecretInput
          id="tailscale-tailscaleClientId"
          name="tailscaleClientId"
          required
          maxLength={TAILSCALE_CREDENTIAL_MAX_LENGTH}
          pattern="[!-~]+"
          autoComplete="new-password"
          spellCheck={false}
        />
      </div>
      <div className="grid gap-2">
        <label htmlFor="tailscale-tailscaleClientSecret">
          {t(($) => {
            return $.remoteNetworkGuide.clientSecret;
          })}
        </label>
        <RemoteSecretInput
          id="tailscale-tailscaleClientSecret"
          name="tailscaleClientSecret"
          required
          maxLength={TAILSCALE_CREDENTIAL_MAX_LENGTH}
          pattern="[!-~]+"
          autoComplete="new-password"
          spellCheck={false}
        />
      </div>
    </fieldset>
  );
}

function TailscaleTags({
  config,
}: {
  readonly config: TailscaleConfig | null;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-2">
      <label className="grid gap-2">
        {t(($) => {
          return $.remoteControlSetup.allowedTags;
        })}
        <Input
          name="tailscaleTags"
          required
          maxLength={1200}
          defaultValue={config?.tags.join(", ") ?? "tag:okou"}
          aria-describedby="tailscale-tags-help"
        />
      </label>
      <span id="tailscale-tags-help" className="text-sm text-muted-foreground">
        {t(($) => {
          return $.remoteControlSetup.allowedTagsHelp;
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
  readonly scopeField: ReactNode;
}) {
  const { t } = useTranslation();
  const replace = useGet(tailscaleReplaceCredentials$);
  const setReplace = useSet(replaceTailscaleCredentials$);
  return (
    <div className="grid min-w-0 gap-4">
      <div className="contents">
        <div className="grid gap-2">
          <label className="grid gap-2">
            {t(($) => {
              return $.remoteNetworkScope.networkName;
            })}
            <Input
              name="tailscaleName"
              placeholder={t(($) => {
                return $.remoteNetworkScope.networkNamePlaceholder;
              })}
              aria-describedby="tailscale-name-help"
              required
              pattern=".*\S.*"
              maxLength={128}
              defaultValue={config?.name}
            />
          </label>
          <p id="tailscale-name-help" className="text-sm text-muted-foreground">
            {t(($) => {
              return $.remoteNetworkScope.networkNameHelp;
            })}
          </p>
        </div>
        {scopeField}
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
        {config && <TailscaleTags config={config} />}
        {!config && (
          <details className="border-t border-divider pt-4">
            <summary className="cursor-pointer rounded-md py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t(($) => {
                return $.remoteControlSetup.allowedTags;
              })}
            </summary>
            <div className="pt-3">
              <TailscaleTags config={config} />
            </div>
          </details>
        )}
      </div>
    </div>
  );
}
