import { Button, Textarea, buttonVariants } from "@okouai/ui";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import type { LandingFilesSignals } from "../../signals/prompt-page/landing-files.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";

export function LandingFilesPage({
  signals,
}: {
  signals: LandingFilesSignals;
}) {
  const { t } = useTranslation();
  const files = useLoadable(signals.files$);
  const prompt = useGet(signals.input$);
  const edit = useSet(signals.edit$);
  const [starting, start] = useLoadableSet(signals.start$);
  const signal = useGet(pageSignal$);
  const busy = starting.state === "loading";
  const attachments = useGet(signals.attachments$);
  const back = signals.source ? new URL(signals.source) : null;
  back?.searchParams.set("fileDraft", signals.id);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-6">
      <section className="flex w-full max-w-xl flex-col gap-4 rounded-2xl border border-border bg-card p-6">
        <ProductBrandMark decorative size="hero" />
        <h1 className="text-xl font-medium">
          {t(($) => {
            return $.chat.landingFiles.title;
          })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(($) => {
            return $.chat.landingFiles.description;
          })}
        </p>
        <Textarea
          value={prompt}
          disabled={busy}
          onChange={(event) => {
            edit(event.target.value);
          }}
          aria-label={t(($) => {
            return $.chat.landingFiles.prompt;
          })}
          className="min-h-32"
        />
        {files.state === "loading" && (
          <p role="status">
            {t(($) => {
              return $.chat.landingFiles.loading;
            })}
          </p>
        )}
        {files.state === "hasData" && (
          <ul className="flex flex-col gap-2">
            {files.data.map(({ id, file }) => {
              return (
                <li
                  key={id}
                  className="truncate rounded-lg bg-muted px-3 py-2 text-sm"
                >
                  {file.name}
                </li>
              );
            })}
          </ul>
        )}
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {t(
              ($) => {
                return $.chat.landingFiles.uploading;
              },
              {
                current: attachments.length,
                total: files.state === "hasData" ? files.data.length : 0,
              },
            )}
          </p>
        )}
        {(files.state === "hasError" || starting.state === "hasError") && (
          <p role="alert" className="text-sm text-destructive">
            {t(($) => {
              return files.state === "hasError"
                ? $.chat.landingFiles.missing
                : $.chat.landingFiles.failed;
            })}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          {back && !busy && (
            <a
              href={back.toString()}
              className={buttonVariants({ variant: "outline" })}
            >
              {t(($) => {
                return $.chat.landingFiles.back;
              })}
            </a>
          )}
          <Button
            pending={busy}
            className="bg-foreground text-background hover:bg-foreground-hover active:bg-foreground-pressed"
            disabled={files.state !== "hasData" || busy || !prompt.trim()}
            onClick={() => {
              detach(start(signal), Reason.DomCallback);
            }}
          >
            {t(($) => {
              return starting.state === "hasError"
                ? $.chat.landingFiles.retry
                : $.chat.landingFiles.start;
            })}
          </Button>
        </div>
      </section>
    </main>
  );
}
