import { ChevronRight, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@okouai/ui";

const RECOMMENDED_TAG = "tag:okou";
const ACCESS_CONTROLS_URL = "https://console.tailscale.com/admin/acls";
const TRUST_CREDENTIALS_URL =
  "https://console.tailscale.com/admin/settings/trust-credentials";

function TagInstructions() {
  const { t } = useTranslation();
  return (
    <TabsContent value="tags" className="grid min-w-0 gap-2 text-sm">
      <p className="text-muted-foreground">
        {t(($) => {
          return $.tailscale.guide.tagsHelp;
        })}
      </p>
      <a
        href={ACCESS_CONTROLS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-link underline underline-offset-4 hover:text-link-hover"
      >
        {t(($) => {
          return $.tailscale.guide.accessControls;
        })}
        <ExternalLink size={12} aria-hidden />
      </a>
    </TabsContent>
  );
}

function OAuthInstructions() {
  const { t } = useTranslation();
  return (
    <TabsContent value="oauth" className="grid min-w-0 gap-2 text-sm">
      <p className="text-muted-foreground">
        {t(($) => {
          return $.tailscale.guide.oauthHelp;
        })}
      </p>
      <a
        href={TRUST_CREDENTIALS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-link underline underline-offset-4 hover:text-link-hover"
      >
        {t(($) => {
          return $.tailscale.guide.trustCredentials;
        })}
        <ExternalLink size={12} aria-hidden />
      </a>
    </TabsContent>
  );
}

function AccessRuleInstructions() {
  const { t } = useTranslation();
  return (
    <TabsContent value="rules" className="grid min-w-0 gap-3 text-sm">
      <p className="text-muted-foreground">
        {t(($) => {
          return $.tailscale.guide.rulesHelp;
        })}
      </p>
      <dl className="grid gap-2">
        <div className="grid grid-cols-2 gap-2">
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.tailscale.guide.source;
            })}
          </dt>
          <dd>
            <code>{RECOMMENDED_TAG}</code>
          </dd>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.tailscale.guide.destination;
            })}
          </dt>
          <dd>
            {t(($) => {
              return $.tailscale.guide.allUsersAndDevices;
            })}
          </dd>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <dt className="text-muted-foreground">
            {t(($) => {
              return $.tailscale.guide.portAndProtocol;
            })}
          </dt>
          <dd>
            {t(($) => {
              return $.tailscale.guide.allPortsAndProtocols;
            })}
          </dd>
        </div>
      </dl>
      <p className="text-muted-foreground">
        {t(($) => {
          return $.tailscale.guide.policyHelp;
        })}
      </p>
      <a
        href={ACCESS_CONTROLS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1 text-link underline underline-offset-4 hover:text-link-hover"
      >
        {t(($) => {
          return $.tailscale.guide.accessControls;
        })}
        <ExternalLink size={12} aria-hidden />
      </a>
    </TabsContent>
  );
}

export function TailscaleSetupGuide() {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(($) => {
        return $.tailscale.guide.title;
      })}
      className="min-w-0 rounded-lg border bg-gray-50"
    >
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium hover:bg-state-hover">
          <ChevronRight
            size={16}
            aria-hidden="true"
            className="shrink-0 transition-transform group-open:rotate-90"
          />
          <span>
            {t(($) => {
              return $.tailscale.guide.title;
            })}
          </span>
        </summary>
        <Tabs defaultValue="tags" className="grid min-w-0 gap-3 px-3 pb-3">
          <TabsList
            aria-label={t(($) => {
              return $.tailscale.guide.stepsLabel;
            })}
            className="grid h-auto w-full grid-cols-3"
          >
            <TabsTrigger
              type="button"
              value="tags"
              className="min-h-9 min-w-0 whitespace-normal px-2 py-2 text-xs"
            >
              {t(($) => {
                return $.tailscale.guide.tags;
              })}
            </TabsTrigger>
            <TabsTrigger
              type="button"
              value="oauth"
              className="min-h-9 min-w-0 whitespace-normal px-2 py-2 text-xs"
            >
              {t(($) => {
                return $.tailscale.guide.oauth;
              })}
            </TabsTrigger>
            <TabsTrigger
              type="button"
              value="rules"
              className="min-h-9 min-w-0 whitespace-normal px-2 py-2 text-xs"
            >
              {t(($) => {
                return $.tailscale.guide.rules;
              })}
            </TabsTrigger>
          </TabsList>
          <TagInstructions />
          <OAuthInstructions />
          <AccessRuleInstructions />
        </Tabs>
      </details>
    </section>
  );
}
