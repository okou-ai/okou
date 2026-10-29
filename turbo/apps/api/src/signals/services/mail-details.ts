import type {
  MailAttachment,
  MailInlineImage,
} from "@okouai/api-contracts/contracts/mail";

export interface MailDetails {
  readonly from: string;
  readonly fromName?: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly body: string;
  readonly bodyHtml?: string;
  readonly inlineImages?: readonly MailInlineImage[];
  readonly replyTo?: string;
  readonly inReplyTo?: string;
  readonly references: readonly string[];
  readonly attachments: readonly MailAttachment[];
}

export interface MailDraftValue {
  readonly draftId: string;
  readonly messageId: string;
  readonly threadId: string;
  readonly details: MailDetails;
  readonly webLink?: string;
}
