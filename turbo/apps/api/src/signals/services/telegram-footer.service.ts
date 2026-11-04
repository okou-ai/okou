import { computed } from "ccstate";
import { and, eq } from "drizzle-orm";
import { telegramOfficialUserLinks } from "@okouai/db/schema/telegram-official-user-link";
import { db$ } from "../external/db";
import { escapeHtml } from "../../lib/telegram-format";
import { appendIntegrationMessageFooter } from "../../lib/integration-message-footer";
import {
  integrationMessageSendLabels$,
  integrationMessageSendUserLabel$,
  integrationMessageSendFooterText,
} from "./integration-message-context.service";

export const telegramMessageSendFooterText$ = computed(async (get) => {
  const labels = await get(integrationMessageSendLabels$);
  if (!labels.runOwner) {
    return undefined;
  }
  const [sender] = await get(db$)
    .select({
      id: telegramOfficialUserLinks.telegramUserId,
      name: telegramOfficialUserLinks.telegramDisplayName,
    })
    .from(telegramOfficialUserLinks)
    .where(
      and(
        eq(telegramOfficialUserLinks.userId, labels.runOwner.userId),
        eq(telegramOfficialUserLinks.orgId, labels.runOwner.orgId),
      ),
    )
    .limit(1);
  const name =
    sender?.name?.trim().replace(/\s+/gu, " ") ||
    (await get(integrationMessageSendUserLabel$));
  return integrationMessageSendFooterText({
    agentLabel: labels.agentLabel ? escapeHtml(labels.agentLabel) : undefined,
    userLabel:
      sender && name
        ? `<a href="tg://user?id=${encodeURIComponent(sender.id)}">${escapeHtml(name)}</a>`
        : name
          ? escapeHtml(name)
          : undefined,
  });
});

export function telegramMessageSendCaption(
  caption: string | undefined,
  footerText: string | undefined,
): { readonly caption: string | undefined; readonly parseMode?: "HTML" } {
  return footerText
    ? {
        caption: appendIntegrationMessageFooter(
          caption ? escapeHtml(caption) : undefined,
          `<i>${footerText}</i>`,
          1024,
        ),
        parseMode: "HTML",
      }
    : { caption };
}
