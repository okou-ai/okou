import type { WechatReceiver } from "./index";
import type { z } from "zod";
import type { wechatUpdatesSchema } from "@okouai/api-contracts/contracts/wechat-protocol";
export interface Env {
  readonly WECHAT_RECEIVER: DurableObjectNamespace<WechatReceiver>;
  readonly WECHAT_POLL_WORKFLOW: Workflow<ReceiverParams>;
  readonly WECHAT_GATEWAY_ENABLED: string;
  readonly WECHAT_GATEWAY_CONTROL_SECRET: string;
  readonly WECHAT_GATEWAY_SECRET: string;
  readonly WECHAT_RECEIVER_ENCRYPTION_KEY: string;
  readonly API_ORIGIN: string;
}
export interface ReceiverParams {
  readonly connectionId: string;
  readonly ownerId: string;
}
export interface EncryptedValue {
  readonly iv: string;
  readonly data: string;
}
export type Updates = z.infer<typeof wechatUpdatesSchema>;
export interface Pending {
  readonly id: string;
  readonly parts: number;
}
export interface ReceiverState {
  readonly ownerId: string;
  readonly leaseUntil: number;
  readonly started: boolean;
  readonly generation?: string;
  readonly session?: EncryptedValue;
  readonly cursor: string;
  readonly pending?: Pending;
}
// Allows a ten-minute receive step to finish its last poll and API delivery.
export const LEASE_MS = 12 * 60_000;
export const BLOCK_MS = 10 * 60_000;
