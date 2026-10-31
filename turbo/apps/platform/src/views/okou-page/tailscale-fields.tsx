import { RemoteSecretInput } from "./remote-secret-input.tsx";
import type { ReactNode } from "react";
import { remoteControlGuidedEnabled$ } from "../../signals/remote-control-setup.ts";
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
import { TailscaleSetupGuide } from "./tailscale-setup-guide.tsx";

function TailscaleCredentials() {
  const { t } = useTranslation();
  const mount = useSet(mountTailscaleSecrets$);
  const guided = useGet(remoteControlGuidedEnabled$);
  return (
    <fieldset ref={mount} className="grid min-w-0 gap-4">
      {guided && <RemoteNetworkCredentialHelp provider="tailscale" />}
      <div className="grid gap-2">
        <label htmlFor="tailscale-tailscaleClientId">
          {t(($) => {
            return guided
              ? $.remoteNetworkGuide.clientId
              : $.tailscale.clientId;
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
            return guided
              ? $.remoteNetworkGuide.clientSecret
              : $.tailscale.clientSecret;
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
          return guided ? $.remoteControlSetup.allowedTags : $.tailscale.tags;
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
          return guided
            ? $.remoteControlSetup.allowedTagsHelp
            : $.tailscale.tagsHelp;
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
        <div className="grid gap-2">
          <label className="grid gap-2">
            {t(($) => {
              return guided
                ? $.remoteNetworkScope.networkName
                : $.cloudflareAccess.name;
            })}
            <Input
              name="tailscaleName"
              placeholder={t(($) => {
                return guided
                  ? $.remoteNetworkScope.networkNamePlaceholder
                  : $.cloudflareAccess.namePlaceholder;
              })}
              aria-describedby={guided ? "tailscale-name-help" : undefined}
              required
              pattern=".*\S.*"
              maxLength={128}
              defaultValue={config?.name}
            />
          </label>
          {guided && (
            <p
              id="tailscale-name-help"
              className="text-sm text-muted-foreground"
            >
              {t(($) => {
                return $.remoteNetworkScope.networkNameHelp;
              })}
            </p>
          )}
        </div>
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
        {guided && config && <TailscaleTags config={config} guided />}
        {guided && !config && (
          <details className="border-t border-divider pt-4">
            <summary className="cursor-pointer rounded-md py-1 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t(($) => {
                return $.remoteControlSetup.allowedTags;
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
