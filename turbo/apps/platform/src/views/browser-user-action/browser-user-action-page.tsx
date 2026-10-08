import { useGet } from "ccstate-react";

import { browserUserActionPageSignals$ } from "../../signals/browser-user-action/browser-user-action-page-state.ts";
import {
  BrowserUserActionCard,
  BrowserUserActionUnavailableCard,
} from "../okou-page/browser-user-action-card.tsx";
import { ProductBrandMarkLink } from "../okou-page/directed-shared.tsx";

export function BrowserUserActionPage() {
  const signals = useGet(browserUserActionPageSignals$);
  return (
    <main className="fixed inset-0 z-10 flex h-viewport max-h-viewport min-h-viewport items-center justify-center overflow-y-auto bg-background p-safe px-4 py-8">
      <div className="flex w-[540px] max-w-full flex-col items-center gap-5">
        <ProductBrandMarkLink />
        {signals ? (
          <BrowserUserActionCard signals={signals} variant="standalone" />
        ) : (
          <BrowserUserActionUnavailableCard variant="standalone" />
        )}
      </div>
    </main>
  );
}
