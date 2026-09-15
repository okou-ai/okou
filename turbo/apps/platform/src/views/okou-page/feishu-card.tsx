import {
  FEISHU_PLATFORMS,
  type FeishuPlatform,
} from "@okouai/core/feishu-platform";
import type { FormEvent } from "react";
import { useGet, useLastLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  ArrowLeft,
  ArrowRight,
  ChevronRight,
  CircleCheck,
  Copy,
  EllipsisVertical,
  Loader2,
  Plus,
  Settings,
} from "lucide-react";
import { FEISHU_OAUTH_SCOPES } from "@okouai/api-contracts/contracts/feishu-connect";
import type { AgentResponse } from "@okouai/api-contracts/contracts/agents";
import { surfaceVariants, Button } from "@okouai/ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@okouai/ui/components/ui/dialog";
import { Input } from "@okouai/ui/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@okouai/ui/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui/components/ui/select";
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { toast } from "@okouai/ui/components/ui/sonner";
import { useTranslation } from "react-i18next";

import { i18n } from "../../i18n/index.ts";
import {
  platformFeishuAppCreatedCredentialsImg,
  platformFeishuAppIconImg,
  platformFeishuAvailabilitySettingsAllMembersImg,
  platformFeishuCreateEnterpriseCustomAppImg,
  platformFeishuEncryptionStrategyImg,
  platformFeishuEventRequestUrlImg,
  platformFeishuEventSubscriptionModeImg,
  platformFeishuPermissionsScopesBatchImportMenuImg,
  platformFeishuPermissionsScopesBatchImportReviewImg,
  platformFeishuSecuritySettingsRedirectUrlImg,
  platformFeishuVersionAvailabilityEditImg,
  platformFeishuVersionManagementCreateVersionImg,
} from "../../lib/static-assets.ts";
import {
  defaultAgentId$,
  defaultAgentName$,
  sortedAgents$,
} from "../../signals/agent.ts";
import { downloadAttachment$ } from "../../signals/attachment-download.ts";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES } from "../../signals/route-paths.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import {
  feishuPlatform$,
  advanceFeishuSetupStep$,
  checkFeishuAppIdAvailable$,
  closeFeishuDialog$,
  completeFeishuDialogClose$,
  completeFeishuInstallationSetup$,
  disconnectFeishuOrg$,
  feishuDialogExisting$,
  feishuDialogInstallationId$,
  feishuDialogOpen$,
  feishuInstallations$,
  feishuOrgData$,
  feishuSetupForm$,
  feishuSetupStep$,
  feishuUninstallInstallationId$,
  goBackFeishuSetupStep$,
  openFeishuDialog$,
  setFeishuUninstallInstallationId$,
  setupFeishuOrg$,
  updateFeishuInstallationAgent$,
  updateFeishuSetupForm$,
  uninstallFeishuInstallation$,
  type FeishuBotInstallation,
  type FeishuSetupInput,
  type FeishuSetupStep,
} from "../../signals/okou-page/feishu.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const feishuIconImg = settingsIconAssetUrl("lark");
const FEISHU_GUIDE_IMAGE_SOURCES = [
  platformFeishuCreateEnterpriseCustomAppImg,
  platformFeishuAppCreatedCredentialsImg,
  platformFeishuEncryptionStrategyImg,
  platformFeishuSecuritySettingsRedirectUrlImg,
  platformFeishuPermissionsScopesBatchImportMenuImg,
  platformFeishuPermissionsScopesBatchImportReviewImg,
  platformFeishuEventSubscriptionModeImg,
  platformFeishuEventRequestUrlImg,
  platformFeishuVersionManagementCreateVersionImg,
  platformFeishuVersionAvailabilityEditImg,
  platformFeishuAvailabilitySettingsAllMembersImg,
] as const;

type FeishuDialogData = FeishuBotInstallation;

function agentLabel(
  agent: AgentResponse,
  defaultAgentId: string | null,
  defaultAgentName: string | null,
): string {
  if (agent.agentId === defaultAgentId && defaultAgentName) {
    return defaultAgentName;
  }
  return agent.displayName ?? agent.agentId;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const copy = () => {
    detach(
      (async () => {
        const copied = await writeToClipboard(value);
        if (copied) {
          toast.success(
            i18n.t(
              ($) => {
                return $.connectors.providerSettings[platform].copied;
              },
              { label },
            ),
          );
        }
      })(),
      Reason.DomCallback,
    );
  };
  return (
    <Button type="button" variant="outline" size="sm" onClick={copy}>
      <Copy size={14} />
      {t(($) => {
        return $.connectors.providerSettings[platform].copy;
      })}
    </Button>
  );
}

function SetupStatus({
  complete,
  children,
}: {
  complete: boolean;
  children: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-secondary-foreground">
      {complete ? (
        <CircleCheck className="h-4 w-4 text-green-600" />
      ) : (
        <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
      )}
      {children}
    </span>
  );
}

function FeishuGuideImage({
  src,
  alt,
  width,
  height,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
}) {
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading="lazy"
      className="h-auto w-full rounded-lg border border-border bg-white"
    />
  );
}

interface FeishuGuideImageItem {
  readonly src: string;
  readonly alt: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
}

function FeishuGuideImages({
  images,
}: {
  images: readonly [FeishuGuideImageItem, ...FeishuGuideImageItem[]];
}) {
  return (
    <div className="space-y-4">
      {images.map((image) => {
        return (
          <figure key={image.src} className="space-y-2">
            <FeishuGuideImage
              src={image.src}
              alt={image.alt}
              width={image.width}
              height={image.height}
            />
            <figcaption className="text-xs text-muted-foreground">
              {image.label}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}

type FeishuCredentialField = Exclude<keyof FeishuSetupInput, "defaultAgentId">;

const FEISHU_SETUP_STEPS = [
  "create",
  "credentials",
  "tokens",
  "redirect",
  "permissions",
  "events",
  "publish",
] as const satisfies readonly FeishuSetupStep[];

function FeishuSetupProgress({ step }: { step: FeishuSetupStep }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const currentIndex = FEISHU_SETUP_STEPS.indexOf(step);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        {FEISHU_SETUP_STEPS.map((item, index) => {
          return (
            <div
              key={item}
              className={
                index <= currentIndex
                  ? "h-1 flex-1 rounded-full bg-foreground"
                  : "h-1 flex-1 rounded-full bg-muted"
              }
            />
          );
        })}
      </div>
      <div className="grid grid-cols-7 gap-2 text-xs">
        {FEISHU_SETUP_STEPS.map((item, index) => {
          return (
            <div
              key={item}
              className={
                index <= currentIndex
                  ? "truncate font-medium text-foreground"
                  : "truncate text-muted-foreground"
              }
            >
              {t(($) => {
                return $.connectors.providerSettings[platform].steps[item];
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FeishuCredentialInput({
  field,
  label,
  form,
  saving,
  readOnly,
  placeholder,
}: {
  field: FeishuCredentialField;
  label: string;
  form: FeishuSetupInput;
  saving: boolean;
  readOnly: boolean;
  placeholder?: string;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const updateForm = useSet(updateFeishuSetupForm$);
  const id = `feishu-${field}`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input
        id={id}
        type={field === "appId" ? "text" : "password"}
        value={form[field]}
        disabled={saving || readOnly}
        required
        autoComplete="off"
        placeholder={
          readOnly && field !== "appId"
            ? t(($) => {
                return $.connectors.providerSettings[platform].configured;
              })
            : placeholder
        }
        onChange={(event) => {
          updateForm({ [field]: event.target.value });
        }}
      />
    </div>
  );
}

function FeishuAppCredentialFields({
  form,
  saving,
  readOnly,
}: {
  form: FeishuSetupInput;
  saving: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FeishuCredentialInput
        field="appId"
        label={t(($) => {
          return $.connectors.providerSettings[platform].credentials.appId;
        })}
        form={form}
        saving={saving}
        readOnly={readOnly}
        placeholder="cli_..."
      />
      <FeishuCredentialInput
        field="appSecret"
        label={t(($) => {
          return $.connectors.providerSettings[platform].credentials.appSecret;
        })}
        form={form}
        saving={saving}
        readOnly={readOnly}
      />
    </div>
  );
}

function FeishuEventCredentialFields({
  form,
  saving,
  readOnly,
}: {
  form: FeishuSetupInput;
  saving: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <FeishuCredentialInput
        field="encryptKey"
        label={t(($) => {
          return $.connectors.providerSettings[platform].tokens.encryptKey;
        })}
        form={form}
        saving={saving}
        readOnly={readOnly}
      />
      <FeishuCredentialInput
        field="verificationToken"
        label={t(($) => {
          return $.connectors.providerSettings[platform].tokens
            .verificationToken;
        })}
        form={form}
        saving={saving}
        readOnly={readOnly}
      />
    </div>
  );
}

function FeishuAgentSelect({
  form,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
  saving,
  readOnly,
  onAgentChange,
}: {
  form: FeishuSetupInput;
  agents: AgentResponse[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
  saving: boolean;
  readOnly: boolean;
  onAgentChange?: (defaultAgentId: string) => void;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const updateForm = useSet(updateFeishuSetupForm$);
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="feishu-default-agent" className="text-sm font-medium">
        {t(($) => {
          return $.connectors.providerSettings[platform].defaultAgent;
        })}
      </label>
      <Select
        value={form.defaultAgentId}
        disabled={saving || readOnly}
        onValueChange={(defaultAgentId) => {
          updateForm({ defaultAgentId });
          onAgentChange?.(defaultAgentId);
        }}
      >
        <SelectTrigger id="feishu-default-agent">
          <SelectValue
            placeholder={t(($) => {
              return $.connectors.providerSettings[platform].selectAgent;
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {agents.map((agent) => {
            return (
              <SelectItem key={agent.agentId} value={agent.agentId}>
                {agentLabel(agent, orgDefaultAgentId, orgDefaultAgentName)}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}

function canSubmitFeishuSetup(
  form: FeishuSetupInput,
  saving: boolean,
): boolean {
  return (
    !saving &&
    form.appId.trim().length > 0 &&
    form.appSecret.trim().length > 0 &&
    form.verificationToken.trim().length > 0 &&
    form.encryptKey.trim().length > 0 &&
    form.defaultAgentId.length > 0
  );
}

function FeishuCreateStep() {
  const brandName = useGet(brandName$);
  const downloadAttachment = useSet(downloadAttachment$);
  const signal = useGet(pageSignal$);
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const iconFilename = `${brandName.toLowerCase()}-${platform}-app-icon.png`;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].create.title;
          })}
        </div>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].create
              .descriptionBefore;
          })}
          <a
            href={new URL(
              "/page/launcher?from=backend_oneclick",
              FEISHU_PLATFORMS[platform].developerConsoleUrl,
            ).toString()}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t(($) => {
              return $.connectors.providerSettings[platform].developerConsole;
            })}
          </a>
          {t(
            ($) => {
              return $.connectors.providerSettings[platform].create
                .descriptionAfter;
            },
            { brandName },
          )}
        </p>
        <div className="mt-4">
          <FeishuGuideImage
            src={platformFeishuCreateEnterpriseCustomAppImg}
            width={1234}
            height={998}
            alt={t(($) => {
              return $.connectors.providerSettings[platform].create.imageAlt;
            })}
          />
        </div>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t(
              ($) => {
                return $.connectors.providerSettings[platform].create.iconTitle;
              },
              { brandName },
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            <a
              href={platformFeishuAppIconImg}
              download={iconFilename}
              onClick={(event) => {
                event.preventDefault();
                detach(
                  downloadAttachment(
                    { filename: iconFilename, url: platformFeishuAppIconImg },
                    signal,
                  ),
                  Reason.DomCallback,
                  "Feishu app icon download",
                );
              }}
              className="font-medium text-foreground underline underline-offset-4"
            >
              {t(
                ($) => {
                  return $.connectors.providerSettings[platform].create
                    .downloadIcon;
                },
                { brandName },
              )}
            </a>
            {t(($) => {
              return $.connectors.providerSettings[platform].create.iconHint;
            })}
          </p>
        </div>
        <img
          src={platformFeishuAppIconImg}
          alt={t(
            ($) => {
              return $.connectors.providerSettings[platform].create.iconAlt;
            },
            { brandName },
          )}
          className="h-14 w-14 shrink-0 rounded-xl"
        />
      </div>
    </div>
  );
}

function FeishuCredentialsStep({
  form,
  saving,
  readOnly,
}: {
  form: FeishuSetupInput;
  saving: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].credentials.title;
          })}
        </div>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].credentials
              .description;
          })}
        </p>
        <div className="mt-4">
          <FeishuGuideImage
            src={platformFeishuAppCreatedCredentialsImg}
            width={1190}
            height={1076}
            alt={t(($) => {
              return $.connectors.providerSettings[platform].credentials
                .imageAlt;
            })}
          />
        </div>
      </div>
      <FeishuAppCredentialFields
        form={form}
        saving={saving}
        readOnly={readOnly}
      />
    </div>
  );
}

function FeishuTokensStep({
  form,
  saving,
  readOnly,
}: {
  form: FeishuSetupInput;
  saving: boolean;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].tokens.title;
          })}
        </div>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].tokens
              .descriptionBefore;
          })}
          <a
            href={`${FEISHU_PLATFORMS[platform].apiOrigin}/app`}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t(($) => {
              return $.connectors.providerSettings[platform].developerConsole;
            })}
          </a>
          {t(($) => {
            return $.connectors.providerSettings[platform].tokens
              .descriptionAfter;
          })}
        </p>
        <div className="mt-4">
          <FeishuGuideImage
            src={platformFeishuEncryptionStrategyImg}
            width={2356}
            height={1184}
            alt={t(($) => {
              return $.connectors.providerSettings[platform].tokens.imageAlt;
            })}
          />
        </div>
      </div>
      <FeishuEventCredentialFields
        form={form}
        saving={saving}
        readOnly={readOnly}
      />
    </div>
  );
}

function FeishuEventsStep({ data }: { data: FeishuDialogData | null }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="font-medium text-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].events.title;
            })}
          </span>
          <SetupStatus complete={data?.callbackVerified ?? false}>
            {data?.callbackVerified
              ? t(($) => {
                  return $.connectors.providerSettings[platform]
                    .callbackStatusVerified;
                })
              : t(($) => {
                  return $.connectors.providerSettings[platform]
                    .callbackStatusWaiting;
                })}
          </SetupStatus>
        </div>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].events.description;
          })}{" "}
          (
          <code className="font-mono text-xs text-foreground">
            im.message.receive_v1
          </code>
          ).
        </p>
        <div className="mt-4">
          <FeishuGuideImages
            images={[
              {
                src: platformFeishuEventSubscriptionModeImg,
                width: 2562,
                height: 1296,
                alt: t(($) => {
                  return $.connectors.providerSettings[platform].events
                    .subscriptionAlt;
                }),
                label: t(($) => {
                  return $.connectors.providerSettings[platform].events
                    .subscriptionLabel;
                }),
              },
              {
                src: platformFeishuEventRequestUrlImg,
                width: 2442,
                height: 1278,
                alt: t(($) => {
                  return $.connectors.providerSettings[platform].events
                    .requestAlt;
                }),
                label: t(($) => {
                  return $.connectors.providerSettings[platform].events
                    .requestLabel;
                }),
              },
            ]}
          />
        </div>
      </div>
      <div className="flex gap-2">
        <Input value={data?.callbackUrl ?? ""} readOnly />
        {data?.callbackUrl ? (
          <CopyButton
            value={data.callbackUrl}
            label={t(($) => {
              return $.connectors.providerSettings[platform].events
                .callbackLabel;
            })}
          />
        ) : null}
      </div>
      {!data?.callbackVerified ? (
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].events.continue;
          })}
        </p>
      ) : null}
    </div>
  );
}

function FeishuRedirectStep({ data }: { data: FeishuDialogData | null }) {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].redirect.title;
          })}
        </div>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].redirect
              .descriptionBefore;
          })}
          <a
            href={FEISHU_PLATFORMS[platform].developerConsoleUrl}
            target="_blank"
            rel="noreferrer"
            className="font-medium text-foreground underline underline-offset-4"
          >
            {t(($) => {
              return $.connectors.providerSettings[platform].developerConsole;
            })}
          </a>
          {t(
            ($) => {
              return $.connectors.providerSettings[platform].redirect
                .descriptionAfter;
            },
            { brandName },
          )}
        </p>
      </div>
      <FeishuGuideImage
        src={platformFeishuSecuritySettingsRedirectUrlImg}
        width={3190}
        height={1220}
        alt={t(($) => {
          return $.connectors.providerSettings[platform].redirect.imageAlt;
        })}
      />
      <div className="flex gap-2">
        <Input value={data?.oauthRedirectUrl ?? ""} readOnly />
        {data?.oauthRedirectUrl ? (
          <CopyButton
            value={data.oauthRedirectUrl}
            label={t(($) => {
              return $.connectors.providerSettings[platform].redirect.label;
            })}
          />
        ) : null}
      </div>
    </div>
  );
}

function FeishuPermissionsStep({ data }: { data: FeishuDialogData | null }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const scopes = data?.oauthScopes ?? FEISHU_OAUTH_SCOPES;
  const scopeImportJson = JSON.stringify(
    {
      scopes: {
        tenant: [],
        user: scopes,
      },
    },
    null,
    2,
  );
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].permissions.title;
          })}
        </div>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].permissions
              .description;
          })}
        </p>
        <div className="mt-4">
          <FeishuGuideImages
            images={[
              {
                src: platformFeishuPermissionsScopesBatchImportMenuImg,
                width: 1209,
                height: 838,
                alt: t(($) => {
                  return $.connectors.providerSettings[platform].permissions
                    .menuAlt;
                }),
                label: t(($) => {
                  return $.connectors.providerSettings[platform].permissions
                    .menuLabel;
                }),
              },
              {
                src: platformFeishuPermissionsScopesBatchImportReviewImg,
                width: 838,
                height: 893,
                alt: t(($) => {
                  return $.connectors.providerSettings[platform].permissions
                    .reviewAlt;
                }),
                label: t(($) => {
                  return $.connectors.providerSettings[platform].permissions
                    .reviewLabel;
                }),
              },
            ]}
          />
        </div>
      </div>
      <div className="rounded-lg border border-border p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].permissions.label;
            })}
          </span>
          {scopes.length > 0 ? (
            <CopyButton
              value={scopeImportJson}
              label={t(($) => {
                return $.connectors.providerSettings[platform].permissions
                  .label;
              })}
            />
          ) : null}
        </div>
        <div className="rounded-md bg-muted/40 p-3">
          <code
            className="whitespace-pre-wrap break-words text-xs text-foreground"
            data-testid="feishu-user-scope-import-json"
          >
            {scopeImportJson}
          </code>
        </div>
        <p
          role="note"
          className="mt-3 text-sm text-amber-600 dark:text-amber-400"
        >
          {t(($) => {
            return $.connectors.providerSettings[platform].permissions.hint;
          })}
        </p>
      </div>
    </div>
  );
}

function FeishuPublishStep({
  data,
  form,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
  readOnly,
}: {
  data: FeishuDialogData | null;
  form: FeishuSetupInput;
  agents: AgentResponse[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const [updateLoadable, updateAgent] = useLoadableSet(
    updateFeishuInstallationAgent$,
  );
  const signal = useGet(pageSignal$);
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <div className="mb-2 font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].publish.title;
          })}
        </div>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].publish.description;
          })}
        </p>
        <div className="mt-4">
          <FeishuGuideImages
            images={[
              {
                src: platformFeishuVersionManagementCreateVersionImg,
                width: 3822,
                height: 1708,
                alt: t(($) => {
                  return $.connectors.providerSettings[platform].publish
                    .createVersionAlt;
                }),
                label: t(($) => {
                  return $.connectors.providerSettings[platform].publish
                    .createVersionLabel;
                }),
              },
              {
                src: platformFeishuVersionAvailabilityEditImg,
                width: 3046,
                height: 1780,
                alt: t(($) => {
                  return $.connectors.providerSettings[platform].publish
                    .editAvailabilityAlt;
                }),
                label: t(($) => {
                  return $.connectors.providerSettings[platform].publish
                    .editAvailabilityLabel;
                }),
              },
              {
                src: platformFeishuAvailabilitySettingsAllMembersImg,
                width: 1630,
                height: 544,
                alt: t(($) => {
                  return $.connectors.providerSettings[platform].publish
                    .allMembersAlt;
                }),
                label: t(($) => {
                  return $.connectors.providerSettings[platform].publish
                    .allMembersLabel;
                }),
              },
            ]}
          />
        </div>
      </div>
      <div className="space-y-3 rounded-lg border border-border p-4">
        <div>
          <div className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].defaultAgent;
            })}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].agentDescription;
            })}
          </p>
        </div>
        <FeishuAgentSelect
          form={form}
          agents={agents}
          orgDefaultAgentId={orgDefaultAgentId}
          orgDefaultAgentName={orgDefaultAgentName}
          saving={!data?.id || updateLoadable.state === "loading"}
          readOnly={readOnly}
          onAgentChange={(defaultAgentId) => {
            if (!data?.id) {
              return;
            }
            detach(
              updateAgent(data.id, defaultAgentId, signal),
              Reason.DomCallback,
            );
          }}
        />
      </div>
    </div>
  );
}

function FeishuSetupStepContent({
  step,
  data,
  form,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
  saving,
  readOnly,
}: {
  step: FeishuSetupStep;
  data: FeishuDialogData | null;
  form: FeishuSetupInput;
  agents: AgentResponse[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
  saving: boolean;
  readOnly: boolean;
}) {
  switch (step) {
    case "create": {
      return <FeishuCreateStep />;
    }
    case "credentials": {
      return (
        <FeishuCredentialsStep
          form={form}
          saving={saving}
          readOnly={readOnly}
        />
      );
    }
    case "tokens": {
      return (
        <FeishuTokensStep form={form} saving={saving} readOnly={readOnly} />
      );
    }
    case "redirect": {
      return <FeishuRedirectStep data={data} />;
    }
    case "permissions": {
      return <FeishuPermissionsStep data={data} />;
    }
    case "events": {
      return <FeishuEventsStep data={data} />;
    }
    case "publish": {
      return (
        <FeishuPublishStep
          data={data}
          form={form}
          agents={agents}
          orgDefaultAgentId={orgDefaultAgentId}
          orgDefaultAgentName={orgDefaultAgentName}
          readOnly={readOnly}
        />
      );
    }
  }
}

type FeishuSetupRequest = FeishuSetupInput & {
  readonly installationId?: string;
  readonly createNew?: boolean;
};

function feishuSetupRequest(
  form: FeishuSetupInput,
  data: FeishuDialogData | null,
): FeishuSetupRequest {
  const input = {
    appId: form.appId.trim(),
    appSecret: form.appSecret.trim(),
    verificationToken: form.verificationToken.trim(),
    encryptKey: form.encryptKey.trim(),
    defaultAgentId: form.defaultAgentId,
  };
  if (!data) {
    return { ...input, createNew: true };
  }
  return data.id ? { ...input, installationId: data.id } : input;
}

function canContinueFeishuSetup(args: {
  readonly step: FeishuSetupStep;
  readonly data: FeishuDialogData | null;
  readonly form: FeishuSetupInput;
  readonly saving: boolean;
}): boolean {
  switch (args.step) {
    case "credentials": {
      return (
        !args.saving &&
        args.form.appId.trim().length > 0 &&
        args.form.appSecret.trim().length > 0
      );
    }
    case "tokens": {
      return canSubmitFeishuSetup(args.form, args.saving);
    }
    case "redirect": {
      return Boolean(args.data?.oauthRedirectUrl);
    }
    case "permissions": {
      return (args.data?.oauthScopes ?? FEISHU_OAUTH_SCOPES).length > 0;
    }
    case "events": {
      return args.data?.callbackVerified ?? false;
    }
    case "publish": {
      return Boolean(args.data?.id);
    }
    case "create": {
      return true;
    }
  }
}

function feishuSetupContinueLabel(args: {
  readonly platform: FeishuPlatform;
  readonly step: FeishuSetupStep;
  readonly saving: boolean;
  readonly checkingAppId: boolean;
  readonly callbackVerified: boolean;
  readonly readOnly: boolean;
}): string {
  if (args.readOnly) {
    return args.step === "publish"
      ? i18n.t(($) => {
          return $.connectors.providerSettings[args.platform].steps.done;
        })
      : i18n.t(($) => {
          return $.connectors.providerSettings[args.platform].steps.next;
        });
  }
  if (args.step === "tokens") {
    return args.saving
      ? i18n.t(($) => {
          return $.connectors.providerSettings[args.platform].steps.verifying;
        })
      : i18n.t(($) => {
          return $.connectors.providerSettings[args.platform].steps.verify;
        });
  }
  if (args.step === "credentials" && args.checkingAppId) {
    return i18n.t(($) => {
      return $.connectors.providerSettings[args.platform].steps.checking;
    });
  }
  if (args.step === "events" && !args.callbackVerified) {
    return i18n.t(($) => {
      return $.connectors.providerSettings[args.platform].steps.waiting;
    });
  }
  return args.step === "publish"
    ? i18n.t(($) => {
        return $.connectors.providerSettings[args.platform].steps.done;
      })
    : i18n.t(($) => {
        return $.connectors.providerSettings[args.platform].steps.next;
      });
}

function FeishuSetupWizardFooter({
  step,
  data,
  saving,
  checkingAppId,
  canContinue,
  readOnly,
  onClose,
  onBack,
  onContinue,
}: {
  step: FeishuSetupStep;
  data: FeishuDialogData | null;
  saving: boolean;
  checkingAppId: boolean;
  canContinue: boolean;
  readOnly: boolean;
  onClose: () => void;
  onBack: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const isFirstStep = step === "create";
  const firstStepLabel = readOnly
    ? t(($) => {
        return $.connectors.providerSettings[platform].steps.close;
      })
    : t(($) => {
        return $.connectors.actions.cancel;
      });
  const continueLabel = feishuSetupContinueLabel({
    platform,
    step,
    saving,
    checkingAppId,
    callbackVerified: data?.callbackVerified ?? false,
    readOnly,
  });
  return (
    <DialogFooter className="mt-5 shrink-0 border-t border-border pt-5">
      <Button
        type="button"
        variant="outline"
        disabled={saving}
        onClick={isFirstStep ? onClose : onBack}
      >
        {isFirstStep ? (
          firstStepLabel
        ) : (
          <span className="inline-flex items-center gap-2">
            <ArrowLeft size={16} />
            {t(($) => {
              return $.connectors.providerSettings[platform].steps.back;
            })}
          </span>
        )}
      </Button>
      <Button
        type={step === "tokens" && !readOnly ? "submit" : "button"}
        disabled={!canContinue}
        onClick={step === "tokens" && !readOnly ? undefined : onContinue}
      >
        {saving ? <Loader2 size={16} className="animate-spin" /> : null}
        {continueLabel}
        {(step !== "tokens" || readOnly) && step !== "publish" ? (
          <ArrowRight size={16} />
        ) : null}
      </Button>
    </DialogFooter>
  );
}

function FeishuSetupWizard({
  data,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
  readOnly,
  onClose,
}: {
  data: FeishuDialogData | null;
  agents: AgentResponse[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const step = useGet(feishuSetupStep$);
  const form = useGet(feishuSetupForm$);
  const advanceStep = useSet(advanceFeishuSetupStep$);
  const goBack = useSet(goBackFeishuSetupStep$);
  const [setupLoadable, setup] = useLoadableSet(setupFeishuOrg$);
  const [appIdCheckLoadable, checkAppId] = useLoadableSet(
    checkFeishuAppIdAvailable$,
  );
  const [completionLoadable, completeSetup] = useLoadableSet(
    completeFeishuInstallationSetup$,
  );
  const signal = useGet(pageSignal$);
  const saving =
    appIdCheckLoadable.state === "loading" ||
    setupLoadable.state === "loading" ||
    completionLoadable.state === "loading";
  const canSave = canSubmitFeishuSetup(form, saving);
  const canContinue =
    readOnly || canContinueFeishuSetup({ step, data, form, saving });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (readOnly || step !== "tokens" || !canSave) {
      return;
    }
    detach(
      (async () => {
        await setup(feishuSetupRequest(form, data), signal);
        advanceStep();
      })(),
      Reason.DomCallback,
    );
  };

  const continueFlow = () => {
    if (!canContinue) {
      return;
    }
    if (step === "publish") {
      if (readOnly) {
        onClose();
        return;
      }
      const installationId = data?.id;
      if (!installationId) {
        return;
      }
      detach(
        (async () => {
          await completeSetup(installationId, form.defaultAgentId, signal);
          onClose();
        })(),
        Reason.DomCallback,
      );
      return;
    }
    if (step === "credentials" && !data) {
      detach(
        (async () => {
          await checkAppId(form.appId.trim(), signal);
          advanceStep();
        })(),
        Reason.DomCallback,
      );
      return;
    }
    advanceStep();
  };

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
      <div className="shrink-0 pb-5">
        <FeishuSetupProgress step={step} />
      </div>
      <div className="-mr-3 min-h-0 flex-1 overflow-y-auto pr-3 [scrollbar-gutter:stable]">
        <FeishuSetupStepContent
          step={step}
          data={data}
          form={form}
          agents={agents}
          orgDefaultAgentId={orgDefaultAgentId}
          orgDefaultAgentName={orgDefaultAgentName}
          saving={saving}
          readOnly={readOnly}
        />
      </div>
      <FeishuSetupWizardFooter
        step={step}
        data={data}
        saving={saving}
        checkingAppId={appIdCheckLoadable.state === "loading"}
        canContinue={canContinue}
        readOnly={readOnly}
        onClose={onClose}
        onBack={goBack}
        onContinue={continueFlow}
      />
    </form>
  );
}

export function FeishuCard({
  platform = "feishu",
}: {
  platform?: FeishuPlatform;
}) {
  const { t } = useTranslation();
  return (
    <Link
      pathname={
        platform === "lark" ? ROUTES.settingsLark : ROUTES.settingsFeishu
      }
      data-slot="integration-card"
      data-testid={`${platform}-setup-button`}
      className={surfaceVariants({ className: "block" })}
    >
      <div className="flex items-center gap-4 p-4">
        <div className="inline-flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden">
          <img src={feishuIconImg} alt="" className="h-7 w-7" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-sm font-medium text-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].documentTitle;
            })}
          </div>
          <div className="truncate text-sm text-muted-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].routeDescription;
            })}
          </div>
        </div>
        <span className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-secondary-foreground">
          <Settings size={14} />
          {t(($) => {
            return $.connectors.providerSettings[platform].manage;
          })}
        </span>
      </div>
    </Link>
  );
}

function FeishuStatusBadge({ bot }: { bot: FeishuBotInstallation }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  if (bot.isConnected) {
    return (
      <span className="inline-flex min-w-0 max-w-52 items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-secondary-foreground">
        <CircleCheck className="h-3.5 w-3.5 text-green-600" />
        <span className="min-w-0 truncate" title={bot.connectedUserName ?? ""}>
          {bot.connectedUserName
            ? t(
                ($) => {
                  return $.connectors.providerSettings.works.connectedDetail;
                },
                { detail: bot.connectedUserName },
              )
            : t(($) => {
                return $.connectors.providerSettings.works.connected;
              })}
        </span>
      </span>
    );
  }
  if (!bot.setupCompleted) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2 py-1 text-xs font-medium text-muted-foreground">
        {t(($) => {
          return $.connectors.providerSettings[platform].setupIncomplete;
        })}
      </span>
    );
  }
  return null;
}

function FeishuBotAgentSelect({
  bot,
  agents,
  disabled,
}: {
  bot: FeishuBotInstallation;
  agents: AgentResponse[];
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const [updateLoadable, updateAgent] = useLoadableSet(
    updateFeishuInstallationAgent$,
  );
  const signal = useGet(pageSignal$);
  return (
    <Select
      value={bot.defaultAgentId}
      disabled={disabled || !bot.id || updateLoadable.state === "loading"}
      onValueChange={(defaultAgentId) => {
        if (!bot.id) {
          return;
        }
        detach(updateAgent(bot.id, defaultAgentId, signal), Reason.DomCallback);
      }}
    >
      <SelectTrigger
        aria-label={t(
          ($) => {
            return $.connectors.providerSettings[platform].defaultAgentAria;
          },
          { appId: bot.appId },
        )}
      >
        <SelectValue
          placeholder={t(($) => {
            return $.connectors.providerSettings[platform].selectAgent;
          })}
        />
      </SelectTrigger>
      <SelectContent>
        {agents.map((agent) => {
          return (
            <SelectItem key={agent.agentId} value={agent.agentId}>
              {agent.displayName ?? agent.agentId}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}

function FeishuBotMenu({
  bot,
  title,
  isAdmin,
}: {
  bot: FeishuBotInstallation;
  title: string;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const open = useSet(openFeishuDialog$);
  const setUninstallInstallationId = useSet(setFeishuUninstallInstallationId$);
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectFeishuOrg$);
  const signal = useGet(pageSignal$);
  const disconnecting = disconnectLoadable.state === "loading";
  if (!isAdmin && !bot.isConnected) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          showTooltip
          type="button"
          disabled={disconnecting}
          variant="quiet"
          size="icon-sm"
          className="shrink-0"
          aria-label={t(
            ($) => {
              return $.connectors.providerSettings[platform].moreOptions;
            },
            { bot: title },
          )}
        >
          <EllipsisVertical size={16} />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="flex w-40 flex-col gap-0.5 p-2">
        {isAdmin ? (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground"
            onClick={() => {
              open({
                appId: bot.appId,
                defaultAgentId: bot.defaultAgentId,
                step: bot.setupCompleted ? "create" : "redirect",
                installationId: bot.id,
              });
            }}
          >
            {bot.setupCompleted
              ? t(($) => {
                  return $.connectors.providerSettings[platform].reviewGuide;
                })
              : t(($) => {
                  return $.connectors.providerSettings[platform].manage;
                })}
          </button>
        ) : null}
        {bot.isConnected ? (
          <button
            type="button"
            disabled={disconnecting}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              detach(disconnect(bot.id, signal), Reason.DomCallback);
            }}
          >
            {disconnecting
              ? t(($) => {
                  return $.connectors.actions.disconnecting;
                })
              : t(($) => {
                  return $.connectors.actions.disconnect;
                })}
          </button>
        ) : null}
        {isAdmin ? (
          <button
            type="button"
            disabled={!bot.id}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-state-hover hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
            onClick={() => {
              setUninstallInstallationId(bot.id);
            }}
          >
            {t(($) => {
              return $.connectors.actions.uninstall;
            })}
          </button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function FeishuBotRow({
  bot,
  agents,
  agentsLoading,
  isAdmin,
}: {
  bot: FeishuBotInstallation;
  agents: AgentResponse[];
  agentsLoading: boolean;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const title =
    bot.botName ??
    bot.tenantName ??
    t(($) => {
      return $.connectors.providerSettings[platform].botFallback;
    });
  const connectUrl = bot.connectUrl;
  const canConnect =
    bot.setupCompleted === true && typeof connectUrl === "string";
  return (
    <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px]">
          <img
            src={bot.botAvatarUrl ?? feishuIconImg}
            alt={t(
              ($) => {
                return $.connectors.providerSettings[platform].botIconAlt;
              },
              { bot: title },
            )}
            className={
              bot.botAvatarUrl
                ? "h-10 w-10 rounded-[10px] object-cover"
                : "h-7 w-7"
            }
            onError={(event) => {
              event.currentTarget.src = feishuIconImg;
              event.currentTarget.className = "h-7 w-7";
            }}
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-sm font-medium text-foreground">
              {title}
            </div>
            <FeishuStatusBadge bot={bot} />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5 sm:w-[420px]">
        {isAdmin ? (
          <div className="min-w-0 flex-1">
            <FeishuBotAgentSelect
              bot={bot}
              agents={agents}
              disabled={agentsLoading}
            />
          </div>
        ) : null}
        {!bot.isConnected && canConnect ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 justify-center"
            onClick={() => {
              if (typeof connectUrl !== "string") {
                return;
              }
              const url = new URL(connectUrl);
              url.searchParams.set("callbackTarget", "app");
              window.open(url.toString(), "_blank");
            }}
          >
            {t(($) => {
              return $.connectors.actions.connect;
            })}
          </Button>
        ) : null}
        <FeishuBotMenu bot={bot} title={title} isAdmin={isAdmin} />
      </div>
    </div>
  );
}

function FeishuBotList({
  bots,
  agents,
  agentsLoading,
  isAdmin,
}: {
  bots: FeishuBotInstallation[];
  agents: AgentResponse[];
  agentsLoading: boolean;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  if (bots.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center overflow-hidden rounded-xl bg-muted/40">
          <img src={feishuIconImg} alt="" className="h-8 w-8" />
        </div>
        <div className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].emptyTitle;
          })}
        </div>
        <div className="mt-1 text-sm text-muted-foreground">
          {isAdmin
            ? t(($) => {
                return $.connectors.providerSettings[platform].emptyAdmin;
              })
            : t(($) => {
                return $.connectors.providerSettings[platform].emptyMember;
              })}
        </div>
      </div>
    );
  }
  return (
    <div>
      {bots.map((bot, index) => {
        return (
          <div key={bot.id ?? bot.appId}>
            <FeishuBotRow
              bot={bot}
              agents={agents}
              agentsLoading={agentsLoading}
              isAdmin={isAdmin}
            />
            {index < bots.length - 1 ? (
              <div className="mx-5 border-b border-border/50" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function FeishuBotsCard({
  bots,
  agents,
  agentsLoading,
  isAdmin,
  onAdd,
}: {
  bots: FeishuBotInstallation[];
  agents: AgentResponse[];
  agentsLoading: boolean;
  isAdmin: boolean;
  onAdd: () => void;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <section className={surfaceVariants({ className: "overflow-hidden" })}>
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
        <h2 className="text-sm font-medium text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].bots;
          })}
        </h2>
        {isAdmin && bots.length === 0 ? (
          <Button
            type="button"
            size="sm"
            disabled={agentsLoading}
            onClick={onAdd}
          >
            <Plus size={16} />
            {t(($) => {
              return $.connectors.providerSettings[platform].addBot;
            })}
          </Button>
        ) : null}
      </div>
      <FeishuBotList
        bots={bots}
        agents={agents}
        agentsLoading={agentsLoading}
        isAdmin={isAdmin}
      />
    </section>
  );
}

function FeishuSetupFaq() {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <section
      className={surfaceVariants({ className: "overflow-hidden" })}
      aria-labelledby="feishu-setup-faq-title"
    >
      <div className="border-b border-border/50 px-4 py-3">
        <h2
          id="feishu-setup-faq-title"
          className="text-sm font-medium text-foreground"
        >
          {t(($) => {
            return $.connectors.providerSettings[platform].faq.title;
          })}
        </h2>
      </div>
      <div className="divide-y divide-border/50">
        <details className="group px-4 py-4 sm:px-5">
          <summary className="flex cursor-pointer list-none items-start gap-2 text-sm font-medium text-foreground">
            <ChevronRight
              size={17}
              aria-hidden="true"
              className="mt-0.5 shrink-0 transition-transform group-open:rotate-90"
            />
            <span>
              {t(($) => {
                return $.connectors.providerSettings[platform].faq
                  .challengeQuestion;
              })}
            </span>
          </summary>
          <p className="mt-2 pl-[25px] text-sm leading-relaxed text-muted-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].faq
                .challengeAnswer;
            })}
          </p>
        </details>
        <details className="group px-4 py-4 sm:px-5">
          <summary className="flex cursor-pointer list-none items-start gap-2 text-sm font-medium text-foreground">
            <ChevronRight
              size={17}
              aria-hidden="true"
              className="mt-0.5 shrink-0 transition-transform group-open:rotate-90"
            />
            <span>
              {t(($) => {
                return $.connectors.providerSettings[platform].faq
                  .approvalQuestion;
              })}
            </span>
          </summary>
          <p className="mt-2 pl-[25px] text-sm leading-relaxed text-muted-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].faq.approvalAnswer;
            })}
          </p>
        </details>
      </div>
    </section>
  );
}

function FeishuSettingsSkeleton() {
  return (
    <section
      className={surfaceVariants({ className: "overflow-hidden" })}
      data-testid="feishu-settings-loading"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-[88px] rounded-md" />
      </div>
      {[0, 1, 2].map((index) => {
        return (
          <div key={index}>
            <div className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:px-5">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <Skeleton className="h-10 w-10 shrink-0 rounded-[10px]" />
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-6 w-20 rounded-lg" />
                </div>
              </div>
              <div className="flex items-center justify-end gap-1.5 sm:w-[420px]">
                <Skeleton className="h-9 min-w-0 flex-1 rounded-md" />
                <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
              </div>
            </div>
            {index < 2 ? (
              <div className="mx-5 border-b border-border/50" />
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

function FeishuDialogBody({
  data,
  isAdmin,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
  onClose,
}: {
  data: FeishuDialogData | null;
  isAdmin: boolean;
  agents: AgentResponse[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  if (!isAdmin) {
    return (
      <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        {t(($) => {
          return $.connectors.providerSettings[platform].dialogAdminRequired;
        })}
      </p>
    );
  }
  const readOnly = data?.setupCompleted ?? false;
  return (
    <FeishuSetupWizard
      data={data}
      agents={agents}
      orgDefaultAgentId={orgDefaultAgentId}
      orgDefaultAgentName={orgDefaultAgentName}
      readOnly={readOnly}
      onClose={onClose}
    />
  );
}

function FeishuSetupDialog({
  data,
  isAdmin,
  agents,
  orgDefaultAgentId,
  orgDefaultAgentName,
}: {
  data: FeishuDialogData | null;
  isAdmin: boolean;
  agents: AgentResponse[];
  orgDefaultAgentId: string | null;
  orgDefaultAgentName: string | null;
}) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const open = useGet(feishuDialogOpen$);
  const existing = useGet(feishuDialogExisting$);
  const close = useSet(closeFeishuDialog$);
  const completeClose = useSet(completeFeishuDialogClose$);
  const readOnly = data?.setupCompleted ?? false;
  let title = existing
    ? t(($) => {
        return $.connectors.providerSettings[platform].manageDialogTitle;
      })
    : t(($) => {
        return $.connectors.providerSettings[platform].addDialogTitle;
      });
  let description = t(($) => {
    return $.connectors.providerSettings[platform].addDialogDescription;
  });
  if (readOnly) {
    title = t(($) => {
      return $.connectors.providerSettings[platform].reviewGuideTitle;
    });
    description = t(($) => {
      return $.connectors.providerSettings[platform].reviewGuideDescription;
    });
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          close();
        }
      }}
      onOpenChangeComplete={(nextOpen) => {
        if (!nextOpen) {
          completeClose();
        }
      }}
    >
      <DialogContent
        maxWidth="2xl"
        height={800}
        contentClassName="flex flex-col overflow-hidden"
        closeLabel={t(($) => {
          return $.connectors.actions.close;
        })}
        initialFocus={false}
      >
        {FEISHU_GUIDE_IMAGE_SOURCES.map((src) => {
          return <link key={src} rel="preload" as="image" href={src} />;
        })}
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          {platform === "lark" ? (
            <p className="text-xs text-muted-foreground">
              {t(($) => {
                return $.connectors.providerSettings.lark.guideReference;
              })}
            </p>
          ) : null}
        </DialogHeader>
        <FeishuDialogBody
          data={data}
          isAdmin={isAdmin}
          agents={agents}
          orgDefaultAgentId={orgDefaultAgentId}
          orgDefaultAgentName={orgDefaultAgentName}
          onClose={close}
        />
      </DialogContent>
    </Dialog>
  );
}

function FeishuUninstallDialog({ bot }: { bot: FeishuBotInstallation | null }) {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const setUninstallInstallationId = useSet(setFeishuUninstallInstallationId$);
  const [uninstallLoadable, uninstallInstallation] = useLoadableSet(
    uninstallFeishuInstallation$,
  );
  const signal = useGet(pageSignal$);
  const uninstalling = uninstallLoadable.state === "loading";
  const title =
    bot?.tenantName ??
    bot?.appId ??
    t(($) => {
      return $.connectors.providerSettings[platform].uninstallTargetFallback;
    });
  return (
    <Dialog
      open={Boolean(bot)}
      onOpenChange={(open) => {
        if (!open && !uninstalling) {
          setUninstallInstallationId(null);
        }
      }}
    >
      <DialogContent
        closeLabel={t(($) => {
          return $.connectors.actions.close;
        })}
      >
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.connectors.providerSettings[platform].uninstallTitle;
            })}
          </DialogTitle>
          <DialogDescription>
            {t(
              ($) => {
                return $.connectors.providerSettings[platform]
                  .uninstallDescription;
              },
              { bot: title, brandName },
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={uninstalling}
            onClick={() => {
              setUninstallInstallationId(null);
            }}
          >
            {t(($) => {
              return $.connectors.actions.cancel;
            })}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!bot?.id || uninstalling}
            onClick={() => {
              const installationId = bot?.id;
              if (!installationId) {
                return;
              }
              detach(
                (async () => {
                  await uninstallInstallation(installationId, signal);
                  setUninstallInstallationId(null);
                })(),
                Reason.DomCallback,
              );
            }}
          >
            {uninstalling
              ? t(($) => {
                  return $.connectors.actions.uninstalling;
                })
              : t(($) => {
                  return $.connectors.actions.uninstall;
                })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface LoadableLike<T> {
  readonly state: string;
  readonly data?: T;
}

function loadableData<T>(loadable: LoadableLike<T>): T | undefined {
  return loadable.state === "hasData" ? loadable.data : undefined;
}

function findFeishuBot(
  bots: readonly FeishuBotInstallation[],
  installationId: string | null,
): FeishuBotInstallation | null {
  if (!installationId) {
    return null;
  }
  return (
    bots.find((bot) => {
      return bot.id === installationId;
    }) ?? null
  );
}

function dialogFeishuBot(args: {
  readonly bots: readonly FeishuBotInstallation[];
  readonly existing: boolean;
  readonly installationId: string | null;
}): FeishuBotInstallation | null {
  if (!args.existing) {
    return null;
  }
  return args.installationId
    ? findFeishuBot(args.bots, args.installationId)
    : (args.bots[0] ?? null);
}

function initialFeishuAgentId(
  orgDefaultAgentId: string | null,
  agents: readonly AgentResponse[],
): string {
  return orgDefaultAgentId ?? agents[0]?.agentId ?? "";
}

function feishuSettingsLoading(args: {
  readonly dataState: string;
  readonly botsState: string;
  readonly botCount: number;
}): boolean {
  return (
    (args.dataState === "loading" || args.botsState === "loading") &&
    args.botCount === 0
  );
}

function feishuSettingsHasError(...states: readonly string[]): boolean {
  return states.includes("hasError");
}

export function FeishuSettingsPage() {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const dataLoadable = useLastLoadable(feishuOrgData$);
  const botsLoadable = useLastLoadable(feishuInstallations$);
  const agentsLoadable = useLastLoadable(sortedAgents$);
  const defaultAgentIdLoadable = useLastLoadable(defaultAgentId$);
  const defaultAgentNameLoadable = useLastLoadable(defaultAgentName$);
  const dialogExisting = useGet(feishuDialogExisting$);
  const dialogInstallationId = useGet(feishuDialogInstallationId$);
  const uninstallInstallationId = useGet(feishuUninstallInstallationId$);
  const open = useSet(openFeishuDialog$);
  const data = loadableData(dataLoadable) ?? null;
  const bots = loadableData(botsLoadable) ?? [];
  const agents = loadableData(agentsLoadable) ?? [];
  const isAdmin = data?.isAdmin ?? false;
  const orgDefaultAgentId = loadableData(defaultAgentIdLoadable) ?? null;
  const orgDefaultAgentName = loadableData(defaultAgentNameLoadable) ?? null;
  const dialogData = dialogFeishuBot({
    bots,
    existing: dialogExisting,
    installationId: dialogInstallationId,
  });
  const uninstallBot = findFeishuBot(bots, uninstallInstallationId);
  const loading = feishuSettingsLoading({
    dataState: dataLoadable.state,
    botsState: botsLoadable.state,
    botCount: bots.length,
  });
  const hasError = feishuSettingsHasError(
    dataLoadable.state,
    botsLoadable.state,
    agentsLoadable.state,
  );
  const agentsLoading = agentsLoadable.state === "loading";
  const newBotAgentId = initialFeishuAgentId(orgDefaultAgentId, agents);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="shrink-0 bg-transparent px-4 pb-3 pt-10 sm:px-6">
        <div className="mx-auto max-w-[900px]">
          <div className="mb-4">
            <Button
              asChild
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-2 px-2 text-muted-foreground hover:text-foreground"
            >
              <Link
                pathname={ROUTES.works}
                title={t(($) => {
                  return $.connectors.catalog.title;
                })}
              >
                <ArrowLeft size={17} />
                {t(($) => {
                  return $.connectors.providerSettings[platform]
                    .backToIntegrations;
                })}
              </Link>
            </Button>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-muted/40">
              <img src={feishuIconImg} alt="" className="h-7 w-7" />
            </span>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                {t(($) => {
                  return $.connectors.providerSettings[platform].documentTitle;
                })}
              </h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {t(($) => {
                  return $.connectors.providerSettings[platform]
                    .pageDescription;
                })}
              </p>
            </div>
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-auto px-4 pb-[max(2rem,var(--sab))] pt-3 sm:px-6">
        <div className="mx-auto flex max-w-[900px] flex-col gap-4">
          {hasError ? (
            <div
              className={surfaceVariants({
                className: "px-6 py-10 text-center text-sm text-destructive",
              })}
            >
              {t(($) => {
                return $.connectors.providerSettings[platform].loadError;
              })}
            </div>
          ) : loading ? (
            <FeishuSettingsSkeleton />
          ) : (
            <>
              <FeishuBotsCard
                bots={bots}
                agents={agents}
                agentsLoading={agentsLoading}
                isAdmin={isAdmin}
                onAdd={() => {
                  open({
                    appId: "",
                    defaultAgentId: newBotAgentId,
                    step: "create",
                  });
                }}
              />
              <FeishuSetupDialog
                data={dialogData}
                isAdmin={isAdmin}
                agents={agents}
                orgDefaultAgentId={orgDefaultAgentId}
                orgDefaultAgentName={orgDefaultAgentName}
              />
              <FeishuUninstallDialog bot={uninstallBot} />
            </>
          )}
          <FeishuSetupFaq />
        </div>
      </main>
    </div>
  );
}
