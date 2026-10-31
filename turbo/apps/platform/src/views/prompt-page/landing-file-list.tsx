import {
  Button,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "@okouai/ui";
import { IconTooltipButton } from "../components/icon-tooltip.tsx";
import { Paperclip, X } from "lucide-react";
import { useGet, useLoadable, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import {
  landingFilePreview$,
  editLandingFiles$,
  LandingFileLimitError,
  setLandingFileInput$,
  openLandingFileInput$,
} from "../../signals/prompt-page/landing-file-preview.ts";
import { rootSignal$ } from "../../signals/root-signal.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { FILE_CHIP_CLASSES, FileChipBody } from "../okou-page/file-chip.tsx";
import { formatSize } from "../okou-page/components/network-badge.tsx";

type SelectedFile = { id: string; file: Pick<File, "name" | "size" | "type"> };

export function LandingFileList({
  files,
  onRemove,
  disabled = false,
}: {
  files: readonly SelectedFile[];
  onRemove?: (key: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <TooltipProvider delay={200}>
      {files.map(({ id, file }) => {
        return (
          <span key={id} className="relative inline-flex min-w-0 items-center">
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={FILE_CHIP_CLASSES}
                    tabIndex={0}
                    aria-label={`${file.name} · ${formatSize(file.size)}`}
                  />
                }
              >
                <FileChipBody
                  filename={file.name}
                  contentType={file.type}
                  testId="landing-attachment-file-icon"
                />
              </TooltipTrigger>
              <TooltipContent>
                {file.name} · {formatSize(file.size)}
              </TooltipContent>
            </Tooltip>
            {onRemove && (
              <IconTooltipButton
                type="button"
                disabled={disabled}
                onClick={() => {
                  onRemove(id);
                }}
                className="absolute -top-1 -right-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted hover:bg-destructive hover:text-destructive-foreground transition-colors"
                aria-label={t(
                  ($) => {
                    return $.artifacts.attachments.remove;
                  },
                  { filename: file.name },
                )}
              >
                <X size={9} />
              </IconTooltipButton>
            )}
          </span>
        );
      })}
    </TooltipProvider>
  );
}

export function LandingFilePreview({
  editable = false,
}: {
  editable?: boolean;
}) {
  const { t } = useTranslation();
  const preview = useLoadable(landingFilePreview$);
  const [editing, edit] = useLoadableSet(editLandingFiles$);
  const signal = useGet(rootSignal$);
  const setInput = useSet(setLandingFileInput$);
  const openInput = useSet(openLandingFileInput$);
  const busy = editing.state === "loading";
  if (preview.state !== "hasData" || preview.data === null) {
    return null;
  }
  return (
    <section
      aria-label={t(($) => {
        return $.chat.landingFiles.selected;
      })}
      className="min-w-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <LandingFileList
          files={preview.data}
          disabled={busy}
          onRemove={
            editable
              ? (key) => {
                  detach(
                    edit({ kind: "remove", key }, signal),
                    Reason.DomCallback,
                  );
                }
              : undefined
          }
        />
        {editable && (
          <>
            <input
              ref={setInput}
              type="file"
              multiple
              className="hidden"
              disabled={busy}
              aria-label={t(($) => {
                return $.chat.attachments.attach;
              })}
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = "";
                if (files.length) {
                  detach(
                    edit({ kind: "add", files }, signal),
                    Reason.DomCallback,
                  );
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs text-muted-foreground"
              disabled={busy}
              pending={busy}
              onClick={() => {
                openInput();
              }}
            >
              <Paperclip size={14} />
              {t(($) => {
                return $.chat.attachments.attach;
              })}
            </Button>
          </>
        )}
      </div>
      {editing.state === "hasError" && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {editing.error instanceof LandingFileLimitError
            ? t(($) => {
                return $.chat.landingFiles.limit;
              })
            : t(($) => {
                return $.chat.landingFiles.editFailed;
              })}
        </p>
      )}
    </section>
  );
}
