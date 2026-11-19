import type { ReactNode } from "react";
import type { SharedThreadAudience } from "@okouai/api-contracts/contracts/shared-thread-visibility";
import { Field } from "@base-ui/react/field";
import {
  Button,
  cn,
  Checkbox,
  CopyButton,
  DialogTrigger,
  Dialog,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@okouai/ui";
import { toast } from "@okouai/ui/components/ui/sonner";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Check, Copy } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentOrgInfo$ } from "../../signals/auth.ts";
import type { ChatPanelSignals } from "../../signals/chat-page/chat-panel-signals.ts";
import { writeToClipboard } from "../../signals/okou-page/clipboard.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatPageHeader } from "./chat-page-layout.tsx";
import { SharedThreadShareMenu } from "./shared-thread-share-menu.tsx";

export function ChatThreadSharingHeader({
  thread,
  showTitle,
  children,
}: {
  thread: ChatPanelSignals;
  showTitle: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const phase = useGet(thread.sharing.phase$);
  const previewOpen = useGet(thread.sharing.previewOpen$);
  const setPreviewOpen = useSet(thread.sharing.setPreviewOpen$);
  const count = useGet(thread.sharing.selectedCount$);
  const total = useGet(thread.sharing.totalCount$);
  const allSelected = useGet(thread.sharing.allSelected$);
  const creation = useLoadable(thread.sharing.creation$);
  const toggleAll = useSet(thread.sharing.toggleAll$);
  const close = useSet(thread.sharing.close$);
  const signal = useGet(pageSignal$);
  const creating = creation.state === "loading";
  return (
    <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
      <div className="shrink-0">
        {showTitle && (
          <ChatPageHeader>
            <span className="text-sm font-medium text-foreground">
              {t(($) => {
                return $.chat.sharing.start;
              })}
            </span>
            <Button
              variant="quiet"
              size="sm"
              disabled={creating}
              onClick={() => {
                detach(
                  close(signal),
                  Reason.DomCallback,
                  "close shared thread selection",
                );
              }}
            >
              {t(($) => {
                return $.chat.sharing.close;
              })}
            </Button>
          </ChatPageHeader>
        )}
        {phase === "selecting" && (
          <div className="border-b border-border/60 px-4 py-2 sm:px-6">
            <div className="mx-auto flex w-full max-w-[900px] flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Field.Root
                  disabled={creating || total === 0}
                  className="relative"
                >
                  <Field.Label className="flex cursor-default items-center rounded-lg py-1.5 pr-2 pl-8 text-sm text-foreground hover:bg-state-hover data-disabled:pointer-events-none data-disabled:opacity-50">
                    {t(($) => {
                      return $.chat.sharing.selectAll;
                    })}
                  </Field.Label>
                  <Checkbox
                    className="absolute top-1/2 left-2 -translate-y-1/2"
                    checked={allSelected}
                    indeterminate={count > 0 && !allSelected}
                    onCheckedChange={() => {
                      if (toggleAll() === "too-large") {
                        toast.error(
                          t(($) => {
                            return $.chat.sharing.tooLarge;
                          }),
                        );
                      }
                    }}
                  />
                </Field.Root>
                <span role="status" className="text-xs text-muted-foreground">
                  {t(
                    ($) => {
                      return $.chat.sharing.selectionSummary;
                    },
                    { selected: count, total },
                  )}
                </span>
              </div>
              <DialogTrigger
                render={
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={count === 0 || creating}
                  />
                }
              >
                {t(($) => {
                  return $.chat.sharing.preview;
                })}
              </DialogTrigger>
            </div>
          </div>
        )}
      </div>
      {children}
    </Dialog>
  );
}

function ThreadSharingAccess({
  thread,
  disabled,
}: {
  thread: ChatPanelSignals;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const audience = useGet(thread.sharing.audience$);
  const changeAudience = useSet(thread.sharing.changeAudience$);
  const organization = useLastResolved(currentOrgInfo$);
  const options = [
    {
      value: "private",
      label: t(($) => {
        return $.artifacts.sharing.onlyMeOption;
      }),
      description: t(($) => {
        return $.artifacts.sharing.onlyMeDescription;
      }),
    },
    {
      value: "organization",
      label: organization?.name
        ? t(
            ($) => {
              return $.artifacts.sharing.organizationOption;
            },
            { organization: organization.name },
          )
        : t(($) => {
            return $.artifacts.sharing.organizationOptionUnnamed;
          }),
      description: t(($) => {
        return $.chat.sharing.workspaceAccess;
      }),
    },
    {
      value: "public",
      label: t(($) => {
        return $.artifacts.sharing.publicOption;
      }),
      description: t(($) => {
        return $.chat.sharing.linkAccess;
      }),
    },
  ] satisfies {
    value: SharedThreadAudience;
    label: string;
    description: string;
  }[];
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">
        {t(($) => {
          return $.chat.sharing.whoCanOpen;
        })}
      </span>
      <Select
        items={options}
        value={audience}
        disabled={disabled}
        onValueChange={(value, details) => {
          if (
            value !== "private" &&
            value !== "organization" &&
            value !== "public"
          ) {
            details.cancel();
            return;
          }
          changeAudience(value);
        }}
      >
        <SelectTrigger
          variant="neutral"
          aria-label={t(($) => {
            return $.chat.sharing.whoCanOpen;
          })}
        >
          <SelectValue
            placeholder={t(($) => {
              return $.chat.sharing.chooseAccess;
            })}
          />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => {
            return (
              <SelectItem
                key={option.value}
                value={option.value}
                aria-label={option.label}
                aria-description={option.description}
              >
                <span className="flex flex-col gap-0.5">
                  <span>{option.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {option.description}
                  </span>
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {options.find((option) => {
          return option.value === audience;
        })?.description ??
          t(($) => {
            return $.chat.sharing.chooseAccessHint;
          })}
      </p>
    </div>
  );
}

export function SharedThreadCreatedLink({
  thread,
  shareUrl,
  showCopy = false,
}: {
  readonly thread: ChatPanelSignals;
  readonly shareUrl: string;
  readonly showCopy?: boolean;
}) {
  const { t } = useTranslation();
  const visibility = useGet(thread.sharing.visibility$);
  const editSelection = useSet(thread.sharing.editSelection$);
  const close = useSet(thread.sharing.close$);
  const signal = useGet(pageSignal$);
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        showCopy
          ? "@min-[760px]/sharing:flex-row @min-[760px]/sharing:items-center"
          : "sm:flex-row sm:items-center",
      )}
    >
      <Input
        readOnly
        value={shareUrl}
        aria-label={t(($) => {
          return $.chat.sharing.shareLink;
        })}
        className="min-w-0 flex-1"
      />
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {showCopy && (
          <CopyButton
            copyAction={() => {
              return writeToClipboard(shareUrl);
            }}
            render={({ onClick, ref }, { copied }) => {
              return (
                <Button ref={ref} variant="neutral" onClick={onClick}>
                  {copied ? <Check /> : <Copy />}
                  {t(($) => {
                    return copied
                      ? $.artifacts.sharing.copied
                      : $.artifacts.sharing.copyLink;
                  })}
                </Button>
              );
            }}
          />
        )}
        {showCopy && (
          <Button
            variant="quiet"
            onClick={editSelection}
            aria-description={t(($) => {
              return $.chat.sharing.newLinkHint;
            })}
          >
            {t(($) => {
              return $.chat.sharing.changeSelection;
            })}
          </Button>
        )}
        {visibility && (
          <SharedThreadShareMenu
            session={visibility}
            showLabel
            manageAccess={showCopy}
          />
        )}
        {!showCopy && (
          <Button
            variant="outline"
            onClick={() => {
              detach(
                close(signal),
                Reason.DomCallback,
                "close shared thread selection",
              );
            }}
          >
            {t(($) => {
              return $.chat.sharing.close;
            })}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ChatThreadSharingFooter({
  thread,
}: {
  thread: ChatPanelSignals;
}) {
  const { t } = useTranslation();
  const count = useGet(thread.sharing.selectedCount$);
  const audience = useGet(thread.sharing.audience$);
  const id = useGet(thread.sharing.createdSharedThreadId$);
  const [creation, create] = useLoadableSet(thread.sharing.create$);
  const signal = useGet(pageSignal$);
  const creating = creation.state === "loading";
  return (
    <footer className="@container/sharing relative shrink-0 border-t border-border/60 px-4 py-3 sm:px-6">
      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-3">
        {id ? (
          <SharedThreadCreatedLink
            thread={thread}
            shareUrl={`${window.location.origin}/share/threads/${id}`}
            showCopy
          />
        ) : (
          <>
            {creation.state === "hasError" && (
              <p role="alert" className="text-sm text-destructive">
                {t(($) => {
                  return $.chat.sharing.draftCreateFailed;
                })}
              </p>
            )}
            <div className="flex flex-col gap-3 @min-[520px]/sharing:flex-row @min-[520px]/sharing:items-center @min-[520px]/sharing:gap-6">
              <ThreadSharingAccess thread={thread} disabled={creating} />
              <Button
                className="shrink-0 bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
                pending={creating}
                disabled={count === 0 || audience === null}
                onClick={() => {
                  detach(
                    create(signal),
                    Reason.DomCallback,
                    "create shared thread",
                  );
                }}
              >
                {t(($) => {
                  return $.chat.sharing.createAndCopy;
                })}
              </Button>
            </div>
          </>
        )}
      </div>
    </footer>
  );
}
