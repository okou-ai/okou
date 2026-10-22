import {
  Button,
  buttonVariants,
  cn,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@okouai/ui";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import type { Root } from "hast";
import { Download, FileType2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  generateMessagePdf$,
  GenerateMessagePdfEvent,
  messagePdfActionRef$,
} from "../../signals/chat-page/chat-message-pdf.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";

export function MessagePdfAction({
  contents,
  trees,
}: {
  readonly contents: readonly string[];
  readonly trees: readonly Root[];
}) {
  const { t } = useTranslation();
  const pageSignal = useGet(pageSignal$);
  const actionRef = useSet(messagePdfActionRef$);
  const [operation, generate] = useLoadableSet(generateMessagePdf$);
  const generating = operation.state === "loading";
  const label =
    operation.state === "hasData"
      ? t(($) => {
          return $.chat.actions.downloadPdf;
        })
      : generating
        ? t(($) => {
            return $.chat.actions.generatingPdf;
          })
        : t(($) => {
            return $.chat.actions.generatePdf;
          });

  return (
    <span
      ref={actionRef}
      data-message-pdf-action
      className="inline-flex items-center gap-1"
    >
      <TooltipProvider delay={300}>
        <Tooltip>
          <TooltipTrigger
            render={
              operation.state === "hasData" ? (
                <a
                  ref={operation.data.ref}
                  download={operation.data.filename}
                  aria-label={label}
                  className={cn(
                    buttonVariants({
                      variant: "quiet",
                      size: "icon-xs",
                      iconSize: "sm",
                    }),
                    "text-muted-foreground/60",
                  )}
                >
                  <Download aria-hidden />
                </a>
              ) : (
                <Button
                  type="button"
                  variant="quiet"
                  size="icon-xs"
                  iconSize="sm"
                  pending={generating}
                  className="text-muted-foreground/60"
                  aria-label={label}
                  onClick={(event) => {
                    const trigger = event.currentTarget;
                    trigger.dispatchEvent(
                      new GenerateMessagePdfEvent((ownerSignal) => {
                        detach(
                          generate(
                            { contents, trees, trigger },
                            AbortSignal.any([pageSignal, ownerSignal]),
                          ),
                          Reason.DomCallback,
                          "generate message PDF",
                        );
                      }),
                    );
                  }}
                >
                  <FileType2 aria-hidden />
                </Button>
              )
            }
          />
          <TooltipContent side="bottom">{label}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {operation.state === "hasError" ? (
        <span role="alert" className="text-xs text-destructive">
          {t(($) => {
            return $.chat.actions.pdfGenerationFailed;
          })}
        </span>
      ) : null}
    </span>
  );
}
