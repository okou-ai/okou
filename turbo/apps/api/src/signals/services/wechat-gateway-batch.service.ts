import { command } from "ccstate";
import type { wechatConnections } from "@okouai/db/schema/wechat";
import type { WechatMessage } from "@okouai/api-contracts/contracts/wechat-protocol";
import { logger } from "../../lib/log";
import { settle } from "../utils";
import { receiveWechatMessage$ } from "./wechat-ingress.service";
import { sendWechatReconnectNotice$ } from "./wechat-notice.service";

const log = logger("api:wechat:gateway");
export const dispatchWechatBatch$ = command(
  async (
    { set },
    args: {
      connection: typeof wechatConnections.$inferSelect;
      messages: readonly WechatMessage[];
    },
    signal: AbortSignal,
  ) => {
    for (const message of args.messages) {
      const notice = await settle(
        set(
          sendWechatReconnectNotice$,
          { connection: args.connection, message },
          signal,
        ),
        signal,
      );
      if (!notice.ok) {
        log.warn("WeChat notice failed", { error: notice.error });
      }
      if (args.connection.status === "active") {
        await set(
          receiveWechatMessage$,
          { connection: args.connection, message },
          signal,
        );
      }
    }
  },
);
