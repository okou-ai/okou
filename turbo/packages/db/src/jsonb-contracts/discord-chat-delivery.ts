export interface DiscordChatDeliveryPart {
  readonly content: string;
  readonly nonce: string;
  readonly attemptedAt: string | null;
  readonly messageId: string | null;
}

export type DiscordChatDeliveryParts = readonly DiscordChatDeliveryPart[];
