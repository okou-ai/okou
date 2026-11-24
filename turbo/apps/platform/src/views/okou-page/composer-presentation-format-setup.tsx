import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Radio,
  RadioGroup,
} from "@okouai/ui";
import { useGet, useLastResolved, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { Loader2, Monitor, Presentation } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { PresentationFormatSetupSignals } from "../../signals/okou-page/composer-presentation-format-setup.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

function PresentationFormatSetupContent({
  signals,
}: {
  readonly signals: PresentationFormatSetupSignals;
}) {
  const { t } = useTranslation();
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
    <DialogContent maxWidth="md" showCloseButton={!saving}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          {t(($) => {
            return $.chat.composer.presentationFormatSetup.description;
          })}
        </DialogDescription>
      </DialogHeader>
      <RadioGroup
        aria-label={title}
        value={selected}
        disabled={saving}
        className="grid gap-3 sm:grid-cols-2"
        onValueChange={(value) => {
          if (value === "html" || value === "pptx") {
            select(value);
          }
        }}
      >
        {(["html", "pptx"] as const).map((format) => {
          const Icon = format === "html" ? Monitor : Presentation;
          return (
            <label
              key={format}
              className="flex cursor-default items-start gap-3 rounded-lg border border-border p-4 hover:bg-gray-50 has-data-checked:border-primary has-data-checked:bg-gray-50 has-data-disabled:cursor-not-allowed has-data-disabled:opacity-50"
            >
              <Radio value={format} className="mt-0.5 shrink-0" />
              <span className="grid gap-2 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Icon aria-hidden="true" className="size-4" />
                  {format.toUpperCase()}
                </span>
                <span className="leading-5 text-muted-foreground">
                  {t(($) => {
                    return format === "html"
                      ? $.chat.composer.presentationFormatSetup.htmlDescription
                      : $.chat.composer.presentationFormatSetup.pptxDescription;
                  })}
                </span>
              </span>
            </label>
          );
        })}
      </RadioGroup>
      <p className="text-sm text-muted-foreground">
        {t(($) => {
          return $.chat.composer.presentationFormatSetup.settingsHint;
        })}
      </p>
      {save.state === "hasError" && (
        <p role="alert" className="text-sm text-destructive">
          {t(($) => {
            return $.settings.preferences.chat.presentationFormat.saveFailed;
          })}
        </p>
      )}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={dismiss}>
          {t(($) => {
            return $.chat.actions.cancel;
          })}
        </Button>
        <Button
          disabled={!selected || saving}
          aria-busy={saving}
          onClick={() => {
            detach(confirm(signal), Reason.DomCallback);
          }}
        >
          {saving && (
            <Loader2 aria-hidden="true" className="size-4 animate-spin" />
          )}
          {t(($) => {
            return $.chat.composer.presentationFormatSetup.saveAndGenerate;
          })}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export function ComposerPresentationFormatSetup({
  signals,
}: {
  readonly signals: PresentationFormatSetupSignals;
}) {
  const open = useLastResolved(signals.open$) ?? false;
  const dismiss = useSet(signals.dismiss$);
  if (!open) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          dismiss();
        }
      }}
    >
      <PresentationFormatSetupContent signals={signals} />
    </Dialog>
  );
}
