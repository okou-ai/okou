import { useTranslation } from "react-i18next";

import type { MailDraftSignals } from "../../signals/chat-page/mail-draft.ts";
import { AttachmentLightbox } from "../okou-page/attachment-chips.tsx";
import { ProductBrandMarkLink } from "../okou-page/directed-shared.tsx";
import { MailDraftPanel } from "../okou-page/mail-draft-panel.tsx";

export function MailDraftPage({
  signals,
}: {
  readonly signals: MailDraftSignals | null;
}) {
  const { t } = useTranslation();
  return (
    <main className="fixed inset-0 box-border flex h-viewport max-h-viewport min-h-viewport flex-col overflow-hidden bg-background p-safe">
      <header className="flex h-14 shrink-0 items-center border-b border-border/60 px-5">
        <ProductBrandMarkLink />
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
