import { Button, Textarea, buttonVariants } from "@okouai/ui";
import { useGet, useSet, useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import type { LandingFilesSignals } from "../../signals/prompt-page/landing-files.ts";
import {
  LandingFilePopupBlockedError,
  LandingFilesUnavailableError,
} from "../../signals/prompt-page/landing-file-handoff.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { ChatUserMessageBubble } from "../okou-page/chat-message-surface.tsx";
import { LandingFileList } from "./landing-file-list.tsx";

export function LandingFilesMessage({
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
    <div data-landing-files-message className="flex flex-col items-end gap-3">
      <ChatUserMessageBubble className="whitespace-pre-wrap">
        <div className="px-4 py-3">{prompt}</div>
      </ChatUserMessageBubble>
      <div className="flex max-w-full flex-col items-end gap-3">
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
        <div className="flex flex-wrap gap-2">
          <LandingFileList files={files ?? signals.preview} />
        </div>
        {busy && (
          <p role="status" className="text-sm text-muted-foreground">
            {files
              ? t(
                  ($) => {
                    return $.chat.landingFiles.uploading;
                  },
                  {
                    current: attachments.length,
                    total: files.length,
                  },
                )
              : t(($) => {
                  return $.chat.landingFiles.loading;
                })}
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
                detach(start(), Reason.DomCallback);
              }}
            >
              {t(($) => {
                return $.chat.landingFiles.retry;
              })}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
