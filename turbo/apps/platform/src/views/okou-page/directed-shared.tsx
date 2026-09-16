import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { Link } from "../router/link.tsx";
import { CreditPurchaseConfirmDialog } from "./components/org-manage/credit-purchase-confirm-dialog.tsx";
import { SubscriptionPurchaseConfirmDialog } from "./components/org-manage/subscription-purchase-confirm-dialog.tsx";
import { SettingsDialogMount } from "./components/settings/settings-dialog.tsx";
import {
  paletteColorTheme$,
  shellDocumentAttributesRef$,
} from "../../signals/theme.ts";

export function StandaloneLayout({ children }: { children: ReactNode }) {
  const paletteColorTheme = useGet(paletteColorTheme$);
  const shellDocumentAttributesRef = useSet(shellDocumentAttributesRef$);

  return (
    <div
      ref={shellDocumentAttributesRef}
      className="box-border flex h-full max-h-full min-h-full w-full flex-col overflow-hidden bg-background pb-(--sab)"
      data-gradient-color-themes={
        paletteColorTheme === undefined ? undefined : true
      }
      data-color-theme={paletteColorTheme}
    >
      <SettingsDialogMount />
      <CreditPurchaseConfirmDialog />
      <SubscriptionPurchaseConfirmDialog />
      {children}
    </div>
  );
}

export function ProductBrandMarkLink() {
  return (
    <Link pathname="/connectors" className="no-underline text-foreground">
      <ProductBrandMark size="compact" />
    </Link>
  );
}

export function DirectedCardShell({
  icon,
  title,
  description,
  isLoading,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly description: string;
  readonly isLoading: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center pointer-events-none">
      <div className="pointer-events-auto flex w-[430px] max-w-[calc(100%-48px)] flex-col items-center gap-12 rounded-[20px] border border-border bg-background px-6 py-12 text-center">
        <ProductBrandMarkLink />
        <div className="flex w-full flex-col gap-4">
          <div className="flex flex-col items-center gap-2.5">
            {isLoading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <>
                <h1 className="text-lg font-medium text-foreground">{title}</h1>
                <div className="flex items-center justify-center rounded-[10px] bg-muted p-2.5">
                  {icon}
                </div>
                <p className="w-60 text-sm text-muted-foreground">
                  {description}
                </p>
              </>
            )}
          </div>
          {!isLoading && children}
        </div>
      </div>
    </div>
  );
}
