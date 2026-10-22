import { useTranslation } from "react-i18next";
import { useLoadable } from "ccstate-react";
import { permissionBatchPageSignals$ } from "../../signals/permission-allow/permission-batch-page-signals.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { PermissionBatchContent } from "./permission-batch-content.tsx";

export function PermissionBatchPage() {
  const graph = useLoadable(permissionBatchPageSignals$);
  const { t } = useTranslation();
  if (graph.state === "hasError") {
    throw graph.error;
  }
  const signals = graph.state === "hasData" ? graph.data : null;
  return (
    <div className="pointer-events-none fixed inset-0 flex h-viewport flex-col items-center overflow-y-auto pt-safe-offset-8 pr-safe-offset-6 pb-safe-offset-8 pl-safe-offset-6">
      <main className="pointer-events-auto my-auto flex w-[600px] max-w-full shrink-0 flex-col items-center gap-10 rounded-[20px] border border-border bg-background px-6 py-12">
        <ProductBrandMark />
        {graph.state === "loading" ? (
          <p
            role="status"
            className="text-center text-sm text-muted-foreground"
          >
            {t(($) => {
              return $.authorization.permissionBatch.loading;
            })}
          </p>
        ) : signals ? (
          <PermissionBatchContent signals={signals} standalone />
        ) : (
          <p role="alert" className="text-center text-sm text-destructive">
            {t(($) => {
              return $.authorization.permissionBatch.invalid;
            })}
          </p>
        )}
      </main>
    </div>
  );
}
