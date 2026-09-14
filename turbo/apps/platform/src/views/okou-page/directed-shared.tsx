import type { ReactNode } from "react";
import { useGet, useSet } from "ccstate-react";
import { Loader2 } from "lucide-react";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { AppPageRoot } from "../components/app-page-root.tsx";
import { Link } from "../router/link.tsx";
import { CreditPurchaseConfirmDialog } from "./components/org-manage/credit-purchase-confirm-dialog.tsx";
import { SubscriptionPurchaseConfirmDialog } from "./components/org-manage/subscription-purchase-confirm-dialog.tsx";
import { SettingsDialogMount } from "./components/settings/settings-dialog.tsx";
import { featureSwitch$ } from "../../signals/external/feature-switch.ts";
import {
  colorTheme$,
  shellDocumentAttributesRef$,
} from "../../signals/theme.ts";

export function StandaloneLayout({ children }: { children: ReactNode }) {
  const colorTheme = useGet(colorTheme$);
  const features = useGet(featureSwitch$);
  const gradientColorThemesEnabled =
    features[FeatureSwitchKey.GradientColorThemes] ?? false;
  const shellDocumentAttributesRef = useSet(shellDocumentAttributesRef$);

  return (
    <AppPageRoot
      ref={shellDocumentAttributesRef}
      className="okou-app flex w-full flex-col bg-background"
      data-gradient-color-themes={gradientColorThemesEnabled || undefined}
      data-color-theme={gradientColorThemesEnabled ? colorTheme : undefined}
    >
      <SettingsDialogMount />
      <CreditPurchaseConfirmDialog />
      <SubscriptionPurchaseConfirmDialog />
      {children}
    </AppPageRoot>
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
