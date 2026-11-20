import type { SharedThreadAudience } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import {
  Check,
  ChevronDown,
  Globe,
  Lock,
  Share2,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { currentOrgInfo$ } from "../../signals/auth.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import type { SharedThreadVisibilitySignals } from "../../signals/shared-thread-visibility.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ShareMenuContent } from "./artifact-share-menu.tsx";

export function MessageShareMenu({
  copied,
  onShare,
}: {
  readonly copied: boolean;
  readonly onShare: (audience: SharedThreadAudience) => void;
}) {
  const { t } = useTranslation();
  const label = t(($) => {
    return $.chat.actions.shareMessage;
  });
  const copiedLabel = t(($) => {
    return $.artifacts.sharing.copied;
  });
  return (
    <DropdownMenu>
      <TooltipProvider delay={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="quiet"
                    size={copied ? "xs" : "icon-xs"}
                    iconSize="sm"
                    className={
                      copied
                        ? "gap-1 px-1.5 text-muted-foreground"
                        : "text-muted-foreground/60"
                    }
                    aria-label={copied ? copiedLabel : label}
                    data-testid="chat-message-share"
                  >
                    {copied ? <Check /> : <Share2 />}
                    {copied ? copiedLabel : null}
                  </Button>
                }
              />
            }
          />
          {!copied && <TooltipContent side="bottom">{label}</TooltipContent>}
        </Tooltip>
      </TooltipProvider>
      <DropdownMenuContent align="start" className="w-64" aria-label={label}>
        <DropdownMenuItem
          onClick={() => {
            onShare("organization");
          }}
        >
          <Users className="text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            <span>
              {t(($) => {
                return $.artifacts.sharing.organization;
              })}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(($) => {
                return $.chat.sharing.organizationDescription;
              })}
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => {
            onShare("public");
          }}
        >
          <Globe className="text-muted-foreground" />
          <span className="flex min-w-0 flex-col">
            <span>
              {t(($) => {
                return $.chat.sharing.everyone;
              })}
            </span>
            <span className="text-xs text-muted-foreground">
              {t(($) => {
                return $.artifacts.sharing.publicOption;
              })}
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ""}
      </span>
    </DropdownMenu>
  );
}

function audienceIcon(audience: SharedThreadAudience): LucideIcon {
  if (audience === "private") {
    return Lock;
  }
  return audience === "public" ? Globe : Users;
}

// Names the audience the way the menu's options do, so the trigger and the
// checked option read the same.
function audienceLabel(
  t: TFunction,
  audience: SharedThreadAudience,
  organizationName: string | null,
): string {
  if (audience === "private") {
    return t(($) => {
      return $.artifacts.sharing.onlyMeOption;
    });
  }
  if (audience === "public") {
    return t(($) => {
      return $.artifacts.sharing.publicOption;
    });
  }
  if (organizationName === null) {
    return t(($) => {
      return $.artifacts.sharing.organizationOptionUnnamed;
    });
  }
  return t(
    ($) => {
      return $.artifacts.sharing.organizationOption;
    },
    { organization: organizationName },
  );
}

/** The neutral trigger content for a chosen audience: its icon, its name and
 * the disclosure chevron. */
function AudienceTriggerContent({
  audience,
  organizationName,
}: {
  readonly audience: SharedThreadAudience;
  readonly organizationName: string | null;
}) {
  const { t } = useTranslation();
  const Icon = audienceIcon(audience);
  return (
    <>
      <Icon className="text-muted-foreground" />
      {audienceLabel(t, audience, organizationName)}
      {/* Pushed to the trailing edge when the trigger fills its row. */}
      <ChevronDown className="ml-auto text-muted-foreground" />
    </>
  );
}

export function SharedThreadAudiencePicker({
  audience,
  disabled,
  onChange,
}: {
  readonly audience: SharedThreadAudience;
  readonly disabled: boolean;
  readonly onChange: (audience: SharedThreadAudience) => void;
}) {
  const { t } = useTranslation();
  const organization = useLastResolved(currentOrgInfo$);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="neutral"
            className="justify-start"
            disabled={disabled}
            aria-label={t(($) => {
              return $.artifacts.sharing.accessLabel;
            })}
          />
        }
      >
        <AudienceTriggerContent
          audience={audience}
          organizationName={organization?.name ?? null}
        />
      </PopoverTrigger>
      <ShareMenuContent
        label={t(($) => {
          return $.artifacts.sharing.accessLabel;
        })}
        selected={audience}
        organizationName={organization?.name ?? null}
        unavailable={disabled}
        onChange={onChange}
      />
    </Popover>
  );
}

export function SharedThreadShareMenu({
  session,
  showLabel = false,
}: {
  readonly session: SharedThreadVisibilitySignals;
  readonly showLabel?: boolean;
}) {
  const { t } = useTranslation();
  const status = useLoadable(session.status$);
  const details = useLastResolved(session.status$);
  const [changeState, change] = useLoadableSet(session.change$);
  const copy = useSet(session.copy$);
  const copied = useGet(session.copied$);
  const signal = useGet(pageSignal$);
  const saving = changeState.state === "loading";
  const saveError = useGet(session.saveError$);
  const recipient = status.state === "hasData" && !status.data;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant={showLabel ? "neutral" : "quiet"}
            size={showLabel ? "default" : "icon-sm"}
            className={showLabel ? "justify-start" : undefined}
            aria-label={t(($) => {
              return $.sharedThread.share;
            })}
          />
        }
      >
        {showLabel && details ? (
          <AudienceTriggerContent
            audience={details.audience}
            organizationName={details.organization.name}
          />
        ) : (
          <Share2 size={showLabel ? 16 : 18} />
        )}
      </PopoverTrigger>
      <ShareMenuContent
        label={t(($) => {
          return $.sharedThread.share;
        })}
        selected={details?.audience}
        organizationName={details?.organization.name ?? null}
        loading={!details && status.state === "loading"}
        saving={saving}
        failed={status.state === "hasError"}
        showPermissions={!recipient}
        errorMessage={
          saveError ??
          (changeState.state === "hasError"
            ? t(($) => {
                return $.artifacts.sharing.updateFailed;
              })
            : null)
        }
        onChange={(audience) => {
          detach(change(audience, signal), Reason.DomCallback);
        }}
        // The labelled trigger sits beside its own Copy link action, so its
        // menu carries only the access choice.
        copy={
          showLabel
            ? undefined
            : {
                copied,
                disabled: !details && !recipient,
                onCopy: () => {
                  detach(copy(signal), Reason.DomCallback);
                },
              }
        }
      />
    </Popover>
  );
}
