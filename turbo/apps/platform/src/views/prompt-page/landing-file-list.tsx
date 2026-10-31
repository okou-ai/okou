import { useLoadable } from "ccstate-react";
import { useTranslation } from "react-i18next";
import { landingFilePreview$ } from "../../signals/prompt-page/landing-file-preview.ts";
import { FilePreviewIcon } from "../okou-page/file-preview-icon.tsx";
import { formatSize } from "../okou-page/components/network-badge.tsx";

export function LandingFileList({
  files,
  pending = true,
}: {
  files: readonly {
    id: string;
    file: Pick<File, "name" | "size" | "type">;
  }[];
  pending?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t(($) => {
        return $.chat.landingFiles.selected;
      })}
      className="min-w-0 space-y-2"
    >
      <h2 className="text-sm font-medium">
        {t(($) => {
          return $.chat.landingFiles.selected;
        })}
      </h2>
      <ul className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2">
        {files.map(({ id, file }) => {
          return (
            <li
              key={id}
              className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-background px-3 py-2"
            >
              <FilePreviewIcon
                filename={file.name}
                contentType={file.type}
                className="shrink-0"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium" title={file.name}>
                  {file.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatSize(file.size)}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      {pending && (
        <p className="text-xs text-muted-foreground">
          {t(($) => {
            return $.chat.landingFiles.pending;
          })}
        </p>
      )}
    </section>
  );
}

export function LandingFilePreview() {
  const preview = useLoadable(landingFilePreview$);
  return preview.state === "hasData" && preview.data ? (
    <LandingFileList files={preview.data} />
  ) : null;
}
