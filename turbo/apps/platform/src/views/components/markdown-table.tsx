import type { ComponentPropsWithoutRef } from "react";
import { useGet, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Download, Loader2 } from "lucide-react";
import {
  BrandGoogleDrive,
  BrandGoogleSheets,
  Button,
  Card,
  cn,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from "@okouai/ui";
import type { Element } from "hast";
import { formatAppNumber } from "../../i18n/format.ts";
import { getMarkdownTableDimensions } from "../../lib/markdown-table-dimensions.ts";
import { captureArtifactAction } from "../../lib/posthog.ts";
import { pageSignal$ } from "../../signals/page-signal.ts";
import { currentChatThreadId$ } from "../../signals/agent-chat.ts";
import {
  exportMarkdownTable$,
  markdownTableConnection$,
  connectMarkdownTable$,
  closeMarkdownTableConnection$,
} from "../../signals/markdown-table-export.ts";
import { cancelBuiltinConnectorConnection$ } from "../../signals/okou-page/settings/connectors.ts";
import { detach, Reason } from "../../signals/utils.ts";
import { MarkdownHorizontalScroll } from "./markdown-horizontal-scroll.tsx";

type TableProps = ComponentPropsWithoutRef<"table"> & { node?: Element };

export function MarkdownTable({ node, children, ...props }: TableProps) {
  if (!node) {
    return (
      <MarkdownHorizontalScroll>
        <table {...props}>{children}</table>
      </MarkdownHorizontalScroll>
    );
  }
  return (
    <ExportableTable {...props} node={node}>
      {children}
    </ExportableTable>
  );
}

function ExportableTable({
  node,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<"table"> & { node: Element }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const threadId = useGet(currentChatThreadId$);
  const connection = useGet(markdownTableConnection$);
  const [operation, exportTable] = useLoadableSet(exportMarkdownTable$);
  const pending = operation.state === "loading";
  const { rows: rowCount, columns: columnCount } =
    getMarkdownTableDimensions(node);
  const run = (mode: "excel" | "original" | "google") => {
    const surface = "inline_table";
    captureArtifactAction(
      mode === "excel"
        ? { action: "download", surface, artifact_type: "spreadsheet" }
        : {
            action: "google_drive_sync",
            surface,
            target: mode === "google" ? "spreadsheet" : "file",
          },
    );
    detach(
      exportTable(node, mode, signal),
      Reason.DomCallback,
      "export markdown table",
    );
  };
  return (
    <Card className="my-3 min-w-0 rounded-3xl p-2">
      <MarkdownHorizontalScroll className="rounded-2xl">
        <table {...props} className={cn("m-0! min-w-max border-0!", className)}>
          {children}
        </table>
      </MarkdownHorizontalScroll>
      <div
        data-markdown-ui
        className="mt-1 flex items-center justify-between gap-3 px-0.5"
      >
        <p className="m-0 pl-3 text-xs text-muted-foreground">
          {t(
            ($) => {
              return $.markdown.tableExport.rows;
            },
            { count: rowCount, formattedCount: formatAppNumber(rowCount) },
          )}
          {" · "}
          {t(
            ($) => {
              return $.markdown.tableExport.columns;
            },
            {
              count: columnCount,
              formattedCount: formatAppNumber(columnCount),
            },
          )}
        </p>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton
                aria-label={
                  pending
                    ? t(($) => {
                        return $.markdown.tableExport.saving;
                      })
                    : t(($) => {
                        return $.markdown.tableExport.export;
                      })
                }
                disabled={pending || connection?.params.table === node}
                aria-busy={pending}
                className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50 [@media(hover:none),(pointer:coarse),(any-pointer:coarse)]:size-11"
              />
            }
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Download className="size-4" aria-hidden="true" />
            )}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              className="[@media(hover:none),(pointer:coarse),(any-pointer:coarse)]:min-h-11"
              onClick={() => {
                return run("excel");
              }}
            >
              <Download />
              {t(($) => {
                return $.markdown.tableExport.excel;
              })}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="[@media(hover:none),(pointer:coarse),(any-pointer:coarse)]:min-h-11"
              disabled={!threadId}
              onClick={() => {
                return run("original");
              }}
            >
              <BrandGoogleDrive />
              {t(($) => {
                return $.markdown.tableExport.drive;
              })}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="[@media(hover:none),(pointer:coarse),(any-pointer:coarse)]:min-h-11"
              disabled={!threadId}
              onClick={() => {
                return run("google");
              }}
            >
              <BrandGoogleSheets />
              {t(($) => {
                return $.markdown.tableExport.sheets;
              })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <TableGoogleConnectionDialog node={node} />
    </Card>
  );
}

function TableGoogleConnectionDialog({ node }: { readonly node: Element }) {
  const { t } = useTranslation();
  const signal = useGet(pageSignal$);
  const connection = useGet(markdownTableConnection$);
  const closeConnection = useSet(closeMarkdownTableConnection$);
  const cancelConnection = useSet(cancelBuiltinConnectorConnection$);
  const [connectionOperation, connect] = useLoadableSet(connectMarkdownTable$);
  if (connection?.params.table !== node) {
    return null;
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          cancelConnection();
          closeConnection();
        }
      }}
    >
      <DialogContent maxWidth="sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {t(($) => {
              return $.artifacts.googleDrive.connect;
            })}
          </DialogTitle>
        </DialogHeader>
        {connectionOperation.state === "hasError" && (
          <p role="alert" className="text-sm text-destructive">
            {String(connectionOperation.error)}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={connectionOperation.state === "loading"}
            onClick={() => {
              detach(
                connect(connection, signal),
                Reason.DomCallback,
                "connect table export to Google Drive",
              );
            }}
          >
            {connectionOperation.state === "loading" && (
              <Loader2 className="animate-spin" />
            )}
            {t(($) => {
              return $.connectors.actions.connect;
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
