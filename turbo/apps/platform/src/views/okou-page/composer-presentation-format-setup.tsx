import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
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

/**
 * Asks for the saved default once, from the Send button that triggered it.
 * Choosing a format is the confirmation: it saves the default and sends the
 * original draft. Dismissing keeps the draft and sends nothing.
 */
export function ComposerPresentationFormatSetup({
  signals,
}: {
  readonly signals: PresentationFormatSetupSignals;
}) {
  const { t } = useTranslation();
  const open = useLastResolved(signals.open$) ?? false;
  const anchor = useGet(signals.anchor$);
  const selected = useGet(signals.selected$);
  const confirmation = useLoadable(signals.confirmation$);
  const saving = confirmation.state === "loading";
  const select = useSet(signals.select$);
  const dismiss = useSet(signals.dismiss$);
  const [save, confirm] = useLoadableSet(signals.confirm$);
  const signal = useGet(rootSignal$);
  const title = t(($) => {
    return $.chat.composer.presentationFormatSetup.title;
  });
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
        side="top"
        align="end"
        sideOffset={8}
        aria-label={title}
        className="w-[300px]"
      >
        <p className="px-2 pt-1.5 pb-1 text-xs leading-4 font-medium text-foreground">
          {title}
        </p>
        {FORMATS.map(({ format, Icon }) => {
          return (
            <DropdownMenuItem
              key={format}
              closeOnClick={false}
              disabled={saving}
              aria-busy={saving && selected === format}
              className="items-start"
              onClick={() => {
                select(format);
                detach(confirm(signal), Reason.DomCallback);
              }}
            >
              {saving && selected === format ? (
                <Loader2
                  aria-hidden="true"
                  className="mt-0.5 animate-spin text-muted-foreground"
                />
              ) : (
                <Icon
                  aria-hidden="true"
                  className="mt-0.5 text-muted-foreground"
                />
              )}
              <span className="grid min-w-0 gap-0.5">
                <span className="font-medium">
                  {t(($) => {
                    return format === "html"
                      ? $.chat.composer.presentationFormatSetup.htmlLabel
                      : $.chat.composer.presentationFormatSetup.pptxLabel;
                  })}
                </span>
                <span className="text-[13px] leading-5 text-muted-foreground">
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
        {save.state === "hasError" ? (
          <p
            role="alert"
            className="px-2 pt-2 pb-1.5 text-xs leading-4 text-destructive"
          >
            {t(($) => {
              return $.settings.preferences.chat.presentationFormat.saveFailed;
            })}
          </p>
        ) : (
          <p className="px-2 pt-2 pb-1.5 text-xs leading-4 text-muted-foreground">
            {t(($) => {
              return $.chat.composer.presentationFormatSetup.settingsHint;
            })}
          </p>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
