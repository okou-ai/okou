// TODO(#8609): split large components to comply with max-lines-per-function (128)
// oxlint-disable max-lines-per-function
import { useGet, useLoadable, useSet } from "ccstate-react";
import { Button } from "@okouai/ui";
import { useTranslation } from "react-i18next";
import type { ModelProviderResponse } from "@okouai/api-contracts/contracts/model-providers";
import { orgConfiguredProviders$ } from "../../../../signals/okou-page/settings/org-model-providers.ts";
import { openClaudeCodeDeviceAuthDialog$ } from "../../../../signals/okou-page/settings/claude-code-device-auth.ts";
import { openCodexDeviceAuthDialog$ } from "../../../../signals/okou-page/settings/codex-device-auth.ts";
import { isOrgAdmin$ } from "../../../../signals/org.ts";
import { pageSignal$ } from "../../../../signals/page-signal.ts";
import { detach, Reason } from "../../../../signals/utils.ts";
import {
  ClaudeCodeDeviceAuthDialog,
  PersonalClaudeCodeDeviceAuthDialog,
} from "../settings/claude-code-device-auth-dialog.tsx";
import {
  CodexDeviceAuthDialog,
  PersonalCodexDeviceAuthDialog,
} from "../settings/codex-device-auth-dialog.tsx";
import { OrgModelPoliciesSection } from "./org-model-policies-section.tsx";
import { ModelProviderConnectionsSection } from "./model-provider-connections-section.tsx";

export function OrgProvidersTab() {
  const isAdminLoadable = useLoadable(isOrgAdmin$);
  const isAdmin =
    isAdminLoadable.state === "hasData" ? isAdminLoadable.data : false;

  return (
    <div className="flex flex-col gap-6">
      {isAdmin && <OrgModelPoliciesSection />}
      <StaleBannerSection />
      {isAdmin && <ModelProviderConnectionsSection />}
      <ClaudeCodeDeviceAuthDialog />
      <CodexDeviceAuthDialog />
      {isAdmin && (
        <>
          <PersonalClaudeCodeDeviceAuthDialog />
          <PersonalCodexDeviceAuthDialog />
        </>
      )}
    </div>
  );
}

/**
 * Render the re-connect banner above the provider list when any
 * codex-oauth-token provider has flipped to needsReconnect=true (the
 * firewall refresh pipeline writes this on refresh failure, see #11921).
 * The banner is the primary CTA; the per-row footer also shows a destructive
 * pill so users see the failed row at a glance.
 */
function StaleBannerSection() {
  const providersLoadable = useLoadable(orgConfiguredProviders$);
  const providers =
    providersLoadable.state === "hasData" ? providersLoadable.data : [];
  return <StaleProviderBanner providers={providers} />;
}

function StaleProviderBanner({
  providers,
}: {
  providers: ModelProviderResponse[];
}) {
  const { t } = useTranslation();
  const openClaudeCodeDeviceDialog = useSet(openClaudeCodeDeviceAuthDialog$);
  const openDeviceDialog = useSet(openCodexDeviceAuthDialog$);
  const pageSignal = useGet(pageSignal$);
  const stale = providers.find((p) => {
    return (
      (p.type === "claude-code-oauth-token" ||
        p.type === "codex-oauth-token") &&
      p.needsReconnect
    );
  });
  if (!stale) {
    return null;
  }
  const isClaudeCode = stale.type === "claude-code-oauth-token";
  const message = (() => {
    switch (stale.lastRefreshErrorCode) {
      case "refresh_token_expired": {
        return isClaudeCode
          ? t(($) => {
              return $.settings.models.stale.claudeExpired;
            })
          : t(($) => {
              return $.settings.models.stale.codexExpired;
            });
      }
      case "refresh_token_reused": {
        return t(($) => {
          return $.settings.models.stale.codexReused;
        });
      }
      case "refresh_token_invalidated": {
        return t(($) => {
          return $.settings.models.stale.codexInvalidated;
        });
      }
      default: {
        return isClaudeCode
          ? t(($) => {
              return $.settings.models.stale.claudeFailed;
            })
          : t(($) => {
              return $.settings.models.stale.codexFailed;
            });
      }
    }
  })();
  return (
    <section
      className="flex items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/5 p-4"
      role="alert"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">
          {isClaudeCode
            ? t(($) => {
                return $.settings.models.stale.claudeTitle;
              })
            : t(($) => {
                return $.settings.models.stale.codexTitle;
              })}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{message}</p>
      </div>
      <Button
        type="button"
        onClick={() => {
          if (isClaudeCode) {
            detach(
              openClaudeCodeDeviceDialog("reconnect", pageSignal),
              Reason.DomCallback,
            );
            return;
          }
          detach(openDeviceDialog("reconnect", pageSignal), Reason.DomCallback);
        }}
        size="xs"
        className="shrink-0 text-xs"
      >
        {t(($) => {
          return $.settings.shared.reconnect;
        })}
      </Button>
    </section>
  );
}
