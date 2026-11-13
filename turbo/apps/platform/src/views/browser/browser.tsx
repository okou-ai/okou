import type { ReactNode } from "react";
import { Field } from "@base-ui/react/field";
import { flushSync } from "react-dom";
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
  Search,
  Settings,
  X,
} from "lucide-react";
import {
  Button,
  cn,
  IconButton,
  Input,
  Slider,
  LayoutCommit,
  RequestCommit,
  Textarea,
  TransientAlert,
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
import {
  isBrowserOperationFailure,
  type BrowserFocusHandoff,
  type BrowserSignals,
} from "../../signals/browser/browser.ts";
import { NavigationFault } from "../../signals/browser/navigation/action.ts";
import { SearchUnavailableFault } from "../../signals/browser/navigation/search.ts";
import type { DisplayModeResult } from "../../signals/browser/display/sync.ts";
import { captureResolutions } from "../../signals/browser/viewer/capture.ts";
import { captureQualityPresets } from "../../signals/browser/capture-quality.ts";
import type {
  ViewerCaptureOptions,
  ViewerTransport,
  WindowSizeSync,
} from "../../signals/browser/viewer/types.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { Reason } from "../../signals/utils.ts";
import { detachBrowser as detach } from "../../signals/browser/reporting.ts";
import {
  BrowserFrameRate,
  BrowserFrameRateMenu,
} from "./browser-frame-rate.tsx";

function BrowserOperationError({
  occurrences,
  duplicateMessage,
  message: suppliedMessage,
  className = "border-b border-divider px-3 py-2 text-sm text-muted-foreground",
}: {
  readonly occurrences: readonly (object | false | null)[];
  readonly duplicateMessage?: string;
  readonly message?: string;
  readonly className?: string;
}) {
  const { t } = useTranslation();
  const message =
    suppliedMessage ??
    t(($) => {
      return $.browserViewer.operationFailed;
    });
  return (
    <TransientAlert
      occurrences={occurrences.filter((occurrence): occurrence is object => {
        return Boolean(occurrence);
      })}
      hidden={message === duplicateMessage}
      className={className}
    >
      {message}
    </TransientAlert>
  );
}

function BrowserSettings({
  signals,
  disabled,
}: {
  readonly signals: BrowserSignals;
  readonly disabled: boolean;
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  // Keep the request owner mounted when the menu closes.
  const [captureOperation, changeCapture] = useLoadableSet(
    signals.changeCapture$,
  );
  const qualityOperation = useLoadable(signals.quality.operation$);
  const applyQuality = useSet(signals.quality.apply$);
  const closeQuality = useSet(signals.quality.close$);
  const [transportOperation, changeTransport] = useLoadableSet(
    signals.changeTransport$,
  );
  const [windowOperation, changeWindowSizeSync] = useLoadableSet(
    signals.changeWindowSizeSync$,
  );
  const [syncOperation, syncDisplay] = useLoadableSet(signals.syncDisplay$);
  // Transport replacement uses the root recovery pipeline and its current error.
  const capturePending =
    captureOperation.state === "loading" ||
    qualityOperation.state === "loading";
  const failures = [
    captureOperation,
    qualityOperation,
    windowOperation,
    syncOperation,
  ].filter((operation) => {
    return (
      operation.state === "hasError" &&
      isBrowserOperationFailure(operation.error)
    );
  });
  return (
    <>
      <DropdownMenu
        onOpenChange={(open, details) => {
          if (!open) {
            detach(
              closeQuality(details.reason === "escape-key", pageSignal),
              Reason.DomCallback,
            );
          }
        }}
      >
        <DropdownMenuTrigger
          render={
            <IconButton
              type="button"
              disabled={disabled}
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
            pending={capturePending}
            onChange={(value) => {
              return changeCapture(value, pageSignal);
            }}
            onApplyQuality={(value) => {
              return applyQuality(value, pageSignal);
            }}
            onCloseQuality={(cancel) => {
              return closeQuality(cancel, pageSignal);
            }}
          />
          <ResolutionSettingsMenu
            signals={signals}
            pending={capturePending}
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
          <BrowserFrameRateMenu signals={signals.frameRate} />
        </DropdownMenuContent>
      </DropdownMenu>
      <BrowserOperationError
        occurrences={failures}
        className="absolute right-2 top-full z-20 max-w-64 rounded-lg border border-divider bg-popover p-3 text-sm shadow-md"
      />
    </>
  );
}

function CaptureSettingsMenu({
  signals,
  pending,
  onChange,
  onApplyQuality,
  onCloseQuality,
}: {
  readonly signals: BrowserSignals;
  readonly pending: boolean;
  readonly onChange: (value: ViewerCaptureOptions) => Promise<void>;
  readonly onApplyQuality: (value: number | "draft") => Promise<void>;
  readonly onCloseQuality: (cancel: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const capture = useGet(signals.capture$);
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
      <QualitySettingsMenu
        signals={signals}
        pending={pending}
        onApply={onApplyQuality}
        onClose={onCloseQuality}
      />
    </>
  );
}

function QualitySettingsMenu({
  signals,
  pending,
  onApply,
  onClose,
}: {
  readonly signals: BrowserSignals;
  readonly pending: boolean;
  readonly onApply: (value: number | "draft") => Promise<void>;
  readonly onClose: (cancel: boolean) => Promise<void>;
}) {
  const { t } = useTranslation();
  const capture = useGet(signals.capture$);
  const values = useGet(signals.quality.values$);
  const begin = useSet(signals.quality.begin$);
  const reset = useSet(signals.quality.reset$);
  const qualityLabel = t(($) => {
    return $.browserViewer.quality;
  });
  return (
    <DropdownMenuSub
      onOpenChange={(open, details) => {
        if (open) {
          begin();
        } else {
          detach(onClose(details.reason === "escape-key"), Reason.DomCallback);
        }
      }}
    >
      <DropdownMenuSubTrigger disabled={pending || capture.format === "png"}>
        <span className="flex-1">{qualityLabel}</span>
        {capture.format === "png" && (
          <span className="text-muted-foreground">
            {t(($) => {
              return $.browserViewer.qualityLossless;
            })}
          </span>
        )}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent
        side="left"
        className="w-64 max-w-[var(--available-width)]"
        onKeyDown={(event) => {
          if (
            event.target instanceof HTMLInputElement &&
            (event.nativeEvent.isComposing ||
              event.keyCode === 229 ||
              (event.key !== "Escape" && event.key !== "Tab"))
          ) {
            // Text/range controls own editing keys, not menu typeahead/navigation.
            event.preventBaseUIHandler();
          }
        }}
      >
        <DropdownMenuRadioGroup
          value={values.preset}
          className="m-2 flex gap-1 rounded-lg bg-gray-50 p-1"
        >
          {captureQualityPresets.map((quality) => {
            return (
              <DropdownMenuRadioItem
                closeOnClick={false}
                key={quality}
                value={String(quality)}
                disabled={pending}
                className="min-w-0 flex-1 justify-center px-1 text-center text-xs data-checked:bg-card"
                onPointerDown={reset}
                onClick={() => {
                  detach(onApply(quality), Reason.DomCallback);
                }}
              >
                {quality === 40
                  ? t(($) => {
                      return $.browserViewer.qualitySaver;
                    })
                  : quality === 70
                    ? t(($) => {
                        return $.browserViewer.qualityBalanced;
                      })
                    : t(($) => {
                        return $.browserViewer.qualitySharper;
                      })}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
        <QualityControls
          signals={signals}
          pending={pending}
          onApply={onApply}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function QualityControls({
  signals,
  pending,
  onApply,
}: {
  readonly signals: BrowserSignals;
  readonly pending: boolean;
  readonly onApply: (value: number | "draft") => Promise<void>;
}) {
  const { t } = useTranslation();
  const values = useGet(signals.quality.values$);
  const edit = useSet(signals.quality.edit$);
  const reset = useSet(signals.quality.reset$);
  const qualityLabel = t(($) => {
    return $.browserViewer.quality;
  });
  return (
    <Field.Root invalid={values.invalid} className="space-y-2 px-2 pb-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1 space-y-2 pt-2">
          <Slider
            min={0}
            max={100}
            step={1}
            aria-label={qualityLabel}
            value={values.slider}
            aria-busy={pending || undefined}
            onMouseDown={(event) => {
              if (event.button === 0) {
                // Let Base UI focus the range input; a track's native focus
                // would blur the numeric field and commit before release.
                event.preventDefault();
              }
            }}
            onValueChange={(value, details) => {
              if (pending) {
                // Keep keyboard focus while a capture change is still settling.
                details.cancel();
                return;
              }
              edit(String(value));
            }}
            onValueCommitted={() => {
              detach(onApply("draft"), Reason.DomCallback);
            }}
          />
          <Field.Description className="flex justify-between text-xs text-muted-foreground">
            <span>0</span>
            <span>100</span>
          </Field.Description>
        </div>
        <Input
          type="text"
          inputMode="numeric"
          aria-label={qualityLabel}
          value={values.text}
          readOnly={pending}
          aria-busy={pending || undefined}
          className="h-8 w-16 shrink-0 text-center tabular-nums"
          onChange={(event) => {
            edit(event.currentTarget.value);
          }}
          onBlur={(event) => {
            // Moving to the slider replaces the draft at its commit boundary.
            if (
              !(event.relatedTarget instanceof HTMLInputElement) ||
              event.relatedTarget.type !== "range"
            ) {
              detach(onApply("draft"), Reason.DomCallback);
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }
            if (event.key === "Escape") {
              reset();
            } else if (event.key === "Enter") {
              // Apply this field without activating the highlighted menu item.
              event.preventDefault();
              detach(onApply("draft"), Reason.DomCallback);
            }
          }}
        />
      </div>
      <Field.Error
        match={values.invalid}
        role="alert"
        className="text-xs text-destructive"
      >
        {t(($) => {
          return $.browserViewer.qualityInvalid;
        })}
      </Field.Error>
    </Field.Root>
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

interface BrowserNavigationProps {
  readonly signals: BrowserSignals;
  readonly settingsDisabled: boolean;
}

function isCurrentNavigationFailure(error: unknown, scope: object | null) {
  return (
    isBrowserOperationFailure(error) &&
    (!(error instanceof NavigationFault) || error.scope === scope)
  );
}

function BrowserAddressInput({
  signals,
  navigating,
}: {
  readonly signals: BrowserSignals;
  readonly navigating: boolean;
}) {
  const { t } = useTranslation();
  const address = useGet(signals.address$);
  const addressRef = useSet(signals.refs.address$);
  const beginEdit = useSet(signals.beginAddressEdit$);
  const blur = useSet(signals.blurAddress$);
  const edit = useSet(signals.editAddress$);
  const reset = useSet(signals.resetAddress$);
  const notifySubmission = useSet(signals.notifyAddressSubmit$);
  const searchEnabled = useGet(signals.addressSearchEnabled$);
  const kind = useGet(signals.addressSubmissionKind$);
  const compose = useSet(signals.composeAddress$);
  return (
    <Input
      ref={addressRef}
      data-browser-address
      aria-label={t(($) => {
        return $.browserViewer.address;
      })}
      placeholder={t(($) => {
        return searchEnabled
          ? $.browserViewer.addressSearchPlaceholder
          : $.browserSession.addressPlaceholder;
      })}
      className="h-8 min-w-0 flex-1"
      value={address}
      inputMode={searchEnabled ? "text" : "url"}
      enterKeyHint={kind === "search" ? "search" : "go"}
      autoComplete="off"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      aria-busy={navigating}
      onFocus={() => {
        beginEdit("focus");
      }}
      onPointerDown={() => {
        beginEdit("interaction");
      }}
      onBeforeInput={() => {
        beginEdit("interaction");
      }}
      onCompositionStart={() => {
        compose(true);
        beginEdit("interaction");
      }}
      onCompositionEnd={() => {
        compose(false);
      }}
      onBlur={() => {
        compose(false);
        blur();
      }}
      onChange={(event) => {
        notifySubmission(null);
        edit(event.currentTarget.value);
      }}
      onKeyDown={(event) => {
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229
        ) {
          if (event.key === "Enter") {
            event.preventDefault();
          }
          beginEdit("interaction");
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          // Select the reset value after React commits the controlled input.
          flushSync(() => {
            reset();
            beginEdit("interaction");
          });
          event.currentTarget.select();
        } else if (event.key !== "Enter") {
          beginEdit("interaction");
        }
      }}
    />
  );
}

function BrowserAddress({
  signals,
  canSubmit,
  navigating,
  onSubmit,
}: {
  readonly signals: BrowserSignals;
  readonly canSubmit: boolean;
  readonly navigating: boolean;
  readonly onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const blockedSubmission = useGet(signals.addressSubmitNotice$);
  const notifySubmission = useSet(signals.notifyAddressSubmit$);
  const searchEnabled = useGet(signals.addressSearchEnabled$);
  const kind = useGet(signals.addressSubmissionKind$);
  const composing = useGet(signals.addressComposing$);
  const label = t(($) => {
    return kind === "search"
      ? $.browserViewer.searchDefaultEngine
      : $.browserViewer.openAddress;
  });
  return (
    <>
      <form
        className="flex min-w-0 flex-1 items-center gap-1"
        onSubmit={(event) => {
          event.preventDefault();
          if (composing) {
            return;
          }
          if (canSubmit && !navigating) {
            notifySubmission(null);
            onSubmit();
          } else {
            notifySubmission(navigating ? "opening" : "preparing");
          }
        }}
      >
        <BrowserAddressInput signals={signals} navigating={navigating} />
        {searchEnabled && (
          <IconButton
            type="submit"
            className="size-8"
            aria-label={label}
            title={label}
            disabled={!canSubmit || navigating || composing || !kind}
          >
            {kind === "search" ? (
              <Search size={16} />
            ) : (
              <ArrowRight size={16} />
            )}
          </IconButton>
        )}
      </form>
      <TransientAlert
        occurrences={
          blockedSubmission && (!canSubmit || navigating)
            ? [blockedSubmission]
            : []
        }
        className="absolute inset-x-2 top-full z-20 mt-1 rounded-lg border border-surface-border bg-popover px-3 py-2 text-xs text-muted-foreground"
      >
        {t(($) => {
          return blockedSubmission?.kind === "opening"
            ? $.browserViewer.addressOpening
            : $.browserViewer.addressPreparing;
        })}
      </TransientAlert>
    </>
  );
}

function BrowserNavigation({
  signals,
  settingsDisabled,
}: BrowserNavigationProps) {
  const { t } = useTranslation();
  const history = useLoadable(signals.history$);
  const scope = useGet(signals.navigationScope$);
  const controls = useGet(signals.controls$);
  const canSubmitAddress = useGet(signals.canSubmitAddress$);
  const pageSignal = useGet(pageSignal$);
  const [operation, navigate] = useLoadableSet(signals.navigate$);
  const navigating = operation.state === "loading";
  const entries = history.state === "hasData" ? history.data : null;
  const failures = [
    history.state === "hasError" &&
      isBrowserOperationFailure(history.error) &&
      history,
    operation.state === "hasError" &&
      isCurrentNavigationFailure(operation.error, scope) &&
      operation,
  ];
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
      <BrowserAddress
        signals={signals}
        canSubmit={canSubmitAddress}
        navigating={navigating}
        onSubmit={() => {
          detach(navigate("submit-address", pageSignal), Reason.DomCallback);
        }}
      />
      <BrowserSettings signals={signals} disabled={settingsDisabled} />
      {/* Overlays keep the canvas box stable; layout changes are commanded. */}
      <BrowserOperationError
        occurrences={failures}
        message={
          operation.state === "hasError" &&
          operation.error instanceof NavigationFault &&
          operation.error.cause instanceof SearchUnavailableFault
            ? t(($) => {
                return $.browserViewer.searchUnavailable;
              })
            : undefined
        }
        className="absolute inset-x-2 top-full z-20 mt-1 rounded-lg border border-surface-border bg-popover p-3 text-sm shadow-md"
      />
    </div>
  );
}

function BrowserTab({
  signals,
  target,
  name,
  selected,
  handoff,
  selecting,
}: {
  readonly signals: BrowserSignals;
  readonly target: {
    readonly id: string;
    readonly title: string;
    readonly faviconUrl?: string;
  };
  readonly name: string;
  readonly selected: boolean;
  readonly handoff: Extract<BrowserFocusHandoff, { kind: "tab" }> | null;
  readonly selecting: boolean;
}) {
  const { t } = useTranslation();
  const controls = useGet(signals.controls$);
  const pageSignal = useGet(pageSignal$);
  const [closeOperation, closeTab] = useLoadableSet(signals.closeTab$);
  const rejectFavicon = useSet(signals.rejectFavicon$);
  const acknowledge = useSet(signals.acknowledgeFocusCommit$);
  const closing = closeOperation.state === "loading";
  const triggerDisabled = controls.tabsDisabled || selecting || closing;
  // Each tab owns its close loadable and therefore its actual enable commit.
  return (
    <RequestCommit
      request={handoff}
      commitKey={JSON.stringify([target.id, selected, triggerDisabled])}
      onCommit={acknowledge}
    >
      <div
        className={cn(
          "group relative h-9 min-w-[32px] max-w-56 flex-1 basis-0",
          selected && "min-w-[48px]",
        )}
      >
        <TabsTrigger
          value={target.id}
          data-browser-tab-id={target.id}
          aria-label={name}
          disabled={triggerDisabled}
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
          occurrences={[
            closeOperation.state === "hasError" &&
              isBrowserOperationFailure(closeOperation.error) &&
              closeOperation,
          ]}
          className="absolute left-0 top-full z-20 w-56 rounded-lg border border-divider bg-popover p-3 text-sm shadow-md"
        />
      </div>
    </RequestCommit>
  );
}

function BrowserTabPicker({
  signals,
  selecting,
  onSelect,
  title,
}: {
  readonly signals: BrowserSignals;
  readonly selecting: boolean;
  readonly onSelect: (tabId: string) => Promise<void>;
  readonly title: (id: string, value: string) => string;
}) {
  const { t } = useTranslation();
  const tabs = useGet(signals.tabs$);
  const selectedTabId = useGet(signals.selectedTabId$);
  const controls = useGet(signals.controls$);
  return (
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
  const handoff = useGet(signals.focusHandoff$);
  const toolbarHandoff = handoff?.kind === "toolbar" ? handoff : null;
  const acknowledge = useSet(signals.acknowledgeFocusCommit$);
  const newTabDisabled = !controls.canCreate || creating;
  const syncLayout = useSet(signals.syncLayout$);
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
    <RequestCommit
      request={toolbarHandoff}
      commitKey={JSON.stringify([
        selectedTabId,
        newTabDisabled,
        layout.overflow,
      ])}
      onCommit={acknowledge}
    >
      <LayoutCommit
        layoutKey={String(Boolean(actions))}
        onLayoutCommit={syncLayout}
      >
        <div
          ref={toolbarRef}
          data-browser-toolbar
          className="flex min-w-0 shrink-0 items-center gap-1 border-b border-divider px-2 py-1"
        >
          <div
            data-browser-tab-budget
            className="flex min-w-0 flex-1 items-center gap-1"
          >
            <TabsList
              ref={tabsRef}
              className="h-9 min-w-0 flex-1 justify-start gap-1 rounded-none bg-transparent p-0"
            >
              {layout.items.map(({ target }) => {
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
                    selected={selectedTabId === target.id}
                    handoff={
                      handoff?.kind === "tab" && handoff.targetId === target.id
                        ? handoff
                        : null
                    }
                    selecting={selecting}
                  />
                );
              })}
            </TabsList>
            {layout.overflow && (
              <BrowserTabPicker
                signals={signals}
                selecting={selecting}
                onSelect={onSelect}
                title={title}
              />
            )}
          </div>
          <IconButton
            data-browser-new-tab
            type="button"
            aria-label={t(($) => {
              return $.browserViewer.newTab;
            })}
            disabled={newTabDisabled}
            className="size-8"
            onClick={() => {
              detach(onCreate(), Reason.DomCallback);
            }}
          >
            <Plus size={16} />
          </IconButton>
          {actions}
        </div>
      </LayoutCommit>
    </RequestCommit>
  );
}

function useBrowserRecovery(signals: BrowserSignals) {
  const recoveryOperation = useLoadable(signals.recoveryOperation$);
  const displayRecovery = useGet(signals.displayRecovery$);
  const navigationScope = useGet(signals.navigationScope$);
  const [retryOperation, retryImage] = useLoadableSet(signals.retryImage$);
  const [reconnectOperation, reconnect] = useLoadableSet(signals.reconnect$);
  const [reloadOperation, navigate] = useLoadableSet(signals.navigate$);
  const recovering = recoveryOperation.state === "loading";
  const pending =
    recoveryOperation.state === "loading" ||
    retryOperation.state === "loading" ||
    reloadOperation.state === "loading" ||
    reconnectOperation.state === "loading";
  // The current runtime presents connection failures. Action loadables retain
  // only local command feedback; an old Reconnect must not become current again.
  const failures = [
    displayRecovery,
    !recovering &&
      retryOperation.state === "hasError" &&
      isBrowserOperationFailure(retryOperation.error) &&
      retryOperation,
    reloadOperation.state === "hasError" &&
      isCurrentNavigationFailure(reloadOperation.error, navigationScope) &&
      reloadOperation,
  ];
  const recoveryError =
    recoveryOperation.state === "hasData" &&
    recoveryOperation.data &&
    recoveryOperation.data.status !== "restored"
      ? recoveryOperation.data.error
      : null;
  return {
    pending,
    failures,
    recovering,
    recoveryError,
    retryImage,
    reconnect,
    navigate,
  };
}

export function BrowserLoadingStatus({
  signals,
  className,
}: {
  readonly signals: BrowserSignals;
  readonly className?: string;
}) {
  const recovery = useLoadable(signals.recoveryOperation$);
  const presentation = useGet(signals.presentation$);
  const { t } = useTranslation();
  const recovering = recovery.state === "loading";
  return recovering || presentation.loadingPreview ? (
    <span
      role="status"
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <Loader2 size={12} aria-hidden className="animate-spin" />
      {t(($) => {
        return recovering
          ? $.browserViewer.reconnecting
          : $.browserViewer.updatingView;
      })}
    </span>
  ) : null;
}

function BrowserRecoveryActions({
  signals,
  recovery,
  creating,
  onCreate,
}: {
  readonly signals: BrowserSignals;
  readonly recovery: ReturnType<typeof useBrowserRecovery>;
  readonly creating: boolean;
  readonly onCreate: () => Promise<string>;
}) {
  const { t } = useTranslation();
  const controls = useGet(signals.controls$);
  const pageSignal = useGet(pageSignal$);
  const { pending, retryImage, reconnect, navigate } = recovery;
  return (
    <>
      {controls.canReload && (
        <Button
          type="button"
          variant="neutral"
          size="sm"
          disabled={pending}
          onClick={() => {
            detach(navigate("reload", pageSignal), Reason.DomCallback);
          }}
        >
          {t(($) => {
            return $.browserViewer.reload;
          })}
        </Button>
      )}
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
    </>
  );
}

function useBrowserStatusText(signals: BrowserSignals, recovering: boolean) {
  const { t } = useTranslation();
  const controls = useGet(signals.controls$);
  const presentation = useGet(signals.presentation$);
  return recovering || presentation.status === "connecting"
    ? t(($) => {
        return $.browserViewer.connecting;
      })
    : presentation.status === "paused"
      ? t(($) => {
          return $.browserViewer.paused;
        })
      : controls.empty
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
}

function BrowserStatus({
  signals,
  creating,
  contentVisible,
  onCreate,
}: {
  readonly signals: BrowserSignals;
  readonly creating: boolean;
  readonly contentVisible: boolean;
  readonly onCreate: () => Promise<string>;
}) {
  const presentation = useGet(signals.presentation$);
  const recovery = useBrowserRecovery(signals);
  const { failures, recovering, recoveryError } = recovery;
  const text = useBrowserStatusText(signals, recovering);
  const error = presentation.error
    ? (recoveryError ?? presentation.error)
    : null;
  const showStatus =
    !contentVisible && !(recovering && presentation.retainedFrame);
  return (
    <div
      role={showStatus ? "status" : undefined}
      className={
        showStatus
          ? "absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-5 text-center text-sm text-muted-foreground"
          : "contents"
      }
    >
      {showStatus && (recovering || presentation.status === "connecting") && (
        <Loader2 size={20} className="animate-spin" />
      )}
      {showStatus && <p>{text}</p>}
      {showStatus && !recovering && error && error.message !== text && (
        <p role="alert" className="max-w-md break-words">
          {error.message}
        </p>
      )}
      {showStatus && (
        <BrowserRecoveryActions
          signals={signals}
          recovery={recovery}
          creating={creating}
          onCreate={onCreate}
        />
      )}
      {/* Keep notice ownership stable when status gives way to live content. */}
      <BrowserOperationError
        occurrences={failures}
        duplicateMessage={showStatus ? error?.message : undefined}
        className={
          showStatus
            ? "text-sm"
            : "absolute inset-x-3 top-3 z-10 rounded-lg border border-divider bg-popover p-3 text-sm shadow-md"
        }
      />
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
        occurrences={[
          copyOperation.state === "hasError" &&
            isBrowserOperationFailure(copyOperation.error) &&
            copyOperation,
        ]}
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
// React restores input properties after events, so render the applied native type.
function BrowserInput({ signals }: { readonly signals: BrowserSignals }) {
  const { t } = useTranslation();
  const controls = useGet(signals.controls$);
  const type = useGet(signals.proxyType$);
  const inputRef = useSet(signals.refs.input$);
  return (
    <form className="contents">
      <Input
        ref={inputRef}
        data-browser-input
        aria-label={t(($) => {
          return $.browserViewer.remoteInput;
        })}
        disabled={!controls.streaming}
        type={type}
        inputMode="text"
        enterKeyHint="enter"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        className="pointer-events-none absolute left-0 top-0 h-px min-h-0 w-px overflow-hidden rounded-none border-0 p-0 text-base opacity-0 shadow-none"
      />
    </form>
  );
}

export function Browser({
  signals,
  actions,
  presence,
  placeholder,
}: {
  readonly signals: BrowserSignals;
  readonly actions: ReactNode;
  readonly presence: ReactNode;
  /** Paused content uses the real surface geometry before Browser creation. */
  readonly placeholder?: ReactNode;
}) {
  const { t } = useTranslation();
  const selectedTabId = useGet(signals.selectedTabId$);
  const presentation = useGet(signals.presentation$);
  const streaming = useGet(signals.streaming$);
  const pageSignal = useGet(pageSignal$);
  const imageRecovery = useGet(signals.imageRecovery$);
  const rootRef = useSet(signals.refs.root$);
  const surfaceRef = useSet(signals.refs.surface$);
  const canvasRef = useSet(signals.refs.canvas$);
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
      <BrowserNavigation
        signals={signals}
        settingsDisabled={placeholder !== undefined}
      />
      <TabsContent
        keepMounted
        value={selectedTabId}
        tabIndex={-1}
        className="relative min-h-0 flex-1"
      >
        <BrowserOperationError
          occurrences={[selectOperation, createOperation].filter(
            (operation) => {
              return (
                operation.state === "hasError" &&
                isBrowserOperationFailure(
                  operation.error,
                  imageRecovery !== null || streaming,
                )
              );
            },
          )}
          className="absolute inset-x-3 top-3 z-20 rounded-lg border border-surface-border bg-popover p-3 text-sm shadow-md"
        />
        <div
          ref={surfaceRef}
          data-browser-surface
          tabIndex={-1}
          className="relative h-full w-full touch-none overflow-hidden"
        >
          <canvas
            ref={canvasRef}
            data-browser-canvas
            role="img"
            aria-label={t(($) => {
              return $.browserViewer.liveView;
            })}
            aria-hidden={
              presentation.status !== "streaming" &&
              !presentation.retainedFrame &&
              !presentation.loadingPreview
            }
            className="block h-full w-full object-contain"
          />
          <BrowserInput signals={signals} />
          <BrowserFrameRate signals={signals.frameRate} />
        </div>
        {placeholder ?? (
          <BrowserStatus
            signals={signals}
            creating={createOperation.state === "loading"}
            contentVisible={
              presentation.status === "streaming" ||
              presentation.loadingPreview ||
              presentation.blank
            }
            onCreate={() => {
              return createTab(pageSignal);
            }}
          />
        )}
        {presentation.blank && (
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
