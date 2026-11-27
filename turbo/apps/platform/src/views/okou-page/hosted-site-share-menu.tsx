import type { infer as zInfer } from "zod";
import type { hostedDomainSettingsSchema } from "@okouai/api-contracts/contracts/hosted-site-domains";
import {
  HostedSiteDomains,
  HostedSiteDomainRemoveDialog,
  type HostedSiteDomainOperations,
} from "./hosted-site-domains.tsx";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { ReactNode } from "react";
import {
  Check,
  ChevronRight,
  Loader2,
  PanelTop,
  Pencil,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import {
  Button,
  Input,
  IconButton,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  MENU_ROW_HEIGHT_CLASS,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  cn,
} from "@okouai/ui";
import { useTranslation } from "react-i18next";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { Switch } from "@okouai/ui/components/ui/switch";
import { SharePeople } from "./share-people.tsx";
import { ShareAudienceChoices } from "./share-audience-choices.tsx";
import { ProBadge } from "./components/model-provider-picker.tsx";
import {
  domainVerificationDeadline,
  domainVerificationTimedOut,
} from "../../lib/hosted-site-domains.ts";
import { resolveEditableHostedSiteDomain } from "../../lib/platform-host.ts";
import { captureArtifactAction } from "../../lib/posthog.ts";
import { currentOrgInfo$ } from "../../signals/auth.ts";
import { featureSwitches$ } from "../../signals/external/feature-switch.ts";
import { artifactPaywallLocked$ } from "../../signals/okou-page/artifact-paywall.ts";
import {
  getHostedSiteShareScope,
  type HostedSiteShareSession,
} from "../../signals/hosted-site-sharing.ts";
import { detach, Reason } from "../../signals/utils.ts";
import {
  ShareCopyButton,
  SharePermissionChoices,
  ShareLoadError,
  ShareSkeleton,
} from "./artifact-share-menu.tsx";

interface ShareButtonProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly iconSize?: number;
}

function HostedSiteBannerSetting({
  session,
}: {
  readonly session: HostedSiteShareSession;
}) {
  const { t } = useTranslation();
  const owner = useLoadable(session.visibility$);
  const banner = useLoadable(session.banner$);
  const current = useLastResolved(session.banner$);
  const [operation, change] = useLoadableSet(session.changeBanner$);
  const signal = useGet(session.signal$);
  const features = useLastResolved(featureSwitches$);
  const rows =
    features?.[FeatureSwitchKey.HostedSiteShareRows] ||
    features?.[FeatureSwitchKey.ArtifactUserSharing];
  const paywallLocked = useLastResolved(artifactPaywallLocked$) === true;
  if (
    !signal ||
    owner.state !== "hasData" ||
    !owner.data ||
    (banner.state === "hasData" && !banner.data)
  ) {
    return null;
  }
  const saving = operation.state === "loading";
  const failed = banner.state === "hasError";
  return (
    <div
      className={
        rows
          ? "mt-1.5 border-t border-border pt-1.5"
          : "mt-4 border-t border-border pt-3"
      }
    >
      <div
        className={cn(
          "flex items-center justify-between",
          rows ? cn("gap-2", MENU_ROW_HEIGHT_CLASS) : "gap-3",
        )}
      >
        {rows && (
          <PanelTop size={16} className="shrink-0 text-muted-foreground" />
        )}
        <span
          className={cn("flex items-center gap-2", rows && "min-w-0 flex-1")}
        >
          <span className={cn("text-sm", rows && "min-w-0 truncate")}>
            {t(($) => {
              return $.artifacts.siteBanner.label;
            })}
          </span>
          {paywallLocked && <ProBadge />}
        </span>
        {!current ? (
          <Skeleton className="h-5 w-9 rounded-full" />
        ) : (
          <div className="flex items-center gap-2">
            {saving && <Loader2 size={14} className="animate-spin" />}
            <Switch
              size="compact"
              aria-label={t(($) => {
                return $.artifacts.siteBanner.label;
              })}
              checked={current?.showBanner === true}
              disabled={saving || banner.state !== "hasData"}
              onCheckedChange={(value) => {
                detach(change(value, signal), Reason.DomCallback);
              }}
            />
          </div>
        )}
      </div>
      {failed && (
        <ShareLoadError
          message={t(($) => {
            return $.artifacts.siteBanner.loadFailed;
          })}
        />
      )}
    </div>
  );
}

function AccessHeading({ saving }: { readonly saving: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 px-2 pb-1 pt-1 text-xs font-medium text-muted-foreground">
      {t(($) => {
        return $.artifacts.sharing.accessLabel;
      })}
      {saving && <Loader2 size={14} className="animate-spin" />}
    </div>
  );
}

function HostedSitePermissions({
  session,
  children,
}: {
  readonly session: HostedSiteShareSession;
  readonly children: ReactNode;
}) {
  const loadable = useLoadable(session.visibility$);
  const current = useLastResolved(session.visibility$);
  const [operation, change] = useLoadableSet(session.changeVisibility$);
  const pending = useGet(session.pendingVisibility$);
  const organization = useLastResolved(currentOrgInfo$);
  const emailSharing =
    useLastResolved(featureSwitches$)?.[FeatureSwitchKey.ArtifactUserSharing];
  const signal = useGet(session.signal$);
  if (!signal || (loadable.state === "hasData" && !loadable.data)) {
    return null;
  }
  const saving = operation.state === "loading";
  const failed = loadable.state === "hasError";
  return (
    <>
      {!emailSharing && <AccessHeading saving={saving} />}
      {loadable.state === "loading" && !saving ? (
        emailSharing ? (
          <div aria-busy="true" className="space-y-2">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-5 w-48" />
          </div>
        ) : (
          <ShareSkeleton showCopyButton={false} />
        )
      ) : emailSharing ? (
        <>
          <ShareAudienceChoices
            selected={current?.visibility}
            pending={pending}
            organizationName={organization?.name ?? null}
            saving={saving}
            unavailable={failed}
            onChange={(visibility) => {
              detach(change(visibility, signal), Reason.DomCallback);
            }}
          >
            {children}
          </ShareAudienceChoices>
          {failed && <ShareLoadError />}
        </>
      ) : (
        <>
          <SharePermissionChoices
            selected={
              loadable.state === "hasData"
                ? loadable.data?.visibility
                : undefined
            }
            organizationName={organization?.name ?? null}
            saving={saving}
            unavailable={failed}
            onChange={(visibility) => {
              detach(change(visibility, signal), Reason.DomCallback);
            }}
          />
          {failed && <ShareLoadError />}
        </>
      )}
    </>
  );
}

type WebsiteUrlFeedback = {
  // A short state that sits beside the field's label.
  readonly status: "checking" | "available" | null;
  readonly message: string;
  readonly error: boolean;
};

function useWebsiteUrlFeedback(
  session: HostedSiteShareSession,
  checking: boolean,
  checkFailed: boolean,
  saveFailed: boolean,
): WebsiteUrlFeedback {
  const { t } = useTranslation();
  const validation = useGet(session.validation$);
  const conflict = useGet(session.saveConflict$);
  if (saveFailed || conflict) {
    return {
      status: null,
      error: true,
      message: t(($) => {
        return $.artifacts.siteUrl.saveFailed;
      }),
    };
  }
  if (validation === "invalid" || validation === "taken") {
    return {
      status: null,
      error: true,
      message:
        validation === "invalid"
          ? t(($) => {
              return $.artifacts.siteUrl.invalid;
            })
          : t(($) => {
              return $.artifacts.siteUrl.taken;
            }),
    };
  }
  if (!checking && checkFailed) {
    return {
      status: null,
      error: true,
      message: t(($) => {
        return $.artifacts.siteUrl.checkFailed;
      }),
    };
  }
  // Moving the site breaks every link already handed out, so that is said
  // once an address can actually be saved, not before anything was typed.
  return {
    status: checking
      ? "checking"
      : validation === "available"
        ? "available"
        : null,
    error: false,
    message:
      !checking && validation === "available"
        ? t(($) => {
            return $.artifacts.siteUrl.oldUrlWarning;
          })
        : t(($) => {
            return $.artifacts.siteUrl.hint;
          }),
  };
}

function WebsiteUrlStatus({
  status,
}: {
  readonly status: WebsiteUrlFeedback["status"];
}) {
  const { t } = useTranslation();
  return (
    <span
      role="status"
      className="flex items-center gap-1 text-xs text-muted-foreground"
    >
      {status === "checking" &&
        t(($) => {
          return $.artifacts.siteUrl.checking;
        })}
      {status === "available" && (
        <>
          <Check size={14} className="text-green-600" />
          {t(($) => {
            return $.artifacts.siteUrl.available;
          })}
        </>
      )}
    </span>
  );
}

function DomainChoiceStatus({
  session,
  domain,
}: {
  readonly session: HostedSiteShareSession;
  readonly domain: zInfer<typeof hostedDomainSettingsSchema>["domains"][number];
}) {
  const { t } = useTranslation();
  const mountDeadline = useSet(session.domains.mountDeadline$);
  const expiredThrough = useGet(session.domains.expiredThrough$);
  const deadline = domainVerificationDeadline(domain);
  const timedOut = domainVerificationTimedOut(domain, expiredThrough);
  return (
    <span
      key={deadline}
      ref={mountDeadline}
      data-verification-expires-at={deadline}
      className="mt-1 flex items-center gap-1 text-xs text-muted-foreground"
    >
      {domain.ready ? (
        t(($) => {
          return $.artifacts.customDomain.httpsReady;
        })
      ) : deadline && !timedOut ? (
        <>
          <Loader2 size={12} aria-hidden className="motion-safe:animate-spin" />
          {t(($) => {
            return $.artifacts.customDomain.connecting;
          })}
        </>
      ) : timedOut ? (
        t(($) => {
          return $.artifacts.customDomain.timedOut;
        })
      ) : (
        t(($) => {
          return $.artifacts.customDomain.needsSetup;
        })
      )}
    </span>
  );
}
function WebsiteDomainChoices({
  session,
  saving,
  configuration,
}: {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly configuration: zInfer<typeof hostedDomainSettingsSchema>;
}) {
  const { t } = useTranslation();
  const selectedDomainId = useGet(session.domains.selectedDomainId$);
  const showDomains = useSet(session.domains.show$);
  const manageDomain = useSet(session.domains.manage$);
  const requestRemoval = useSet(session.domains.requestRemoval$);
  const signal = useGet(session.signal$);
  if (!signal) {
    return null;
  }
  return (
    <>
      {configuration.domains.length > 0 && (
        <ul
          aria-label={t(($) => {
            return $.artifacts.customDomain.yourDomains;
          })}
          className="space-y-2"
        >
          {configuration.domains.map((domain) => {
            const selected = domain.id === selectedDomainId;
            return (
              <li
                key={domain.id}
                className={cn(
                  "relative rounded-xl border border-border",
                  selected && "bg-gray-50",
                )}
              >
                <Button
                  type="button"
                  variant="quiet"
                  className="h-auto w-full justify-start gap-3 whitespace-normal rounded-xl py-3 pl-3 pr-14 text-left text-foreground"
                  aria-label={t(
                    ($) => {
                      return $.artifacts.customDomain.manage;
                    },
                    {
                      hostname: domain.hostname,
                    },
                  )}
                  aria-current={selected ? "true" : undefined}
                  disabled={saving || domain.removing}
                  onClick={() => {
                    return manageDomain(domain.id);
                  }}
                >
                  <span
                    className="flex size-4 shrink-0 items-center justify-center"
                    aria-hidden
                  >
                    {selected && <Check size={16} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-all text-sm font-medium">
                      {domain.hostname}
                    </span>
                    <DomainChoiceStatus session={session} domain={domain} />
                  </span>
                  <ChevronRight size={14} aria-hidden />
                </Button>
                <IconButton
                  className="absolute right-2 top-1/2 -translate-y-1/2"
                  aria-label={t(
                    ($) => {
                      return $.artifacts.customDomain.removeHostname;
                    },
                    { hostname: domain.hostname },
                  )}
                  disabled={saving}
                  onClick={() => {
                    return requestRemoval(domain.id);
                  }}
                >
                  <Trash2 size={14} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="quiet"
        disabled={saving}
        className="mt-3 w-full justify-start gap-3 pl-3 font-normal"
        onClick={() => {
          detach(showDomains(signal), Reason.DomCallback);
        }}
      >
        <Plus size={16} />
        {t(($) => {
          return $.artifacts.customDomain.connect;
        })}
      </Button>
    </>
  );
}
function WebsiteSlugInput({
  session,
  saving,
  suffix,
  onChange,
}: {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly suffix: ReactNode;
  readonly onChange: (value: string) => void;
}) {
  const id = session.inputId;
  const draft = useGet(session.draft$);
  const validation = useGet(session.validation$);
  if (draft === null) {
    return null;
  }
  return (
    <Input
      id={id}
      autoFocus
      value={draft}
      disabled={saving}
      autoComplete="off"
      autoCapitalize="none"
      spellCheck={false}
      maxLength={63}
      aria-describedby={`${id}-hint`}
      aria-invalid={validation === "invalid" || validation === "taken"}
      suffix={suffix}
      className="mt-2"
      onChange={(event) => {
        onChange(event.target.value);
      }}
      onKeyDown={(event) => {
        // Composition confirmation, including Safari's final key, cannot submit.
        if (
          event.key === "Enter" &&
          (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
        ) {
          event.preventDefault();
        }
      }}
    />
  );
}
function WebsiteUrlActions({
  session,
  saving,
  disabled,
}: {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const cancel = useSet(session.cancel$);
  return (
    <div className="mt-4 flex justify-end gap-1">
      <Button
        type="button"
        variant="quiet"
        size="sm"
        disabled={saving}
        onClick={() => {
          cancel();
        }}
      >
        {t(($) => {
          return $.artifacts.siteUrl.cancel;
        })}
      </Button>
      <Button type="submit" size="sm" disabled={disabled}>
        {saving && <Loader2 size={14} className="animate-spin" />}
        {t(($) => {
          return $.artifacts.siteUrl.save;
        })}
      </Button>
    </div>
  );
}
function PlatformWebsiteUrlForm({
  session,
  saving,
  saveFailed,
  onSave,
  configuration,
}: {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly onSave: () => void;
  readonly configuration: zInfer<typeof hostedDomainSettingsSchema> | null;
}) {
  const { t } = useTranslation();
  const signal = useGet(session.signal$);
  const id = session.inputId;
  const details = useLastResolved(session.details$);
  const draft = useGet(session.draft$);
  const validation = useGet(session.validation$);
  const [checking, change] = useLoadableSet(session.change$);
  const feedback = useWebsiteUrlFeedback(
    session,
    checking.state === "loading",
    checking.state === "hasError",
    saveFailed,
  );
  const selectedDomainId = useGet(session.domains.selectedDomainId$);
  const domainNotice = useGet(session.domains.notice$);
  if (!details || draft === null || !signal) {
    return null;
  }
  const changedDomain =
    configuration !== null &&
    selectedDomainId !== configuration.selectedDomainId;
  const canSavePlatform =
    validation === "available" ||
    (changedDomain && draft === details.publicSlug);
  const suffix = new URL(details.url).hostname.slice(details.publicSlug.length);
  return (
    <form
      className={configuration ? undefined : "mt-4"}
      onSubmit={(event) => {
        // This form owns URL submission; keep navigation with the current preview.
        event.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          {t(($) => {
            return $.artifacts.siteUrl.label;
          })}
        </label>
        <WebsiteUrlStatus status={feedback.status} />
      </div>
      <WebsiteSlugInput
        session={session}
        saving={saving}
        suffix={suffix}
        onChange={(value) => {
          detach(change(value, signal), Reason.DomCallback);
        }}
      />
      <p
        id={`${id}-hint`}
        role="status"
        className={cn(
          "mt-2 text-xs",
          feedback.error ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {domainNotice ?? feedback.message}
      </p>
      <WebsiteUrlActions
        session={session}
        saving={saving}
        disabled={saving || checking.state === "loading" || !canSavePlatform}
      />
    </form>
  );
}

function WebsiteDomainSelectionForm({
  session,
  saving,
  configuration,
  onSave,
}: {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly configuration: zInfer<typeof hostedDomainSettingsSchema>;
  readonly onSave: () => void;
}) {
  const { t } = useTranslation();
  const selected = useGet(session.domains.selectedDomainId$);
  const notice = useGet(session.domains.notice$);
  const domain = configuration.domains.find((item) => {
    return item.id === selected && item.ready && !item.removing;
  });
  const changed = selected !== configuration.selectedDomainId;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (domain && changed) {
          onSave();
        }
      }}
    >
      <p className="mb-3 text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.customDomain.addressHint;
        })}
      </p>
      <WebsiteDomainChoices
        session={session}
        saving={saving}
        configuration={configuration}
      />
      <p
        role="status"
        className="mt-3 min-h-5 break-all text-xs text-muted-foreground"
      >
        {notice}
      </p>
      <WebsiteUrlActions
        session={session}
        saving={saving}
        disabled={saving || !domain || !changed}
      />
    </form>
  );
}

function WebsiteUrlEditor({
  session,
  saving,
  saveFailed,
  onSave,
  domainOperations,
}: {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly onSave: () => void;
  readonly domainOperations: HostedSiteDomainOperations;
}) {
  const { t } = useTranslation();
  const signal = useGet(session.signal$);
  const details = useLastResolved(session.details$);
  const domainSettings = useLoadable(session.domains.settings$);
  const previousDomainSettings = useLastResolved(session.domains.settings$);
  const addressMode = useGet(session.domains.addressMode$);
  const mountCustomTab = useSet(session.domains.mountCustomTab$);
  const changeAddressMode = useSet(session.domains.changeMode$);
  const features = useLastResolved(featureSwitches$);
  const domainOpen = useGet(session.domains.open$);
  if (!details || !signal) {
    return null;
  }
  const configuration =
    domainSettings.state === "hasData"
      ? domainSettings.data
      : (previousDomainSettings ?? null);
  const platformForm = (
    <PlatformWebsiteUrlForm
      session={session}
      saving={saving}
      saveFailed={saveFailed}
      onSave={onSave}
      configuration={configuration}
    />
  );
  const busy =
    saving ||
    domainOperations.creating ||
    domainOperations.verifying ||
    domainOperations.removing;
  if (!configuration) {
    if (
      domainSettings.state === "loading" &&
      (features?.[FeatureSwitchKey.HostedSiteCustomDomains] ||
        details.effectiveUrl)
    ) {
      return (
        <div className="mt-4 space-y-4" aria-busy="true">
          <Skeleton className="h-9 w-full rounded-lg" />
          <Skeleton className="h-9 w-full rounded-lg" />
          <div className="flex justify-end">
            <Skeleton className="h-8 w-16 rounded-lg" />
          </div>
        </div>
      );
    }
    return platformForm;
  }
  return (
    <>
      <Tabs
        className="mt-4"
        value={addressMode}
        onValueChange={(value) => {
          if (value === "platform" || value === "custom") {
            detach(changeAddressMode(value, signal), Reason.DomCallback);
          }
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger className="flex-1" value="platform" disabled={busy}>
            {t(($) => {
              return $.artifacts.customDomain.okouUrl;
            })}
          </TabsTrigger>
          <TabsTrigger className="flex-1" value="custom" disabled={busy}>
            {t(($) => {
              return $.artifacts.customDomain.title;
            })}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="platform" className="mt-4">
          {platformForm}
        </TabsContent>
        <TabsContent value="custom" className="mt-4" ref={mountCustomTab}>
          {domainOpen ? (
            <HostedSiteDomains
              session={session}
              operations={domainOperations}
            />
          ) : (
            <WebsiteDomainSelectionForm
              session={session}
              saving={busy}
              configuration={configuration}
              onSave={onSave}
            />
          )}
        </TabsContent>
      </Tabs>
      <HostedSiteDomainRemoveDialog
        session={session}
        operations={domainOperations}
        configuration={configuration}
      />
    </>
  );
}

function CustomizeUrlRow({
  address,
  autoFocus,
  paywallLocked,
  onEdit,
}: {
  readonly address: string | null;
  readonly autoFocus: boolean;
  readonly paywallLocked: boolean;
  readonly onEdit: () => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.artifacts.siteUrl.customize;
  });
  // A menu row, like the access options above it: the chevron says the row
  // opens the address editor, and the current address is its value.
  return (
    <div className="-mx-2">
      <Button
        autoFocus={autoFocus}
        variant="quiet"
        aria-label={label}
        className="w-full justify-start px-2 font-normal text-foreground"
        onClick={onEdit}
      >
        <Pencil size={16} className="shrink-0 text-muted-foreground" />
        <span className="shrink-0">{label}</span>
        {paywallLocked && <ProBadge />}
        <span className="min-w-0 flex-1 truncate text-right text-xs text-muted-foreground">
          {address}
        </span>
        <ChevronRight size={16} className="shrink-0" />
      </Button>
    </div>
  );
}

function HostedSiteShareActions({
  session,
  surface,
  link,
  address,
  customizable,
  loadFailed,
}: {
  readonly session: HostedSiteShareSession;
  readonly surface: "dialog" | "sidebar";
  readonly link: string | null;
  readonly address: string | null;
  readonly customizable: boolean;
  readonly loadFailed: boolean;
}) {
  const { t } = useTranslation();
  const signal = useGet(session.signal$);
  const returnFocus = useGet(session.returnFocus$);
  const copiedUrl = useGet(session.copiedUrl$);
  const edit = useSet(session.edit$);
  const copy = useSet(session.copy$);
  const banner = useLoadable(session.banner$);
  const features = useLastResolved(featureSwitches$);
  const rows =
    features?.[FeatureSwitchKey.HostedSiteShareRows] ||
    features?.[FeatureSwitchKey.ArtifactUserSharing];
  const paywallLocked = useLastResolved(artifactPaywallLocked$) === true;
  if (!signal) {
    return null;
  }
  const copyLink = () => {
    // Analytics must not prevent the user's copy operation from starting.
    detach(copy(signal), Reason.DomCallback);
    captureArtifactAction({
      action: "banner_share",
      surface,
      target: "hosted_site",
      show_banner:
        banner.state === "hasData" && banner.data
          ? banner.data.showBanner
          : "unknown",
    });
  };
  const loadFailedStatus = loadFailed && (
    <div className="mt-3 flex items-center justify-between gap-2">
      <span role="status" className="text-xs text-muted-foreground">
        {t(($) => {
          return $.artifacts.siteUrl.loadFailed;
        })}
      </span>
    </div>
  );
  if (rows) {
    return (
      <>
        {customizable && (
          <CustomizeUrlRow
            address={address}
            autoFocus={returnFocus}
            paywallLocked={paywallLocked}
            onEdit={() => {
              detach(edit(signal), Reason.DomCallback);
            }}
          />
        )}
        {loadFailedStatus}
        <ShareCopyButton
          className="mt-1.5 w-full"
          size={
            features?.[FeatureSwitchKey.ArtifactUserSharing] ? "default" : "sm"
          }
          copied={link !== null && copiedUrl === link}
          disabled={link === null}
          onCopy={copyLink}
        />
      </>
    );
  }
  return (
    <>
      {loadFailedStatus}
      <div className="mt-4 flex items-center gap-2">
        {customizable && (
          // `-ml-2` pulls the quiet button's padding into the gutter so its
          // pencil lines up with the globe above it.
          <Button
            autoFocus={returnFocus}
            variant="quiet"
            size="sm"
            className="-ml-2 px-2"
            onClick={() => {
              detach(edit(signal), Reason.DomCallback);
            }}
          >
            <Pencil />
            {t(($) => {
              return $.artifacts.siteUrl.customize;
            })}
            {paywallLocked && <ProBadge />}
          </Button>
        )}
        <ShareCopyButton
          className="ml-auto"
          copied={link !== null && copiedUrl === link}
          disabled={link === null}
          onCopy={copyLink}
        />
      </div>
    </>
  );
}

function HostedSiteShareUrl({
  session,
  surface,
  saving,
  saveFailed,
  onSave,
  domainOperations,
}: {
  readonly session: HostedSiteShareSession;
  readonly surface: "dialog" | "sidebar";
  readonly saving: boolean;
  readonly saveFailed: boolean;
  readonly onSave: () => void;
  readonly domainOperations: HostedSiteDomainOperations;
}) {
  const link = useLoadable(session.copyUrl$);
  // Stays subscribed while the editor is open, so Cancel and Save return to
  // settled actions instead of a loading frame.
  const details = useLoadable(session.details$);
  const editing = useGet(session.editing$);
  const features = useLastResolved(featureSwitches$);
  const rows =
    features?.[FeatureSwitchKey.HostedSiteShareRows] ||
    features?.[FeatureSwitchKey.ArtifactUserSharing];
  return (
    <>
      {editing ? (
        <WebsiteUrlEditor
          session={session}
          saving={saving}
          saveFailed={saveFailed}
          onSave={onSave}
          domainOperations={domainOperations}
        />
      ) : link.state === "loading" ? (
        // Nothing can be copied or customized until the current address is
        // known, so the footer holds its place without offering either.
        <div
          aria-busy="true"
          className={rows ? "mt-1.5 flex" : "mt-4 flex justify-end"}
        >
          <Skeleton
            className={cn("h-8 rounded-lg", rows ? "w-full" : "w-28")}
          />
        </div>
      ) : (
        <HostedSiteShareActions
          session={session}
          surface={surface}
          link={link.state === "hasData" ? link.data : null}
          address={
            details.state === "hasData" && details.data
              ? new URL(
                  link.state === "hasData" && link.data
                    ? link.data
                    : (details.data.effectiveUrl ?? details.data.url),
                ).hostname
              : null
          }
          customizable={
            details.state === "hasData" &&
            details.data?.isActive === true &&
            new URL(details.data.url).hostname.endsWith(
              `.${resolveEditableHostedSiteDomain()}`,
            )
          }
          loadFailed={details.state === "hasError"}
        />
      )}
    </>
  );
}

function HostedSiteShareBody({
  session,
  permissions,
  banner,
  padded,
  children,
}: {
  readonly session: HostedSiteShareSession;
  readonly permissions: ReactNode;
  readonly banner: ReactNode;
  /** The people layout holds a field, so it takes dialog padding throughout. */
  readonly padded: boolean;
  readonly children: ReactNode;
}) {
  const editing = useGet(session.editing$);
  return (
    <div className={editing || padded ? "p-4" : "p-1.5"}>
      {!editing && permissions}
      <div className={cn(!editing && !padded && "px-2")}>
        {!editing && banner}
        {children}
      </div>
    </div>
  );
}

function HostedSiteSharePopover({
  session,
  ariaLabel,
  className,
  iconSize = 16,
  saving,
  children,
}: ShareButtonProps & {
  readonly session: HostedSiteShareSession;
  readonly saving: boolean;
  readonly children: ReactNode;
}) {
  const settings = useLoadable(session.hasSettings$);
  const signal = useGet(session.signal$);
  const open = useGet(session.open$);
  const setOpen = useSet(session.setOpen$);
  const show = useSet(session.show$);
  // Keep settings subscribed while the share popup is closed.
  useLoadable(session.copyUrl$);
  useLoadable(session.visibility$);
  useLoadable(session.banner$);
  if (!signal) {
    return null;
  }
  return (
    <Popover
      open={open && !(settings.state === "hasData" && !settings.data)}
      onOpenChange={(nextOpen, details) => {
        // An in-flight save keeps its owner until it completes.
        if (saving) {
          details.cancel();
          return;
        }
        if (nextOpen) {
          detach(show(signal), Reason.DomCallback);
        } else {
          setOpen(false);
        }
      }}
    >
      <PopoverTrigger
        aria-label={ariaLabel}
        render={
          <Button
            variant="quiet"
            size="icon-sm"
            highlightWhenOpen
            className={className}
          />
        }
      >
        <Share2 size={iconSize} />
      </PopoverTrigger>

      {children}
    </Popover>
  );
}

function HostedSiteShareSessionMenu({
  session,
  surface,
  banner,
  ...props
}: ShareButtonProps & {
  readonly session: HostedSiteShareSession;
  readonly surface: "dialog" | "sidebar";
  readonly banner: ReactNode;
}) {
  const signal = useGet(session.signal$);
  const domainOpen = useGet(session.domains.open$);
  const editing = useGet(session.editing$);
  const [domainCreating, createDomain] = useLoadableSet(
    session.domains.create$,
  );
  const [domainVerifying, verifyDomain] = useLoadableSet(
    session.domains.verify$,
  );
  const [domainRemoving, removeDomain] = useLoadableSet(
    session.domains.remove$,
  );
  const [saving, save] = useLoadableSet(session.save$);
  const [sharing, share] = useLoadableSet(session.people.share$);
  const [removing, remove] = useLoadableSet(session.people.remove$);
  const features = useLastResolved(featureSwitches$);
  const emailSharing = features?.[FeatureSwitchKey.ArtifactUserSharing];
  const domainEditor =
    domainOpen ||
    (editing && features?.[FeatureSwitchKey.HostedSiteCustomDomains]);
  if (!signal) {
    return null;
  }
  // Frame-only preload/open updates keep these body children and their save owner.
  return (
    <HostedSiteSharePopover
      session={session}
      saving={
        saving.state === "loading" ||
        sharing.state === "loading" ||
        removing.state === "loading" ||
        domainCreating.state === "loading" ||
        domainVerifying.state === "loading" ||
        domainRemoving.state === "loading"
      }
      {...props}
    >
      <PopoverContent
        align="end"
        aria-label={props.ariaLabel}
        className={cn(
          "max-w-[calc(100vw-2rem)] p-0",
          domainEditor
            ? "max-h-[var(--available-height)] w-105 overflow-y-auto overscroll-contain"
            : emailSharing
              ? "w-100"
              : "w-90",
        )}
      >
        <HostedSiteShareBody
          session={session}
          padded={emailSharing === true}
          permissions={
            <HostedSitePermissions session={session}>
              <SharePeople
                session={session}
                busy={
                  sharing.state === "loading" || removing.state === "loading"
                }
                failed={
                  sharing.state === "hasError" || removing.state === "hasError"
                }
                onShare={(email) => {
                  detach(share(email, signal), Reason.DomCallback);
                }}
                onRemove={(id) => {
                  detach(remove(id, signal), Reason.DomCallback);
                }}
              />
            </HostedSitePermissions>
          }
          banner={banner}
        >
          <HostedSiteShareUrl
            session={session}
            surface={surface}
            saving={saving.state === "loading"}
            saveFailed={saving.state === "hasError"}
            domainOperations={{
              creating: domainCreating.state === "loading",
              verifying: domainVerifying.state === "loading",
              verifyFailed: domainVerifying.state === "hasError",
              removing: domainRemoving.state === "loading",
              saving: saving.state === "loading",
              saveFailed: saving.state === "hasError",
              create: () => {
                detach(createDomain(signal), Reason.DomCallback);
              },
              verify: () => {
                detach(verifyDomain(signal), Reason.DomCallback);
              },
              remove: () => {
                detach(removeDomain(signal), Reason.DomCallback);
              },
              save: () => {
                detach(save(signal), Reason.DomCallback);
              },
            }}
            onSave={() => {
              detach(save(signal), Reason.DomCallback);
            }}
          />
        </HostedSiteShareBody>
      </PopoverContent>
    </HostedSiteSharePopover>
  );
}

export function HostedSiteShareMenu({
  url,
  surface,
  ...props
}: ShareButtonProps & {
  readonly url: string;
  readonly surface: "dialog" | "sidebar";
}) {
  const scope = getHostedSiteShareScope(surface);
  const session = useGet(scope.session$);
  return (
    <span className="inline-flex">
      {session?.sourceUrl === url ? (
        // Settings have independent subscriptions; URL saves keep these nodes.
        <HostedSiteShareSessionMenu
          key={session.inputId}
          session={session}
          surface={surface}
          banner={<HostedSiteBannerSetting session={session} />}
          {...props}
        />
      ) : (
        <Button
          variant="quiet"
          size="icon-sm"
          aria-label={props.ariaLabel}
          className={props.className}
        >
          <Share2 size={props.iconSize ?? 16} />
        </Button>
      )}
    </span>
  );
}
