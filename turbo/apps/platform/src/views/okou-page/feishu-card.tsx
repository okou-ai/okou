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
  Check,
  Eye,
  EyeOff,
} from "lucide-react";
import {
  FEISHU_OAUTH_SCOPES,
  FEISHU_TENANT_SCOPES,
} from "@okouai/api-contracts/validators/feishu-connect";
import {
  surfaceVariants,
  Button,
  buttonVariants,
  cn,
  IconButton,
} from "@okouai/ui";
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
import { Skeleton } from "@okouai/ui/components/ui/skeleton";
import { toast } from "@okouai/ui/components/ui/sonner";
import { useTranslation } from "react-i18next";

import { i18n } from "../../i18n/index.ts";
import {
  platformFeishuAppIconImg,
  platformLarkAddBotFeatureImg,
} from "../../lib/static-assets.ts";
import { downloadAttachment$ } from "../../signals/attachment-download.ts";
import { brandName$ } from "../../signals/branding.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { ROUTES, type RoutePath } from "../../signals/route-paths.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import {
  feishuPlatform$,
  feishuRevealedCredentials$,
  toggleFeishuCredentialVisibility$,
  advanceFeishuSetupStep$,
  checkFeishuAppIdAvailable$,
  closeFeishuSetup$,
  completeFeishuInstallationSetup$,
  disconnectFeishuOrg$,
  feishuSetupExisting$,
  feishuSetupInstallationId$,
  feishuSetupActive$,
  feishuInstallations$,
  feishuOrgData$,
  feishuSetupForm$,
  feishuSetupStep$,
  feishuUninstallInstallationId$,
  goBackFeishuSetupStep$,
  setFeishuUninstallInstallationId$,
  setupFeishuOrg$,
  updateFeishuSetupForm$,
  uninstallFeishuInstallation$,
  type FeishuBotInstallation,
  type FeishuSetupInput,
  type FeishuSetupStep,
} from "../../signals/okou-page/feishu.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { Link } from "../router/link.tsx";
import { FeishuSetupGuide } from "./feishu-setup-guide.tsx";
import { settingsIconAssetUrl } from "./components/settings/settings-icon-assets.ts";

const feishuIconImg = settingsIconAssetUrl("lark");
type FeishuSetupData = FeishuBotInstallation;

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

type FeishuCredentialField = keyof FeishuSetupInput;

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
    <ol
      aria-label={t(
        ($) => {
          return $.onboarding.common.stepProgress;
        },
        {
          current: currentIndex + 1,
          total: FEISHU_SETUP_STEPS.length,
        },
      )}
      className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-4 @4xl/feishu-setup:justify-center @4xl/feishu-setup:gap-5 @4xl/feishu-setup:px-6 @3xl/feishu-setup:py-5"
    >
      {FEISHU_SETUP_STEPS.map((item, index) => {
        return (
          <li
            key={item}
            aria-current={index === currentIndex ? "step" : undefined}
            className="flex min-w-0 items-center gap-2 text-xs @4xl/feishu-setup:text-sm"
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full border border-surface-border text-xs text-muted-foreground",
                index === currentIndex &&
                  "border-foreground bg-foreground text-background",
                index < currentIndex && "bg-gray-50",
              )}
            >
              {index < currentIndex ? (
                <Check size={13} aria-hidden />
              ) : (
                index + 1
              )}
            </span>
            <span
              className={cn(
                index === currentIndex
                  ? "font-medium text-foreground"
                  : "hidden text-muted-foreground @4xl/feishu-setup:inline",
              )}
            >
              {t(($) => {
                return $.connectors.providerSettings[platform].steps[item];
              })}
            </span>
            {index < FEISHU_SETUP_STEPS.length - 1 ? (
              <span
                aria-hidden
                className="ml-2 hidden h-px w-4 bg-divider @5xl/feishu-setup:block"
              />
            ) : null}
          </li>
        );
      })}
    </ol>
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
  const revealedFields = useGet(feishuRevealedCredentials$);
  const toggleVisibility = useSet(toggleFeishuCredentialVisibility$);
  const revealed = revealedFields.includes(field);
  const id = `feishu-${field}`;
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={field === "appId" || revealed ? "text" : "password"}
          className={field === "appId" ? undefined : "pr-11"}
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
        {field !== "appId" ? (
          <IconButton
            aria-label={t(
              ($) => {
                return revealed
                  ? $.connectors.setupGuide.hideSecret
                  : $.connectors.setupGuide.showSecret;
              },
              { label },
            )}
            aria-pressed={revealed}
            disabled={saving || readOnly}
            className="absolute right-0 top-0"
            onClick={() => {
              return toggleVisibility(field);
            }}
          >
            {revealed ? <EyeOff size={16} /> : <Eye size={16} />}
          </IconButton>
        ) : null}
      </div>
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
    <div className="grid gap-6">
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
    <div className="grid gap-6">
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

function canSubmitFeishuSetup(
  form: FeishuSetupInput,
  saving: boolean,
): boolean {
  return (
    !saving &&
    form.appId.trim().length > 0 &&
    form.appSecret.trim().length > 0 &&
    form.verificationToken.trim().length > 0 &&
    form.encryptKey.trim().length > 0
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
      <div className="space-y-3 text-sm text-muted-foreground">
        <h2 className="mb-3 text-2xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].create.title;
          })}
        </h2>
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
                if (
                  event.defaultPrevented ||
                  event.button !== 0 ||
                  event.metaKey ||
                  event.ctrlKey ||
                  event.shiftKey ||
                  event.altKey ||
                  (event.currentTarget.target &&
                    event.currentTarget.target !== "_self")
                ) {
                  return;
                }
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
      <div className="space-y-3 text-sm text-muted-foreground">
        <h2 className="mb-3 text-2xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].credentials.title;
          })}
        </h2>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].credentials
              .description;
          })}
        </p>
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
      <div className="space-y-3 text-sm text-muted-foreground">
        <h2 className="mb-3 text-2xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].tokens.title;
          })}
        </h2>
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
      </div>
      <FeishuEventCredentialFields
        form={form}
        saving={saving}
        readOnly={readOnly}
      />
    </div>
  );
}

function FeishuEventsStep({ data }: { data: FeishuSetupData | null }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <div className="space-y-4">
      <div className="space-y-3 text-sm text-muted-foreground">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            {t(($) => {
              return $.connectors.providerSettings[platform].events.title;
            })}
          </h2>
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
      </div>
      <div className="flex gap-2">
        <Input
          aria-label={t(($) => {
            return $.connectors.providerSettings[platform].events.callbackLabel;
          })}
          value={data?.callbackUrl ?? ""}
          readOnly
        />
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

function FeishuRedirectStep({ data }: { data: FeishuSetupData | null }) {
  const brandName = useGet(brandName$);
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);

  return (
    <div className="space-y-4">
      <div className="space-y-3 text-sm text-muted-foreground">
        <h2 className="mb-3 text-2xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].redirect.title;
          })}
        </h2>
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
      <div className="flex gap-2">
        <Input
          aria-label={t(($) => {
            return $.connectors.providerSettings[platform].redirect.label;
          })}
          value={data?.oauthRedirectUrl ?? ""}
          readOnly
        />
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

function FeishuPermissionsStep({ data }: { data: FeishuSetupData | null }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const scopes = data?.oauthScopes ?? FEISHU_OAUTH_SCOPES;
  const scopeImportJson = JSON.stringify(
    {
      scopes: {
        tenant: FEISHU_TENANT_SCOPES,
        user: scopes,
      },
    },
    null,
    2,
  );
  return (
    <div className="space-y-4">
      <div className="space-y-3 text-sm text-muted-foreground">
        <h2 className="mb-3 text-2xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].permissions.title;
          })}
        </h2>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].permissions
              .description;
          })}
        </p>
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
        <details className="rounded-xl bg-gray-50 p-3">
          <summary className="flex cursor-default list-none items-center justify-between gap-2 rounded-lg text-xs text-muted-foreground hover:text-foreground">
            {t(($) => {
              return $.connectors.setupGuide.permissionsJson;
            })}
            <ChevronRight size={14} aria-hidden />
          </summary>
          <code
            className="mt-3 block max-h-56 overflow-y-auto whitespace-pre-wrap break-words text-xs text-foreground"
            data-testid="feishu-scope-import-json"
          >
            {scopeImportJson}
          </code>
        </details>
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

function FeishuPublishStep() {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  return (
    <div className="space-y-4">
      <div className="space-y-3 text-sm text-muted-foreground">
        <h2 className="mb-3 text-2xl font-semibold tracking-tight text-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].publish.title;
          })}
        </h2>
        <p className="leading-relaxed">
          {t(($) => {
            return $.connectors.providerSettings[platform].publish.description;
          })}
        </p>
      </div>
    </div>
  );
}

function FeishuSetupHelp({ step }: { readonly step: FeishuSetupStep }) {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const question =
    step === "publish"
      ? t(($) => {
          return $.connectors.providerSettings[platform].faq.approvalQuestion;
        })
      : step === "events" || step === "tokens"
        ? t(($) => {
            return $.connectors.providerSettings[platform].faq
              .challengeQuestion;
          })
        : step === "create"
          ? t(($) => {
              return $.connectors.providerSettings[platform].faq
                .botFeatureQuestion;
            })
          : null;
  if (!question) {
    return null;
  }
  const answer =
    step === "publish"
      ? t(($) => {
          return $.connectors.providerSettings[platform].faq.approvalAnswer;
        })
      : step === "create"
        ? t(($) => {
            return $.connectors.providerSettings[platform].faq.botFeatureAnswer;
          })
        : t(($) => {
            return $.connectors.providerSettings[platform].faq.challengeAnswer;
          });
  return (
    <details className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
      <summary className="flex cursor-default list-none items-start gap-2 rounded-lg py-1 hover:text-foreground">
        <ChevronRight size={14} className="mt-0.5 shrink-0" />
        {question}
      </summary>
      <p className="mt-3 pl-5 leading-relaxed">{answer}</p>
    </details>
  );
}

function FeishuSetupStepContent({
  step,
  data,
  form,
  saving,
  readOnly,
}: {
  step: FeishuSetupStep;
  data: FeishuSetupData | null;
  form: FeishuSetupInput;
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
      return <FeishuPublishStep />;
    }
  }
}

type FeishuSetupRequest = FeishuSetupInput & {
  readonly installationId?: string;
  readonly createNew?: boolean;
};

function feishuSetupRequest(
  form: FeishuSetupInput,
  data: FeishuSetupData | null,
): FeishuSetupRequest {
  const input = {
    appId: form.appId.trim(),
    appSecret: form.appSecret.trim(),
    verificationToken: form.verificationToken.trim(),
    encryptKey: form.encryptKey.trim(),
  };
  if (!data) {
    return { ...input, createNew: true };
  }
  return data.id ? { ...input, installationId: data.id } : input;
}

function canContinueFeishuSetup(args: {
  readonly step: FeishuSetupStep;
  readonly data: FeishuSetupData | null;
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
}: {
  step: FeishuSetupStep;
  data: FeishuSetupData | null;
  saving: boolean;
  checkingAppId: boolean;
  canContinue: boolean;
  readOnly: boolean;
  onClose: () => void;
  onBack: () => void;
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
    <footer className="sticky bottom-0 order-3 flex shrink-0 items-center justify-between gap-3 border-t border-border bg-background px-5 py-5 @3xl/feishu-setup:static @3xl/feishu-setup:px-6 @5xl/feishu-setup:px-8">
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
        type="submit"
        variant="secondary"
        className="min-w-28 bg-foreground text-background hover:bg-foreground/90"
        disabled={!canContinue}
      >
        {saving ? <Loader2 size={16} className="animate-spin" /> : null}
        {continueLabel}
        {(step !== "tokens" || readOnly) && step !== "publish" ? (
          <ArrowRight size={16} />
        ) : null}
      </Button>
    </footer>
  );
}

function FeishuSetupWizard({
  data,
  readOnly,
  onClose,
}: {
  data: FeishuSetupData | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
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
  const canContinue =
    !saving &&
    (readOnly || canContinueFeishuSetup({ step, data, form, saving }));

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canContinue) {
      return;
    }
    if (step === "tokens" && !readOnly) {
      detach(setup(feishuSetupRequest(form, data), signal), Reason.DomCallback);
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
      detach(completeSetup(installationId, signal), Reason.DomCallback);
      return;
    }
    if (step === "credentials" && !data) {
      detach(checkAppId(form.appId.trim(), signal), Reason.DomCallback);
      return;
    }
    advanceStep();
  };

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={submit}>
      <FeishuSetupProgress step={step} />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @3xl/feishu-setup:grid @3xl/feishu-setup:grid-cols-[minmax(0,1.18fr)_minmax(0,1fr)] @3xl/feishu-setup:overflow-hidden">
        <FeishuSetupGuide step={step} />
        <div className="contents @3xl/feishu-setup:order-2 @3xl/feishu-setup:flex @3xl/feishu-setup:min-h-0 @3xl/feishu-setup:flex-col @3xl/feishu-setup:border-l @3xl/feishu-setup:border-border">
          <div
            id="feishu-setup-fields"
            className="order-1 px-5 py-7 @3xl/feishu-setup:min-h-0 @3xl/feishu-setup:flex-1 @3xl/feishu-setup:overflow-y-auto @3xl/feishu-setup:px-8 @3xl/feishu-setup:py-9 @5xl/feishu-setup:px-12"
          >
            <p className="mb-3 hidden text-xs text-muted-foreground @3xl/feishu-setup:block">
              {t(
                ($) => {
                  return $.onboarding.common.stepProgress;
                },
                {
                  current: FEISHU_SETUP_STEPS.indexOf(step) + 1,
                  total: FEISHU_SETUP_STEPS.length,
                },
              )}
            </p>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="mb-5 px-0 text-xs font-normal text-muted-foreground underline underline-offset-4 hover:text-foreground @3xl/feishu-setup:hidden"
              onClick={() => {
                // Fragment navigation reruns route setup and discards this draft.
                document
                  .getElementById("feishu-setup-reference")
                  ?.scrollIntoView({ block: "start" });
              }}
            >
              {t(($) => {
                return $.connectors.setupGuide.viewReference;
              })}
            </Button>
            <FeishuSetupStepContent
              step={step}
              data={data}
              form={form}
              saving={saving}
              readOnly={readOnly}
            />
            <FeishuSetupHelp step={step} />
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
          />
        </div>
      </div>
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
        <span className="min-w-0 truncate">
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
  const setUninstallInstallationId = useSet(setFeishuUninstallInstallationId$);
  const [disconnectLoadable, disconnect] = useLoadableSet(disconnectFeishuOrg$);
  const signal = useGet(pageSignal$);
  const disconnecting = disconnectLoadable.state === "loading";
  if (!isAdmin && !bot.isConnected) {
    return null;
  }
  return (
    <Popover>
      <PopoverTrigger
        render={
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
        }
      />
      <PopoverContent align="end" className="flex w-40 flex-col gap-0.5 p-2">
        {isAdmin ? (
          <Link
            pathname={
              bot.id
                ? platform === "lark"
                  ? ROUTES.settingsLarkSetupBot
                  : ROUTES.settingsFeishuSetupBot
                : platform === "lark"
                  ? ROUTES.settingsLarkSetup
                  : ROUTES.settingsFeishuSetup
            }
            options={
              bot.id
                ? { pathParams: { installationId: bot.id } }
                : { searchParams: new URLSearchParams({ appId: bot.appId }) }
            }
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-state-hover hover:text-accent-foreground"
          >
            {bot.setupCompleted
              ? t(($) => {
                  return $.connectors.providerSettings[platform].reviewGuide;
                })
              : t(($) => {
                  return $.connectors.providerSettings[platform].manage;
                })}
          </Link>
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
  isAdmin,
}: {
  bot: FeishuBotInstallation;
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
        {isAdmin ? <div className="min-w-0 flex-1" /> : null}
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
  isAdmin,
}: {
  bots: FeishuBotInstallation[];
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
            <FeishuBotRow bot={bot} isAdmin={isAdmin} />
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
  isAdmin,
}: {
  bots: FeishuBotInstallation[];
  isAdmin: boolean;
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
          <Link
            pathname={
              platform === "lark"
                ? ROUTES.settingsLarkSetup
                : ROUTES.settingsFeishuSetup
            }
            className={buttonVariants({ variant: "secondary", size: "sm" })}
          >
            <Plus size={16} />
            {t(($) => {
              return $.connectors.providerSettings[platform].addBot;
            })}
          </Link>
        ) : null}
      </div>
      <FeishuBotList bots={bots} isAdmin={isAdmin} />
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
          <summary className="flex cursor-default list-none items-start gap-2 text-sm font-medium text-foreground">
            <ChevronRight
              size={17}
              aria-hidden="true"
              className="mt-0.5 shrink-0 transition-transform group-open:rotate-90"
            />
            <span>
              {t(($) => {
                return $.connectors.providerSettings[platform].faq
                  .botFeatureQuestion;
              })}
            </span>
          </summary>
          <div className="mt-2 space-y-3 pl-[25px] text-sm leading-relaxed text-muted-foreground">
            <p>
              {t(($) => {
                return $.connectors.providerSettings[platform].faq
                  .botFeatureAnswer;
              })}
            </p>
            <FeishuGuideImage
              src={platformLarkAddBotFeatureImg}
              width={2112}
              height={1358}
              alt={t(($) => {
                return $.connectors.providerSettings[platform].faq
                  .botFeatureImageAlt;
              })}
            />
          </div>
        </details>
        <details className="group px-4 py-4 sm:px-5">
          <summary className="flex cursor-default list-none items-start gap-2 text-sm font-medium text-foreground">
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
          <summary className="flex cursor-default list-none items-start gap-2 text-sm font-medium text-foreground">
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

function FeishuPageHeader({
  title,
  description,
  backPath,
  backLabel,
  titleId,
}: {
  readonly title: string;
  readonly description: string;
  readonly backPath: RoutePath;
  readonly backLabel: string;
  readonly titleId?: string;
}) {
  return (
    <header className="shrink-0 bg-transparent px-4 pb-3 pt-10 sm:px-6">
      <div className="mx-auto max-w-[900px]">
        <div className="mb-4">
          <Link
            pathname={backPath}
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "h-8 gap-2 px-2 text-muted-foreground hover:text-foreground",
            )}
          >
            <ArrowLeft size={17} />
            {backLabel}
          </Link>
        </div>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-muted/40">
            <img src={feishuIconImg} alt="" className="h-7 w-7" />
          </span>
          <div className="min-w-0">
            <h1
              id={titleId}
              className="truncate text-lg font-semibold tracking-tight text-foreground"
            >
              {title}
            </h1>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {description}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}

export function FeishuSetupPage() {
  const { t } = useTranslation();
  const platform = useGet(feishuPlatform$);
  const active = useGet(feishuSetupActive$);
  const existing = useGet(feishuSetupExisting$);
  const installationId = useGet(feishuSetupInstallationId$);
  const dataLoadable = useLastLoadable(feishuOrgData$);
  const botsLoadable = useLastLoadable(feishuInstallations$);
  const close = useSet(closeFeishuSetup$);
  const orgData = loadableData(dataLoadable);
  const data = setupFeishuBot({
    bots: loadableData(botsLoadable) ?? [],
    existing,
    installationId,
  });
  const readOnly = data?.setupCompleted ?? false;
  const hasError = feishuSettingsHasError(
    dataLoadable.state,
    botsLoadable.state,
  );
  const title = t(($) => {
    return readOnly
      ? $.connectors.providerSettings[platform].reviewGuideTitle
      : existing
        ? $.connectors.providerSettings[platform].manageDialogTitle
        : $.connectors.providerSettings[platform].addDialogTitle;
  });

  return (
    <main
      className="@container/feishu-setup flex min-h-0 flex-1 flex-col overflow-hidden"
      aria-labelledby="feishu-setup-title"
    >
      <FeishuPageHeader
        titleId="feishu-setup-title"
        title={title}
        description={t(($) => {
          return readOnly
            ? $.connectors.providerSettings[platform].reviewGuideDescription
            : $.connectors.providerSettings[platform].addDialogDescription;
        })}
        backPath={
          platform === "lark" ? ROUTES.settingsLark : ROUTES.settingsFeishu
        }
        backLabel={t(($) => {
          return $.connectors.providerSettings[platform].bots;
        })}
      />
      {hasError ? (
        <p role="alert" className="p-8 text-sm text-destructive">
          {t(($) => {
            return $.connectors.providerSettings[platform].loadError;
          })}
        </p>
      ) : !active || !orgData ? (
        <div
          className="flex min-h-0 flex-1 flex-col gap-6 p-8"
          data-testid="feishu-setup-loading"
        >
          <Skeleton className="h-8 w-full" />
          <Skeleton className="min-h-0 flex-1 rounded-3xl" />
        </div>
      ) : !orgData.isAdmin ? (
        <p className="p-8 text-sm text-muted-foreground">
          {t(($) => {
            return $.connectors.providerSettings[platform].dialogAdminRequired;
          })}
        </p>
      ) : (
        <FeishuSetupWizard data={data} readOnly={readOnly} onClose={close} />
      )}
    </main>
  );
}

function FeishuUninstallDialog({ bots }: { bots: FeishuBotInstallation[] }) {
  const uninstallInstallationId = useGet(feishuUninstallInstallationId$);
  const bot = findFeishuBot(bots, uninstallInstallationId);
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
                uninstallInstallation(installationId, signal),
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

function setupFeishuBot(args: {
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
  const data = loadableData(dataLoadable) ?? null;
  const bots = loadableData(botsLoadable) ?? [];
  const isAdmin = data?.isAdmin ?? false;
  const loading = feishuSettingsLoading({
    dataState: dataLoadable.state,
    botsState: botsLoadable.state,
    botCount: bots.length,
  });
  const hasError = feishuSettingsHasError(
    dataLoadable.state,
    botsLoadable.state,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <FeishuPageHeader
        title={t(($) => {
          return $.connectors.providerSettings[platform].documentTitle;
        })}
        description={t(($) => {
          return $.connectors.providerSettings[platform].pageDescription;
        })}
        backPath={ROUTES.works}
        backLabel={t(($) => {
          return $.connectors.providerSettings[platform].backToIntegrations;
        })}
      />
      <main className="flex-1 overflow-auto px-4 pb-safe-or-8 pt-3 sm:px-6">
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
              <FeishuBotsCard bots={bots} isAdmin={isAdmin} />
              <FeishuUninstallDialog bots={bots} />
            </>
          )}
          <FeishuSetupFaq />
        </div>
      </main>
    </div>
  );
}
