import { Button, Textarea, buttonVariants } from "@okouai/ui";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { LandingFilesSignals } from "../../signals/prompt-page/landing-files.ts";
import {
  LandingFilePopupBlockedError,
  LandingFilesUnavailableError,
} from "../../signals/prompt-page/landing-file-handoff.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { LandingFileList, LandingFilePreview } from "./landing-file-list.tsx";

export function LandingFilesPage({
  signals,
}: {
  signals: LandingFilesSignals;
}) {
  const { t } = useTranslation();
  const files = useGet(signals.files$);
  const prompt = useGet(signals.input$);
  const edit = useSet(signals.edit$);
  const starting = useLoadable(signals.operation$);
  const start = useSet(signals.start$);
  const signal = useGet(pageSignal$);
  const busy = starting.state !== "hasError";
  const attachments = useGet(signals.attachments$);
  const popupBlocked =
    starting.state === "hasError" &&
    starting.error instanceof LandingFilePopupBlockedError;
  const missing =
    !signals.source ||
    (starting.state === "hasError" &&
      starting.error instanceof LandingFilesUnavailableError);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <section className="flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-border bg-card p-6">
        <ProductBrandMark decorative size="hero" />
        <h1 className="text-xl font-medium">
          {t(($) => {
            return busy
              ? $.chat.landingFiles.loading
              : $.chat.landingFiles.selected;
          })}
        </h1>
        {!busy && (
          <Textarea
            value={prompt}
            onChange={(event) => {
              edit(event.target.value);
            }}
            aria-label={t(($) => {
              return $.chat.landingFiles.prompt;
            })}
            className="min-h-32"
          />
        )}
        {files ? (
          <div className="flex flex-wrap gap-2">
            <LandingFileList files={files} />
          </div>
        ) : (
          <LandingFilePreview />
        )}
        {busy && files && (
          <p role="status" className="text-sm text-muted-foreground">
            {t(
              ($) => {
                return $.chat.landingFiles.uploading;
              },
              {
                current: attachments.length,
                total: files.length,
              },
            )}
          </p>
        )}
        {(!signals.source || starting.state === "hasError") && (
          <p role="alert" className="text-sm text-destructive">
            {popupBlocked
              ? t(($) => {
                  return $.chat.landingFiles.popupBlocked;
                })
              : missing
                ? t(($) => {
                    return $.chat.landingFiles.missing;
                  })
                : t(($) => {
                    return $.chat.landingFiles.failed;
                  })}
          </p>
        )}
        {!busy && (
          <div className="flex flex-wrap justify-end gap-2">
            {signals.back && (
              <a
                href={signals.back}
                className={buttonVariants({ variant: "outline" })}
              >
                {t(($) => {
                  return $.chat.landingFiles.back;
                })}
              </a>
            )}
            <Button
              className="bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
              disabled={!signals.source || !prompt.trim()}
              onClick={() => {
                detach(start(signal), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.chat.landingFiles.retry;
              })}
            </Button>
          </div>
        )}
      </section>
    </main>
  );
}
