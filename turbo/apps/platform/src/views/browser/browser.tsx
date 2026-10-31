import type { ReactNode } from "react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Globe,
  Loader2,
  Maximize2,
  Plus,
  RotateCw,
  Settings,
  X,
} from "lucide-react";
import {
  Button,
  IconButton,
  Input,
  Textarea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@okouai/ui";
import type { BrowserSignals } from "../../signals/browser/browser.ts";
import { CdpFault } from "../../signals/browser/cdp/errors.ts";
import { NavigationFault } from "../../signals/browser/navigation/action.ts";
import type { DisplayModeResult } from "../../signals/browser/display/sync.ts";
import { captureResolutions } from "../../signals/browser/viewer/capture.ts";
import type {
  ViewerCaptureOptions,
  ViewerTransport,
  WindowSizeSync,
} from "../../signals/browser/viewer/types.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, isAbortError, Reason } from "../../signals/utils.ts";

function isBrowserOperationFailure(
  error: unknown,
  imageFailureHandled = false,
): boolean {
  if (
    isAbortError(error) ||
    (error instanceof Error && isAbortError(error.cause))
  ) {
    return false;
  }
  // Selection/create/reconnect can reject after native creation succeeded. The
  // image-recovery controls own those image failures, including a later retry.
  return !(
    imageFailureHandled &&
    error instanceof CdpFault &&
    (error.kind === "frame" ||
      (error.kind === "protocol" &&
        (error.request?.method === "Page.startScreencast" ||
          error.request?.method === "Page.stopScreencast")))
  );
}

function BrowserOperationError({
  failed,
  className = "border-b border-divider px-3 py-2 text-sm text-muted-foreground",
}: {
  readonly failed: boolean;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  if (!failed) {
    return null;
  }
  return (
    <p role="alert" className={className}>
      {t(($) => {
        return $.browserViewer.operationFailed;
      })}
    </p>
  );
}

function BrowserSettings({ signals }: { readonly signals: BrowserSignals }) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  // The owner remains mounted when the menu closes, including its operation errors.
  const [captureOperation, changeCapture] = useLoadableSet(
    signals.changeCapture$,
  );
  const [transportOperation, changeTransport] = useLoadableSet(
    signals.changeTransport$,
  );
  const [windowOperation, changeWindowSizeSync] = useLoadableSet(
    signals.changeWindowSizeSync$,
  );
  const [syncOperation, syncDisplay] = useLoadableSet(signals.syncDisplay$);
  const failed = [
    captureOperation,
    transportOperation,
    windowOperation,
    syncOperation,
  ].some((operation) => {
    return (
      operation.state === "hasError" &&
      isBrowserOperationFailure(operation.error)
    );
  });
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <IconButton
              type="button"
              aria-label={t(($) => {
                return $.browserViewer.settings;
              })}
              className="size-8"
            />
          }
        >
          <Settings size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="min-w-52"
          aria-label={t(($) => {
            return $.browserViewer.settings;
          })}
        >
          <CaptureSettingsMenu
            signals={signals}
            pending={captureOperation.state === "loading"}
            onChange={(value) => {
              return changeCapture(value, pageSignal);
            }}
          />
          <ResolutionSettingsMenu
            signals={signals}
            pending={captureOperation.state === "loading"}
            onChange={(value) => {
              return changeCapture(value, pageSignal);
            }}
          />
          <WindowSettingsMenu
            signals={signals}
            pending={windowOperation.state === "loading"}
            syncing={syncOperation.state === "loading"}
            onChange={(value) => {
              return changeWindowSizeSync(value, pageSignal);
            }}
            onSync={() => {
              return syncDisplay(pageSignal);
            }}
          />
          <TransportSettingsMenu
            signals={signals}
            pending={transportOperation.state === "loading"}
            onChange={(value) => {
              return changeTransport(value, pageSignal);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <BrowserOperationError
        failed={failed}
        className="absolute right-2 top-full z-20 max-w-64 rounded-lg border border-divider bg-popover p-3 text-sm shadow-md"
      />
    </>
  );
}

function CaptureSettingsMenu({
  signals,
  pending,
  onChange,
}: {
  readonly signals: BrowserSignals;
  readonly pending: boolean;
  readonly onChange: (value: ViewerCaptureOptions) => Promise<void>;
}) {
  const { t } = useTranslation();
  const capture = useGet(signals.capture$);
  const qualityLabel = t(($) => {
    return $.browserViewer.quality;
  });
  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {t(($) => {
            return $.browserViewer.format;
          })}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuRadioGroup value={capture.format ?? "webp"}>
            {(["webp", "jpeg", "png"] as const).map((format) => {
              return (
                <DropdownMenuRadioItem
                  closeOnClick
                  key={format}
                  value={format}
                  disabled={pending}
                  onClick={() => {
                    detach(
                      onChange({ ...capture, format }),
                      Reason.DomCallback,
                    );
                  }}
                >
                  <span className="flex-1">
                    {format === "webp"
                      ? t(($) => {
                          return $.browserViewer.formatWebp;
                        })
                      : format === "jpeg"
                        ? t(($) => {
                            return $.browserViewer.formatJpeg;
                          })
                        : t(($) => {
                            return $.browserViewer.formatPng;
                          })}
                  </span>
                  {(capture.format ?? "webp") === format && <Check size={14} />}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <label className="flex items-center justify-between gap-3 px-2 py-1 text-sm">
        {qualityLabel}
        <Input
          type="number"
          aria-label={qualityLabel}
          min={0}
          max={100}
          value={capture.quality ?? 70}
          disabled={pending || capture.format === "png"}
          className="h-8 w-20"
          onChange={(event) => {
            const quality = event.currentTarget.valueAsNumber;
            if (Number.isInteger(quality) && quality >= 0 && quality <= 100) {
              detach(onChange({ ...capture, quality }), Reason.DomCallback);
            }
          }}
        />
      </label>
    </>
  );
}

function ResolutionSettingsMenu({
  signals,
  pending,
  onChange,
}: {
  readonly signals: BrowserSignals;
  readonly pending: boolean;
  readonly onChange: (value: ViewerCaptureOptions) => Promise<void>;
}) {
  const { t } = useTranslation();
  const capture = useGet(signals.capture$);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {t(($) => {
          return $.browserViewer.resolution;
        })}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuItem
          disabled={pending}
          onClick={() => {
            detach(
              onChange({
                format: capture.format ?? "webp",
                quality: capture.quality ?? 70,
              }),
              Reason.DomCallback,
            );
          }}
        >
          {t(($) => {
            return $.browserViewer.automatic;
          })}
        </DropdownMenuItem>
        {captureResolutions.map(({ width: maxWidth, height: maxHeight }) => {
          return (
            <DropdownMenuItem
              key={maxWidth}
              disabled={pending}
              onClick={() => {
                detach(
                  onChange({ ...capture, maxWidth, maxHeight }),
                  Reason.DomCallback,
                );
              }}
            >
              {maxWidth} × {maxHeight}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function WindowSettingsMenu({
  signals,
  pending,
  syncing,
  onChange,
  onSync,
}: {
  readonly signals: BrowserSignals;
  readonly pending: boolean;
  readonly syncing: boolean;
  readonly onChange: (value: WindowSizeSync) => Promise<DisplayModeResult>;
  readonly onSync: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const mode = useGet(signals.windowSizeSync$);
  const controls = useGet(signals.controls$);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {t(($) => {
          return $.browserViewer.windowSize;
        })}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={mode}>
          {(["off", "initial", "live"] as const).map((value) => {
            return (
              <DropdownMenuRadioItem
                closeOnClick
                key={value}
                value={value}
                disabled={pending || syncing}
                onClick={() => {
                  detach(onChange(value), Reason.DomCallback);
                }}
              >
                <span className="flex-1">
                  {value === "off"
                    ? t(($) => {
                        return $.browserViewer.sizeOff;
                      })
                    : value === "initial"
                      ? t(($) => {
                          return $.browserViewer.sizeInitial;
                        })
                      : t(($) => {
                          return $.browserViewer.sizeLive;
                        })}
                </span>
                {value === mode && <Check size={14} />}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <DropdownMenuItem
          disabled={!controls.canSyncDisplay || pending || syncing}
          onClick={() => {
            detach(onSync(), Reason.DomCallback);
          }}
        >
          <Maximize2 size={14} />
          {t(($) => {
            return $.browserViewer.syncSize;
          })}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function TransportSettingsMenu({
  signals,
  pending,
  onChange,
}: {
  readonly signals: BrowserSignals;
  readonly pending: boolean;
  readonly onChange: (value: ViewerTransport) => Promise<void>;
}) {
  const { t } = useTranslation();
  const transport = useGet(signals.transport$);
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        {t(($) => {
          return $.browserViewer.transport;
        })}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={transport}>
          {(["shared", "split"] as const).map((value) => {
            return (
              <DropdownMenuRadioItem
                closeOnClick
                key={value}
                value={value}
                disabled={pending}
                onClick={() => {
                  detach(onChange(value), Reason.DomCallback);
                }}
              >
                <span className="flex-1">
                  {value === "shared"
                    ? t(($) => {
                        return $.browserViewer.sharedTransport;
                      })
                    : t(($) => {
                        return $.browserViewer.splitTransport;
                      })}
                </span>
                {value === transport && <Check size={14} />}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function BrowserNavigation({ signals }: { readonly signals: BrowserSignals }) {
  const { t } = useTranslation();
  const history = useLoadable(signals.history$);
  const scope = useGet(signals.navigationScope$);
  const address = useGet(signals.address$);
  const controls = useGet(signals.controls$);
  const pageSignal = useGet(pageSignal$);
  const addressRef = useSet(signals.refs.address$);
  const focus = useSet(signals.focusAddress$);
  const edit = useSet(signals.editAddress$);
  const blur = useSet(signals.blurAddress$);
  const reset = useSet(signals.resetAddress$);
  const [operation, navigate] = useLoadableSet(signals.navigate$);
  const navigating = operation.state === "loading";
  const entries = history.state === "hasData" ? history.data : null;
  const failed =
    (history.state === "hasError" &&
      isBrowserOperationFailure(history.error)) ||
    (operation.state === "hasError" &&
      isBrowserOperationFailure(operation.error) &&
      (!(operation.error instanceof NavigationFault) ||
        operation.error.scope === scope));
  return (
    <div className="relative flex shrink-0 items-center gap-1 border-b border-divider px-2 py-1.5">
      <IconButton
        type="button"
        className="size-8"
        aria-label={t(($) => {
          return $.browserViewer.back;
        })}
        disabled={!controls.streaming || !entries?.canGoBack || navigating}
        onClick={() => {
          detach(navigate("back", pageSignal), Reason.DomCallback);
        }}
      >
        <ArrowLeft size={16} />
      </IconButton>
      <IconButton
        type="button"
        className="size-8"
        aria-label={t(($) => {
          return $.browserViewer.forward;
        })}
        disabled={!controls.streaming || !entries?.canGoForward || navigating}
        onClick={() => {
          detach(navigate("forward", pageSignal), Reason.DomCallback);
        }}
      >
        <ArrowRight size={16} />
      </IconButton>
      <IconButton
        type="button"
        className="size-8"
        aria-label={t(($) => {
          return $.browserViewer.reload;
        })}
        disabled={!controls.streaming || navigating}
        onClick={() => {
          detach(navigate("reload", pageSignal), Reason.DomCallback);
        }}
      >
        <RotateCw size={15} />
      </IconButton>
      <Input
        ref={addressRef}
        data-browser-address
        aria-label={t(($) => {
          return $.browserViewer.address;
        })}
        placeholder={t(($) => {
          return $.browserSession.addressPlaceholder;
        })}
        className="h-8 min-w-0 flex-1"
        value={address}
        disabled={!controls.streaming || navigating}
        aria-busy={navigating}
        onFocus={() => {
          return focus();
        }}
        onBlur={() => {
          return blur();
        }}
        onChange={(event) => {
          return edit(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (
            event.nativeEvent.isComposing ||
            event.nativeEvent.keyCode === 229
          ) {
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            if (!navigating) {
              detach(
                navigate("submit-address", pageSignal),
                Reason.DomCallback,
              );
            }
          } else if (event.key === "Escape") {
            event.preventDefault();
            reset();
            event.currentTarget.select();
          }
        }}
      />
      <BrowserSettings signals={signals} />
      {/* Overlays keep the canvas box stable; layout changes are commanded. */}
      <BrowserOperationError
        failed={failed}
        className="absolute inset-x-2 top-full z-20 mt-1 rounded-lg border border-surface-border bg-popover p-3 text-sm shadow-md"
      />
    </div>
  );
}

function BrowserTab({
  signals,
  target,
  name,
  width,
  selecting,
}: {
  readonly signals: BrowserSignals;
  readonly target: {
    readonly id: string;
    readonly title: string;
    readonly faviconUrl?: string;
  };
  readonly name: string;
  readonly width: number;
  readonly selecting: boolean;
}) {
  const { t } = useTranslation();
  const controls = useGet(signals.controls$);
  const pageSignal = useGet(pageSignal$);
  const [closeOperation, closeTab] = useLoadableSet(signals.closeTab$);
  const rejectFavicon = useSet(signals.rejectFavicon$);
  const closing = closeOperation.state === "loading";
  return (
    <div
      style={{ width }}
      className="group relative h-9 min-w-0 max-w-56 flex-none"
    >
      <TabsTrigger
        value={target.id}
        aria-label={name}
        disabled={controls.tabsDisabled || selecting || closing}
        className="w-full justify-start rounded-lg px-2 pr-7 text-xs data-active:bg-state-selected data-active:shadow-none"
      >
        {target.faviconUrl ? (
          <img
            src={target.faviconUrl}
            alt=""
            className="size-3.5 shrink-0"
            onError={() => {
              if (target.faviconUrl) {
                rejectFavicon(target.id, target.faviconUrl);
              }
            }}
          />
        ) : (
          <Globe size={14} className="shrink-0" />
        )}
        <span className="truncate">{name}</span>
      </TabsTrigger>
      <IconButton
        type="button"
        data-close-target={target.id}
        aria-label={t(
          ($) => {
            return $.browserViewer.closeTab;
          },
          { title: name },
        )}
        disabled={!controls.canMutateTabs || closing || selecting}
        className="absolute right-0.5 top-1.5 size-6 rounded-md opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          detach(closeTab(target.id, pageSignal), Reason.DomCallback);
        }}
      >
        <X size={12} />
      </IconButton>
      <BrowserOperationError
        failed={
          closeOperation.state === "hasError" &&
          isBrowserOperationFailure(closeOperation.error)
        }
        className="absolute left-0 top-full z-20 w-56 rounded-lg border border-divider bg-popover p-3 text-sm shadow-md"
      />
    </div>
  );
}

function BrowserTabs({
  signals,
  actions,
  selecting,
  creating,
  onSelect,
  onCreate,
}: {
  readonly signals: BrowserSignals;
  readonly actions: ReactNode;
  readonly selecting: boolean;
  readonly creating: boolean;
  readonly onSelect: (tabId: string) => Promise<void>;
  readonly onCreate: () => Promise<string>;
}) {
  const { t } = useTranslation();
  const tabs = useGet(signals.tabs$);
  const selectedTabId = useGet(signals.selectedTabId$);
  const navigation = useGet(signals.navigation$);
  const layout = useGet(signals.tabLayout$);
  const controls = useGet(signals.controls$);
  const toolbarRef = useSet(signals.refs.toolbar$);
  const tabsRef = useSet(signals.refs.tabs$);
  const title = (id: string, value: string) => {
    return (selectedTabId === id && navigation?.url === "about:blank") ||
      value === "about:blank"
      ? t(($) => {
          return $.browserSession.blankTabTitle;
        })
      : value ||
          t(($) => {
            return $.browserViewer.untitledTab;
          });
  };
  return (
    <div
      ref={toolbarRef}
      data-browser-toolbar
      className="flex min-w-0 shrink-0 items-center gap-1 border-b border-divider px-2 py-1"
    >
      <TabsList
        ref={tabsRef}
        className="h-9 min-w-0 flex-1 justify-start gap-1 rounded-none bg-transparent p-0"
      >
        {layout.items.map(({ target, width }) => {
          const name = title(target.id, target.title);
          return (
            <BrowserTab
              key={target.id}
              signals={signals}
              target={
                tabs.find((tab) => {
                  return tab.id === target.id;
                }) ?? target
              }
              name={name}
              width={width}
              selecting={selecting}
            />
          );
        })}
      </TabsList>
      {layout.overflow && (
        <DropdownMenu>
          <DropdownMenuTrigger
            data-browser-tab-picker
            render={
              <IconButton
                type="button"
                aria-label={t(($) => {
                  return $.browserViewer.allTabs;
                })}
                className="size-8"
              />
            }
          >
            <ChevronDown size={15} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {tabs.map((target) => {
              return (
                <DropdownMenuItem
                  key={target.id}
                  disabled={controls.tabsDisabled || selecting}
                  onClick={() => {
                    detach(onSelect(target.id), Reason.DomCallback);
                  }}
                >
                  <span className="max-w-60 flex-1 truncate">
                    {title(target.id, target.title)}
                  </span>
                  {selectedTabId === target.id && <Check size={14} />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <IconButton
        data-browser-new-tab
        type="button"
        aria-label={t(($) => {
          return $.browserViewer.newTab;
        })}
        disabled={!controls.canCreate || creating}
        className="size-8"
        onClick={() => {
          detach(onCreate(), Reason.DomCallback);
        }}
      >
        <Plus size={16} />
      </IconButton>
      {actions}
    </div>
  );
}

function BrowserStatus({
  signals,
  creating,
  onCreate,
}: {
  readonly signals: BrowserSignals;
  readonly creating: boolean;
  readonly onCreate: () => Promise<string>;
}) {
  const { t } = useTranslation();
  const controls = useGet(signals.controls$);
  const presentation = useGet(signals.presentation$);
  const displayRecovery = useGet(signals.displayRecovery$);
  const imageRecovery = useGet(signals.imageRecovery$);
  const pageSignal = useGet(pageSignal$);
  const [retryOperation, retryImage] = useLoadableSet(signals.retryImage$);
  const [reconnectOperation, reconnect] = useLoadableSet(signals.reconnect$);
  const pending =
    retryOperation.state === "loading" ||
    reconnectOperation.state === "loading";
  const failed =
    displayRecovery !== null ||
    (retryOperation.state === "hasError" &&
      isBrowserOperationFailure(retryOperation.error)) ||
    (reconnectOperation.state === "hasError" &&
      isBrowserOperationFailure(
        reconnectOperation.error,
        imageRecovery !== null || controls.streaming,
      ));
  if (controls.streaming || presentation.loadingPreview) {
    return (
      <BrowserOperationError
        failed={failed}
        className="absolute inset-x-3 top-3 z-10 rounded-lg border border-divider bg-popover p-3 text-sm shadow-md"
      />
    );
  }
  const text =
    presentation.status === "connecting"
      ? t(($) => {
          return $.browserViewer.connecting;
        })
      : presentation.status === "paused"
        ? t(($) => {
            return $.browserViewer.paused;
          })
        : controls.emptyScoped || controls.emptyUnscoped
          ? t(($) => {
              return $.browserViewer.noTabs;
            })
          : presentation.status === "disconnected"
            ? t(($) => {
                return $.browserViewer.disconnected;
              })
            : t(($) => {
                return $.browserViewer.unavailable;
              });
  return (
    <div
      role="status"
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-5 text-center text-sm text-muted-foreground"
    >
      {presentation.status === "connecting" && (
        <Loader2 size={20} className="animate-spin" />
      )}
      <p>{text}</p>
      {controls.showImageRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!controls.canRetryImage || pending}
          onClick={() => {
            detach(retryImage(pageSignal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.browserViewer.retryImage;
          })}
        </Button>
      ) : (
        controls.showRecovery && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => {
              detach(reconnect(pageSignal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.browserViewer.reconnect;
            })}
          </Button>
        )
      )}
      {controls.showEmptyCreate && (
        <Button
          type="button"
          size="sm"
          disabled={!controls.canCreate || creating}
          onClick={() => {
            detach(onCreate(), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.browserViewer.newTab;
          })}
        </Button>
      )}
      <BrowserOperationError failed={failed} className="text-sm" />
    </div>
  );
}

function BrowserClipboard({ signals }: { readonly signals: BrowserSignals }) {
  const { t } = useTranslation();
  const clipboard = useGet(signals.clipboardRecovery$);
  const pageSignal = useGet(pageSignal$);
  const [copyOperation, copyClipboard] = useLoadableSet(signals.copyClipboard$);
  const dismiss = useSet(signals.dismissClipboardRecovery$);
  if (!clipboard) {
    return null;
  }
  return (
    <div
      role="status"
      className="absolute inset-x-3 bottom-3 z-10 flex flex-col gap-2 rounded-lg border border-divider bg-popover p-3 text-sm shadow-md"
    >
      <p>
        {clipboard.text
          ? t(($) => {
              return $.browserViewer.copyRecovery;
            })
          : t(($) => {
              return $.browserViewer.copyUnavailable;
            })}
      </p>
      {clipboard.text !== null && (
        <Textarea
          data-browser-clipboard
          aria-label={t(($) => {
            return $.browserViewer.copiedText;
          })}
          value={clipboard.text}
          readOnly
          onFocus={(event) => {
            return event.currentTarget.select();
          }}
        />
      )}
      <BrowserOperationError
        failed={
          copyOperation.state === "hasError" &&
          isBrowserOperationFailure(copyOperation.error)
        }
        className="text-sm"
      />
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            return dismiss();
          }}
        >
          {t(($) => {
            return $.browserViewer.dismiss;
          })}
        </Button>
        {clipboard.text !== null && (
          <Button
            type="button"
            size="sm"
            disabled={copyOperation.state === "loading"}
            onClick={() => {
              detach(copyClipboard(pageSignal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return $.browserViewer.copyText;
            })}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Product presentation and state belong to Platform; each graph owns its mounted browser. */
export function Browser({
  signals,
  actions,
  presence,
}: {
  readonly signals: BrowserSignals;
  readonly actions: ReactNode;
  readonly presence: ReactNode;
}) {
  const { t } = useTranslation();
  const selectedTabId = useGet(signals.selectedTabId$);
  const navigation = useGet(signals.navigation$);
  const controls = useGet(signals.controls$);
  const pageSignal = useGet(pageSignal$);
  const imageRecovery = useGet(signals.imageRecovery$);
  const rootRef = useSet(signals.refs.root$);
  const surfaceRef = useSet(signals.refs.surface$);
  const canvasRef = useSet(signals.refs.canvas$);
  const inputRef = useSet(signals.refs.input$);
  const [selectOperation, selectTab] = useLoadableSet(signals.selectTab$);
  // Both New tab entry points share one request owner to prevent duplicate creation.
  const [createOperation, createTab] = useLoadableSet(signals.createTab$);
  return (
    <Tabs
      render={<section />}
      ref={rootRef}
      value={selectedTabId}
      onValueChange={(value) => {
        if (typeof value === "string" && selectOperation.state !== "loading") {
          detach(selectTab(value, pageSignal), Reason.DomCallback);
        }
      }}
      data-browser-viewer
      className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background text-foreground"
      aria-label={t(($) => {
        return $.browserViewer.browser;
      })}
    >
      <BrowserTabs
        signals={signals}
        actions={actions}
        selecting={selectOperation.state === "loading"}
        creating={createOperation.state === "loading"}
        onSelect={(tabId) => {
          return selectTab(tabId, pageSignal);
        }}
        onCreate={() => {
          return createTab(pageSignal);
        }}
      />
      <BrowserNavigation signals={signals} />
      <TabsContent
        keepMounted
        value={selectedTabId}
        tabIndex={-1}
        className="relative min-h-0 flex-1"
      >
        <BrowserOperationError
          failed={[selectOperation, createOperation].some((operation) => {
            return (
              operation.state === "hasError" &&
              isBrowserOperationFailure(
                operation.error,
                imageRecovery !== null || controls.streaming,
              )
            );
          })}
          className="absolute inset-x-3 top-3 z-20 rounded-lg border border-surface-border bg-popover p-3 text-sm shadow-md"
        />
        <div
          ref={surfaceRef}
          data-browser-surface
          className="relative h-full w-full overflow-hidden"
        >
          <canvas
            ref={canvasRef}
            data-browser-canvas
            role="img"
            aria-label={t(($) => {
              return $.browserViewer.liveView;
            })}
            aria-hidden={!controls.streaming}
            className="block h-full w-full object-contain"
          />
          <Textarea
            ref={inputRef}
            data-browser-input
            aria-label={t(($) => {
              return $.browserViewer.remoteInput;
            })}
            disabled={!controls.streaming}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            rows={1}
            wrap="off"
            className="pointer-events-none absolute left-0 top-0 h-px min-h-0 w-px resize-none overflow-hidden rounded-none border-0 p-0 opacity-0 shadow-none"
          />
        </div>
        <BrowserStatus
          signals={signals}
          creating={createOperation.state === "loading"}
          onCreate={() => {
            return createTab(pageSignal);
          }}
        />
        {controls.streaming && navigation?.url === "about:blank" && (
          <div className="absolute inset-0 bg-background">
            <BrowserBlankPage />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 z-10">
          {presence}
        </div>
        <BrowserClipboard signals={signals} />
      </TabsContent>
    </Tabs>
  );
}

function BrowserBlankPage() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 pb-10 text-center">
      <Globe size={20} aria-hidden className="text-muted-foreground" />
      <p className="mt-3 text-sm font-medium text-foreground">
        {t(($) => {
          return $.browserSession.blankPage.title;
        })}
      </p>
      <p className="mt-1 max-w-72 text-xs leading-5 text-muted-foreground">
        {t(($) => {
          return $.browserSession.blankPage.description;
        })}
      </p>
    </div>
  );
}
