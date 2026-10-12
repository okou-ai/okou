import { z } from "zod";
import { notifyMailBodySchema } from "@okouai/api-contracts/contracts/notifications";

export const debugMorningBriefEmailTemplateSchema = z
  .object({
    template: z.literal("debug-morning-brief"),
    props: z
      .object({
        subject: notifyMailBodySchema.shape.subject,
        text: notifyMailBodySchema.shape.text,
        runUrl: z.url().max(1024),
        manageUrl: z.url().max(1024),
      })
      .strict(),
  })
  .strict();

export const DEBUG_MORNING_BRIEF_EMAIL_SUBJECT = "[Test] Morning Brief";
export const DEBUG_MORNING_BRIEF_EMAIL_TEXT = `This is a sample email sent from **Settings → Debug**. It uses the Morning Brief presentation and delivery service. No Agent or automation was run, and your Morning Brief schedule has not changed.

## Example priorities

- **Team sync at 09:30** — Review today's priorities and unblock the next delivery.
- **Pull request review** — Check the changes waiting for your feedback.
- **Follow-up** — Confirm the decisions and next actions from yesterday.

## Check this email

Check the artwork, headings, lists and links in your mail client. **Open in Okou** opens the app; **Manage** opens your Morning Brief preferences. The unsubscribe controls use your real account preferences.

These priorities are examples, not information read from your connected accounts.`;
