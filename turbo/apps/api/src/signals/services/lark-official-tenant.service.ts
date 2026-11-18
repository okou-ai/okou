import { command } from "ccstate";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { feishuOrgInstallations } from "@okouai/db/schema/feishu-org-installation";
import { larkOfficialApp } from "../../lib/lark-official-app";
import { isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { fetchOfficialLarkTenantToken$ } from "../external/lark-official";
import { fetchFeishuBotInfo } from "../external/feishu-client";
import { encryptPersistentSecretValue } from "./crypto.utils";
import { settle } from "../utils";

// The tenant comes only from the user's verified Lark OAuth profile. Neither
// the browser nor the first incoming group message may choose a workspace tenant.
export const bindOfficialLarkTenant$ = command(
  async (
    { set },
    args: {
      readonly installationId: string;
      readonly orgId: string;
      readonly appId: string;
      readonly tenantKey: string;
    },
    signal: AbortSignal,
  ) => {
    const config = larkOfficialApp();
    if (!config || config.appId !== args.appId) {
      return false;
    }
    const token = await set(
      fetchOfficialLarkTenantToken$,
      args.tenantKey,
      signal,
    );
    const bot = await fetchFeishuBotInfo(
      { tenantAccessToken: token.token, platform: "lark" },
      signal,
    );
    const encryptedTenantAccessToken = await encryptPersistentSecretValue(
      token.token,
      { orgId: args.orgId },
      signal,
    );
    signal.throwIfAborted();
    const result = await settle(
      set(writeDb$)
        .update(feishuOrgInstallations)
        .set({
          feishuTenantKey: args.tenantKey,
          botOpenId: bot.openId,
          botName: "Okou Official",
          botAvatarUrl: bot.avatarUrl,
          encryptedTenantAccessToken,
          tenantAccessTokenExpiresAt: new Date(
            nowDate().getTime() + token.expiresInSeconds * 1000,
          ),
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(feishuOrgInstallations.id, args.installationId),
            eq(feishuOrgInstallations.orgId, args.orgId),
            eq(feishuOrgInstallations.installationType, "official"),
            eq(feishuOrgInstallations.platform, "lark"),
            eq(feishuOrgInstallations.appId, config.appId),
            isNotNull(feishuOrgInstallations.setupCompletedAt),
            or(
              isNull(feishuOrgInstallations.feishuTenantKey),
              eq(feishuOrgInstallations.feishuTenantKey, args.tenantKey),
            ),
          ),
        )
        .returning({ id: feishuOrgInstallations.id }),
      signal,
    );
    if (!result.ok) {
      if (
        isUniqueViolation(
          result.error,
          "idx_feishu_org_installations_official_tenant",
        )
      ) {
        return false;
      }
      throw result.error;
    }
    return result.value.length > 0;
  },
);
