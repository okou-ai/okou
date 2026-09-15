import type {
  SharedMessage,
  SharedMessageAttachment,
} from "@okouai/api-contracts/contracts/shared-threads";

export type SharedThreadMessages = Omit<SharedMessage, "attachments">[];

export type SharedThreadMessageAttachments = Partial<
  Record<number, readonly SharedMessageAttachment[]>
>;
