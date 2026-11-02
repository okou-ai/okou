import type { ComponentPropsWithoutRef } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { Download, Loader2 } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
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
} from "@okouai/ui";
import type { Element } from "hast";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
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

type TableProps = ComponentPropsWithoutRef<"table"> & { node?: Element };

export function MarkdownTable({ node, children, ...props }: TableProps) {
  const features = useLastResolved(featureSwitch$);
  if (!node || !features?.[FeatureSwitchKey.MarkdownTableExport]) {
    return (
      <div className="overflow-x-auto">
        <table {...props}>{children}</table>
      </div>
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
  const run = (mode: "excel" | "original" | "google") => {
    detach(
      exportTable(node, mode, signal),
      Reason.DomCallback,
      "export markdown table",
    );
  };
  return (
    <Card className="group/markdown-table relative my-3 min-w-0 rounded-3xl p-2">
      <div data-markdown-ui>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="quiet"
                size="xs"
                disabled={pending || connection?.params.table === node}
                aria-busy={pending}
                className={cn(
                  "absolute top-1.5 right-1.5 h-11 bg-gray-200 duration-300 ease-[ease]",
                  "[&:hover:not(:active)]:bg-gray-300 [&:active:enabled]:bg-gray-400 [&:active:enabled]:text-foreground",
                  // Only mouse-only devices hide the control. Touch-capable
                  // hybrids keep the same visible, 44px-high target as phones.
                  "[@media(hover:hover)_and_(pointer:fine)_and_(not_(any-pointer:coarse))]:h-7",
                  "[@media(hover:hover)_and_(pointer:fine)_and_(not_(any-pointer:coarse))]:gap-1.5",
                  "[@media(hover:hover)_and_(pointer:fine)_and_(not_(any-pointer:coarse))]:rounded-md",
                  "[@media(hover:hover)_and_(pointer:fine)_and_(not_(any-pointer:coarse))]:text-[12px]",
                  // Opacity keeps Export in the tab order. These state
                  // selectors outrank the idle media rule, including while
                  // the portalled menu owns focus or an export is pending.
                  "[@media(hover:hover)_and_(pointer:fine)_and_(not_(any-pointer:coarse))]:pointer-events-none",
                  "[@media(hover:hover)_and_(pointer:fine)_and_(not_(any-pointer:coarse))]:opacity-0",
                  "group-hover/markdown-table:pointer-events-auto group-hover/markdown-table:opacity-100",
                  "group-focus-within/markdown-table:pointer-events-auto group-focus-within/markdown-table:opacity-100",
                  "data-popup-open:pointer-events-auto data-popup-open:opacity-100 aria-busy:opacity-100",
                )}
              />
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <Download />}
            {pending
              ? t(($) => {
                  return $.markdown.tableExport.saving;
                })
              : t(($) => {
                  return $.markdown.tableExport.export;
                })}
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
      <div className="overflow-x-auto rounded-2xl">
        <table {...props} className={cn("m-0! min-w-max border-0!", className)}>
          {children}
        </table>
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
