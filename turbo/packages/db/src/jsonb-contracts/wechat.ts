/** Public attachment metadata; provider URLs and encryption keys are stored separately. */
export interface WechatAttachment {
  readonly id: string;
  readonly kind: "image" | "audio" | "video" | "file";
  readonly filename: string;
  readonly size: number | null;
}
