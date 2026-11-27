import { command, computed } from "ccstate";
import { integrationsWechatContract } from "@okouai/api-contracts/client/integrations-wechat";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { authenticatedIdentity$, currentOrgInfo$ } from "../auth.ts";
import { featureSwitches$ } from "../external/feature-switch.ts";
import { replaceSearchParams$, searchParams$ } from "../route.ts";
import { refreshWechat$, wechatStatus$ } from "./wechat.ts";

export const wechatConnectPageStatus$ = computed(async (get) => {
  const token = get(searchParams$).get("token");
  if (!(await get(featureSwitches$))[FeatureSwitchKey.WechatIntegration]) {
    return { kind: "disabled" } as const;
  }
  const identity = await get(authenticatedIdentity$);
  if (token !== null) {
    if (!token || token.length > 1024) {
      return { kind: "invalid" } as const;
    }
    const client = get(apiClient$)(integrationsWechatContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.reconnectStatus({ headers: {}, query: { token } }),
      [200],
    );
    if (!result.body.available) {
      return { kind: "invalid" } as const;
    }
    const org = await get(currentOrgInfo$);
    return {
      kind: "reconnect",
      account: identity.email ?? identity.userId,
      workspace: org?.name,
    } as const;
  }
  return { kind: "overview", data: await get(wechatStatus$) } as const;
});

export const reconnectWechat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const token = get(searchParams$).get("token");
    if (!token) {
      throw new Error("Missing WeChat reconnect link");
    }
    const client = get(apiClient$)(integrationsWechatContract, {
      apiBase: "api",
    });
    await accept(
      client.reconnect({
        headers: {},
        body: { token },
        fetchOptions: { signal },
      }),
      [204],
      signal,
    );
    signal.throwIfAborted();
    await set(refreshWechat$, signal);
    signal.throwIfAborted();
    const params = new URLSearchParams(get(searchParams$));
    params.delete("token");
    set(replaceSearchParams$, params);
  },
);
