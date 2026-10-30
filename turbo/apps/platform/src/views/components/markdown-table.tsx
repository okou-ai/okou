import type { ComponentPropsWithoutRef } from "react";
import { useGet, useLastResolved, useSet } from "ccstate-react";
import { useLoadableSet } from "ccstate-react/experimental";
import { useTranslation } from "react-i18next";
import { ChevronDown, Download, Loader2 } from "lucide-react";
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
    <Card className="my-3 min-w-0 rounded-3xl p-2">
      <div data-markdown-ui className="mb-1 flex justify-end">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="quiet"
                size="sm"
                disabled={pending}
                aria-busy={pending}
              />
            }
          >
            {pending ? <Loader2 className="animate-spin" /> : <Download />}
            {t(($) => {
              return $.markdown.tableExport.export;
            })}
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
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
