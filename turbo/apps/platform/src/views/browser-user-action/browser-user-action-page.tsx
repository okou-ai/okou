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
    <main className="fixed inset-0 flex h-viewport max-h-viewport min-h-viewport flex-col items-center overflow-y-auto bg-background pt-safe-offset-8 pr-safe-offset-4 pb-safe-offset-8 pl-safe-offset-4">
      <div className="my-auto flex w-[540px] max-w-full shrink-0 flex-col items-center gap-5">
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
