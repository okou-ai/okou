import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  CopyButton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@okouai/ui";

const RECOMMENDED_TAG = "tag:okou";
const RECOMMENDED_RULE = `{
  "src": ["tag:okou"],
  "dst": ["*"],
  "ip": ["*"]
}`;
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

function OAuthInstructions({
  showReplaceHint,
}: {
  readonly showReplaceHint: boolean;
}) {
  const { t } = useTranslation();
  return (
    <TabsContent value="oauth" className="grid min-w-0 gap-2 text-sm">
      <p className="text-muted-foreground">
        {t(($) => {
          return $.tailscale.guide.oauthHelp;
        })}
      </p>
      {showReplaceHint && (
        <p className="text-muted-foreground">
          {t(
            ($) => {
              return $.tailscale.guide.replaceHelp;
            },
            {
              action: t(($) => {
                return $.tailscale.replace;
              }),
            },
          )}
        </p>
      )}
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
      <div className="relative isolate">
        <details>
          <summary className="min-h-8 cursor-pointer rounded-md py-1 pr-10 hover:bg-state-hover">
            {t(($) => {
              return $.tailscale.guide.jsonPreview;
            })}
          </summary>
          <pre className="mt-2 max-w-full overflow-x-auto rounded-lg border bg-background p-3 text-xs">
            <code>{RECOMMENDED_RULE}</code>
          </pre>
        </details>
        <CopyButton
          type="button"
          text={RECOMMENDED_RULE}
          showTooltip={false}
          render={(props, { copied }) => {
            return (
              <button
                {...props}
                aria-label={
                  copied
                    ? t(($) => {
                        return $.tailscale.guide.copied;
                      })
                    : t(($) => {
                        return $.tailscale.guide.copyRule;
                      })
                }
              />
            );
          }}
          className="absolute right-0 top-0"
        />
      </div>
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

function SetupNotes() {
  const { t } = useTranslation();
  return (
    <details className="border-t pt-2 text-sm text-muted-foreground">
      <summary className="cursor-pointer rounded-md py-1 hover:bg-state-hover">
        {t(($) => {
          return $.tailscale.guide.notes;
        })}
      </summary>
      <div className="mt-2 grid gap-3">
        <p>
          {t(($) => {
            return $.tailscale.guide.prerequisites;
          })}
        </p>
        <p>
          {t(($) => {
            return $.tailscale.guide.tagOwnership;
          })}
        </p>
        <p>
          {t(($) => {
            return $.tailscale.guide.credentials;
          })}
        </p>
        <p>
          {t(($) => {
            return $.tailscale.guide.ssh;
          })}
        </p>
        <p>
          {t(($) => {
            return $.tailscale.guide.saving;
          })}
        </p>
        <p>
          {t(($) => {
            return $.tailscale.guide.cleanup;
          })}
        </p>
        <p>
          {t(($) => {
            return $.tailscale.guide.revocation;
          })}
        </p>
        <a
          href="https://tailscale.com/docs/features/tags#ownership"
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit text-link underline underline-offset-4 hover:text-link-hover"
        >
          {t(($) => {
            return $.tailscale.guide.tagOwnershipDocs;
          })}
        </a>
      </div>
    </details>
  );
}

export function TailscaleSetupGuide({
  showReplaceHint,
}: {
  readonly showReplaceHint: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(($) => {
        return $.tailscale.guide.title;
      })}
      className="grid min-w-0 gap-3 rounded-lg border bg-gray-50 p-3"
    >
      <h3 className="text-sm font-medium">
        {t(($) => {
          return $.tailscale.guide.title;
        })}
      </h3>
      <Tabs defaultValue="tags" className="grid min-w-0 gap-3">
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
        <OAuthInstructions showReplaceHint={showReplaceHint} />
        <AccessRuleInstructions />
      </Tabs>
      <SetupNotes />
    </section>
  );
}
