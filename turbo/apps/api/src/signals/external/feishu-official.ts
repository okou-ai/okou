import { command } from "ccstate";
import { eq } from "drizzle-orm";
import { number, object, string } from "zod";
import { feishuOfficialAppTickets } from "@okouai/db/schema/feishu-official-app-ticket";
import { feishuOfficialApp } from "../../lib/feishu-official-app";
import { db$ } from "./db";
import { decryptPersistentSecretValue } from "../services/crypto.utils";

const appTokenSchema = object({
  code: number(),
  app_access_token: string().min(1).optional(),
});
const tenantTokenSchema = object({
  code: number(),
  tenant_access_token: string().min(1).optional(),
  expire: number().positive().optional(),
});

export const fetchOfficialFeishuTenantToken$ = command(
  async ({ get }, tenantKey: string, signal: AbortSignal) => {
    const config = feishuOfficialApp();
    if (!config) {
      throw new Error("Okou Official Feishu bot is not configured");
    }
    const [ticket] = await get(db$)
      .select({ encryptedTicket: feishuOfficialAppTickets.encryptedTicket })
      .from(feishuOfficialAppTickets)
      .where(eq(feishuOfficialAppTickets.appId, config.appId))
      .limit(1);
    signal.throwIfAborted();
    if (!ticket) {
      throw new Error(
        "Okou Official Feishu bot has not received an app_ticket",
      );
    }
    const appTicket = await decryptPersistentSecretValue(
      ticket.encryptedTicket,
      {},
    );
    signal.throwIfAborted();
    const appResponse = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/app_access_token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_id: config.appId,
          app_secret: config.appSecret,
          app_ticket: appTicket,
        }),
        signal,
      },
    );
    if (!appResponse.ok) {
      throw new Error("Official Feishu app token request failed");
    }
    const appToken = appTokenSchema.parse(await appResponse.json());
    if (appToken.code !== 0 || !appToken.app_access_token) {
      throw new Error(`Official Feishu app token rejected (${appToken.code})`);
    }
    const response = await fetch(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          app_access_token: appToken.app_access_token,
          tenant_key: tenantKey,
        }),
        signal,
      },
    );
    if (!response.ok) {
      throw new Error("Official Feishu tenant token request failed");
    }
    const token = tenantTokenSchema.parse(await response.json());
    if (token.code !== 0 || !token.tenant_access_token || !token.expire) {
      throw new Error(`Official Feishu tenant token rejected (${token.code})`);
    }
    return { token: token.tenant_access_token, expiresInSeconds: token.expire };
  },
);
