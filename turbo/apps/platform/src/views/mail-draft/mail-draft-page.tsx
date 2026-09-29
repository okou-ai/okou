import { useTranslation } from "react-i18next";
import { buttonVariants } from "@okouai/ui";

import type { MailDraftSignals } from "../../signals/chat-page/mail-draft.ts";
import { ProductBrandMark } from "../components/product-brand-mark.tsx";
import { AttachmentLightbox } from "../okou-page/attachment-chips.tsx";
import { MailDraftPanel } from "../okou-page/mail-draft-panel.tsx";
import { Link } from "../router/link.tsx";

export function MailDraftPage({
  signals,
}: {
  readonly signals: MailDraftSignals | null;
}) {
  const { t } = useTranslation();
  return (
    <main className="fixed inset-0 box-border flex h-viewport max-h-viewport min-h-viewport flex-col overflow-hidden bg-background p-safe">
      <header className="flex h-14 shrink-0 items-center border-b border-border/60 px-2">
        <Link
          pathname="/"
          className={buttonVariants({ variant: "quiet", size: "sm" })}
        >
          <ProductBrandMark size="compact" />
        </Link>
      </header>
      <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-hidden sm:my-6 sm:rounded-xl sm:border sm:border-border/60">
        {signals ? (
          <MailDraftPanel signals={signals} />
        ) : (
          <div className="flex flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {t(($) => {
              return $.chat.mail.unavailable;
            })}
          </div>
        )}
      </div>
      <AttachmentLightbox />
    </main>
  );
}
