import type { ReactNode } from "react";
import { ErrorBoundary } from "../error-boundary.tsx";
import { useGet, useSet } from "ccstate-react";
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
import type { BrowserViewerSignals } from "../../signals/browser-viewer/browser-viewer.ts";
import { captureResolutions } from "../../signals/browser-viewer/viewer/capture.ts";

function BrowserSettings({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();
  return (
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
        <CaptureSettingsMenu signals={signals} />
        <ResolutionSettingsMenu signals={signals} />
        <WindowSettingsMenu signals={signals} />
        <TransportSettingsMenu signals={signals} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CaptureSettingsMenu({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();
  const capture = useGet(signals.capture$);

  const setCapture = useSet(signals.chooseCapture$);

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
                  onClick={() => {
                    return setCapture({ ...capture, format });
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
          disabled={capture.format === "png"}
          className="h-8 w-20"
          onChange={(event) => {
            const quality = event.currentTarget.valueAsNumber;
            if (Number.isInteger(quality) && quality >= 0 && quality <= 100) {
              setCapture({ ...capture, quality });
            }
          }}
        />
      </label>
    </>
  );
}
function ResolutionSettingsMenu({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();
  const capture = useGet(signals.capture$);

  const setCapture = useSet(signals.chooseCapture$);

  return (
    <>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          {t(($) => {
            return $.browserViewer.resolution;
          })}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem
            onClick={() => {
              return setCapture({
                format: capture.format ?? "webp",
                quality: capture.quality ?? 70,
              });
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
                onClick={() => {
                  return setCapture({ ...capture, maxWidth, maxHeight });
                }}
              >
                {maxWidth} × {maxHeight}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
function WindowSettingsMenu({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();

  const mode = useGet(signals.windowSizeSync$);

  const controls = useGet(signals.controls$);

  const setMode = useSet(signals.chooseWindowSizeSync$);

  const sync = useSet(signals.syncDisplay$);

  return (
    <>
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
                  onClick={() => {
                    return setMode(value);
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
            disabled={!controls.canSyncDisplay}
            onClick={() => {
              return sync();
            }}
          >
            <Maximize2 size={14} />
            {t(($) => {
              return $.browserViewer.syncSize;
            })}
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  );
}
function TransportSettingsMenu({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();

  const transport = useGet(signals.transport$);

  const setTransport = useSet(signals.chooseTransport$);

  return (
    <>
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
                  onClick={() => {
                    return setTransport(value);
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
    </>
  );
}

function BrowserNavigation({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();
  const snapshot = useGet(signals.snapshot$);
  const address = useGet(signals.address$);
  const controls = useGet(signals.controls$);
  const navigate = useSet(signals.navigate$);
  const focus = useSet(signals.focusAddress$);
  const edit = useSet(signals.editAddress$);
  const blur = useSet(signals.blurAddress$);
  const reset = useSet(signals.resetAddress$);
  const submit = useSet(signals.submitAddress$);
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-divider px-2 py-1.5">
      <IconButton
        type="button"
        className="size-8"
        aria-label={t(($) => {
          return $.browserViewer.back;
        })}
        disabled={!controls.streaming || !snapshot.navigation?.canGoBack}
        onClick={() => {
          return navigate("back");
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
        disabled={!controls.streaming || !snapshot.navigation?.canGoForward}
        onClick={() => {
          return navigate("forward");
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
        disabled={!controls.streaming}
        onClick={() => {
          return navigate("reload");
        }}
      >
        <RotateCw size={15} />
      </IconButton>
      <Input
        data-browser-address
        aria-label={t(($) => {
          return $.browserViewer.address;
        })}
        placeholder={t(($) => {
          return $.browserSession.addressPlaceholder;
        })}
        className="h-8 min-w-0 flex-1"
        value={address}
        disabled={!controls.streaming}
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
          if (event.nativeEvent.isComposing || event.keyCode === 229) {
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            reset();
            event.currentTarget.select();
          }
        }}
      />
      <BrowserSettings signals={signals} />
    </div>
  );
}

function BrowserTab({
  signals,
  target,
  name,
  width,
}: {
  readonly signals: BrowserViewerSignals;
  readonly target: { readonly id: string; readonly title: string };
  readonly name: string;
  readonly width: number;
}) {
  const { t } = useTranslation();
  const controls = useGet(signals.controls$);
  const icon = useGet(signals.favicons$).get(target.id);
  const close = useSet(signals.closeTab$);
  const rejectIcon = useSet(signals.rejectFavicon$);
  return (
    <div
      style={{ width }}
      className="group relative h-9 min-w-0 max-w-56 flex-none"
    >
      <TabsTrigger
        value={target.id}
        aria-label={name}
        disabled={controls.tabsDisabled}
        className="w-full justify-start rounded-lg px-2 pr-7 text-xs data-active:bg-state-selected data-active:shadow-none"
      >
        {icon && !icon.failed ? (
          <img
            src={icon.url}
            alt=""
            className="size-3.5 shrink-0"
            onError={() => {
              return rejectIcon({ targetId: target.id, icon });
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
        disabled={!controls.canMutateTabs}
        className="absolute right-0.5 top-1.5 size-6 rounded-md opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        onClick={(event) => {
          event.stopPropagation();
          close(target.id);
        }}
      >
        <X size={12} />
      </IconButton>
    </div>
  );
}

function BrowserTabs({
  signals,
  actions,
}: {
  readonly signals: BrowserViewerSignals;
  readonly actions: ReactNode;
}) {
  const { t } = useTranslation();
  const snapshot = useGet(signals.snapshot$);
  const layout = useGet(signals.tabLayout$);
  const controls = useGet(signals.controls$);

  const create = useSet(signals.createTab$);
  const select = useSet(signals.select$);

  const title = (id: string, value: string) => {
    return (snapshot.selectedTargetId === id &&
      snapshot.navigation?.url === "about:blank") ||
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
      data-browser-toolbar
      className="flex min-w-0 shrink-0 items-center gap-1 border-b border-divider px-2 py-1"
    >
      <TabsList className="h-9 min-w-0 flex-1 justify-start gap-1 rounded-none bg-transparent p-0">
        {layout.items.map(({ target, width }) => {
          const name = title(target.id, target.title);
          return (
            <BrowserTab
              key={target.id}
              signals={signals}
              target={target}
              name={name}
              width={width}
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
            {snapshot.targets.map((target) => {
              return (
                <DropdownMenuItem
                  key={target.id}
                  onClick={() => {
                    return select(target.id);
                  }}
                >
                  <span className="max-w-60 flex-1 truncate">
                    {title(target.id, target.title)}
                  </span>
                  {snapshot.selectedTargetId === target.id && (
                    <Check size={14} />
                  )}
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
        disabled={!controls.canCreate}
        className="size-8"
        onClick={() => {
          return create();
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
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();
  const controls = useGet(signals.controls$);
  const snapshot = useGet(signals.snapshot$);
  const retry = useSet(signals.retryImage$);
  const reconnect = useSet(signals.reconnect$);
  const create = useSet(signals.createTab$);
  if (controls.streaming || controls.loadingPreview) {
    return null;
  }
  const text =
    snapshot.status === "connecting"
      ? t(($) => {
          return $.browserViewer.connecting;
        })
      : snapshot.status === "paused"
        ? t(($) => {
            return $.browserViewer.paused;
          })
        : controls.emptyScoped || controls.emptyUnscoped
          ? t(($) => {
              return $.browserViewer.noTabs;
            })
          : snapshot.status === "disconnected"
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
      {snapshot.status === "connecting" && (
        <Loader2 size={20} className="animate-spin" />
      )}
      <p>{text}</p>
      {controls.showImageRetry ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!controls.canRetryImage}
          onClick={() => {
            return retry();
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
            onClick={() => {
              return reconnect();
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
          onClick={() => {
            return create();
          }}
        >
          {t(($) => {
            return $.browserViewer.newTab;
          })}
        </Button>
      )}
    </div>
  );
}

function BrowserClipboard({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();
  const clipboard = useGet(signals.clipboard$);
  const copy = useSet(signals.copyClipboard$);
  const dismiss = useSet(signals.dismissClipboard$);
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
            onClick={() => {
              return copy();
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

function BrowserNotification({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();
  const notification = useGet(signals.notification$);
  const dismiss = useSet(signals.dismissNotification$);
  if (!notification) {
    return null;
  }
  return (
    <div
      role="alert"
      className="absolute inset-x-3 top-3 z-10 flex items-start gap-2 rounded-lg border border-divider bg-popover p-3 text-sm shadow-md"
    >
      <p className="flex-1">
        {t(($) => {
          return $.browserViewer.operationFailed;
        })}
      </p>
      <IconButton
        type="button"
        className="size-7 shrink-0"
        aria-label={t(($) => {
          return $.browserViewer.dismiss;
        })}
        onClick={() => {
          dismiss();
        }}
      >
        <X size={14} />
      </IconButton>
    </div>
  );
}

interface BrowserViewerProps {
  readonly signals: BrowserViewerSignals;
  readonly connectionKey: string;
  readonly actions: ReactNode;
  readonly presence: ReactNode;
}

/** DOM acquisition failures belong to this surface's React boundary. */
export function BrowserViewer(props: BrowserViewerProps) {
  const revision = useGet(props.signals.revision$);
  return (
    <ErrorBoundary
      key={props.connectionKey + ":" + revision}
      fallback={<BrowserInitializationFailure signals={props.signals} />}
    >
      <BrowserSurface {...props} />
    </ErrorBoundary>
  );
}

function BrowserInitializationFailure({
  signals,
}: {
  readonly signals: BrowserViewerSignals;
}) {
  const { t } = useTranslation();
  const reconnect = useSet(signals.reconnect$);
  return (
    <div
      role="alert"
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-background px-5 text-center text-sm text-muted-foreground"
    >
      <p>
        {t(($) => {
          return $.browserViewer.unavailable;
        })}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          reconnect();
        }}
      >
        {t(($) => {
          return $.browserViewer.reconnect;
        })}
      </Button>
    </div>
  );
}

function BrowserSurface({ signals, actions, presence }: BrowserViewerProps) {
  const { t } = useTranslation();
  const snapshot = useGet(signals.snapshot$);
  const controls = useGet(signals.controls$);
  const mount = useSet(signals.mount$);
  const select = useSet(signals.select$);
  return (
    <Tabs
      render={<section />}
      ref={mount}
      value={snapshot.selectedTargetId}
      onValueChange={(value) => {
        if (typeof value === "string") {
          select(value);
        }
      }}
      data-browser-viewer
      className="relative isolate flex min-h-0 w-full flex-1 flex-col overflow-hidden bg-background text-foreground"
      aria-label={t(($) => {
        return $.browserViewer.browser;
      })}
    >
      <BrowserTabs signals={signals} actions={actions} />
      <BrowserNavigation signals={signals} />
      <TabsContent
        keepMounted
        value={snapshot.selectedTargetId}
        tabIndex={-1}
        className="relative min-h-0 flex-1"
      >
        <div
          data-browser-surface
          className="relative h-full w-full overflow-hidden"
        >
          <canvas
            data-browser-canvas
            role="img"
            aria-label={t(($) => {
              return $.browserViewer.liveView;
            })}
            aria-hidden={!controls.streaming}
            className="block h-full w-full object-contain"
          />
          <Textarea
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
        <BrowserStatus signals={signals} />
        {controls.streaming && snapshot.navigation?.url === "about:blank" && (
          <div className="absolute inset-0 bg-background">
            <BrowserBlankPage />
          </div>
        )}
        <div className="pointer-events-none absolute inset-0 z-10">
          {presence}
        </div>
        <BrowserNotification signals={signals} />
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
