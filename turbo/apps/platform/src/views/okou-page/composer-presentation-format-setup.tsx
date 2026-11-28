import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@okouai/ui/components/ui/dropdown-menu";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { FilePenLine, Loader2, MonitorPlay } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PresentationFormatSetupSignals } from "../../signals/okou-page/composer-presentation-format-setup.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

const FORMATS = [
  { format: "html", Icon: MonitorPlay },
  { format: "pptx", Icon: FilePenLine },
] as const;

function PresentationFormatSetupMenuBody({
  signals,
}: {
  readonly signals: PresentationFormatSetupSignals;
}) {
  const { t } = useTranslation();
  const operation = useLoadable(signals.confirmation$);
  const saving = operation.state === "loading";
  const [save, confirm] = useLoadableSet(signals.confirm$);
  const dismiss = useSet(signals.dismiss$);
  const signal = useGet(rootSignal$);
  return (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          {t(($) => {
            return $.chat.composer.presentationFormatSetup.title;
          })}
        </DropdownMenuLabel>
        {FORMATS.map(({ format, Icon }) => {
          return (
            <DropdownMenuItem
              key={format}
              closeOnClick={false}
              disabled={saving}
              aria-label={t(($) => {
                return format === "html"
                  ? $.chat.composer.presentationFormatSetup.htmlLabel
                  : $.chat.composer.presentationFormatSetup.pptxLabel;
              })}
              onClick={() => {
                detach(confirm(format, signal), Reason.DomCallback);
              }}
            >
              <Icon aria-hidden="true" className="text-muted-foreground" />
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium">
                  {t(($) => {
                    return format === "html"
                      ? $.chat.composer.presentationFormatSetup.htmlLabel
                      : $.chat.composer.presentationFormatSetup.pptxLabel;
                  })}
                </span>
                <span className="text-xs leading-5 text-muted-foreground">
                  {t(($) => {
                    return format === "html"
                      ? $.chat.composer.presentationFormatSetup.htmlDescription
                      : $.chat.composer.presentationFormatSetup.pptxDescription;
                  })}
                </span>
              </span>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuGroup>
      {saving ? (
        <p
          role="status"
          className="flex items-center gap-2 px-2 pt-2 pb-1.5 text-xs text-muted-foreground"
        >
          <Loader2 aria-hidden="true" className="size-3 animate-spin" />
          {t(($) => {
            return $.chat.composer.presentationFormatSetup.saving;
          })}
        </p>
      ) : (
        <p
          role={save.state === "hasError" ? "alert" : undefined}
          className={
            save.state === "hasError"
              ? "px-2 pt-2 pb-1.5 text-xs leading-4 text-destructive"
              : "px-2 pt-2 pb-1.5 text-xs leading-4 text-muted-foreground"
          }
        >
          {t(($) => {
            return save.state === "hasError"
              ? $.chat.composer.presentationFormatSetup.saveFailed
              : $.chat.composer.presentationFormatSetup.settingsHint;
          })}
        </p>
      )}
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={saving} onClick={dismiss}>
        {t(($) => {
          return $.chat.actions.cancel;
        })}
      </DropdownMenuItem>
    </>
  );
}

/** Choosing saves the default and continues the existing Send/Queue once. */
export function ComposerPresentationFormatSetup({
  signals,
}: {
  readonly signals: PresentationFormatSetupSignals;
}) {
  const { t } = useTranslation();
  // Observe the existing preference cache when a known Presentation task is
  // selected; opening the menu itself never starts a preference request.
  useLoadable(signals.required$);
  const open = useLastResolved(signals.open$) ?? false;
  const anchor = useGet(signals.anchor$);
  const finalFocus = useSet(signals.finalFocus$);
  const dismiss = useSet(signals.dismiss$);
  return (
    <DropdownMenu
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          dismiss();
        }
      }}
    >
      <DropdownMenuContent
        anchor={anchor}
        finalFocus={finalFocus}
        side="top"
        align="end"
        sideOffset={8}
        aria-label={t(($) => {
          return $.chat.composer.presentationFormatSetup.title;
        })}
        className="w-[300px]"
      >
        <PresentationFormatSetupMenuBody signals={signals} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
