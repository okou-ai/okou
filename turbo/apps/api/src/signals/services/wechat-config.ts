import { clerk$, isClerkResourceNotFound } from "../external/clerk";
import { settle } from "../utils";
import { command, computed, type Computed } from "ccstate";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { env } from "../../lib/env";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
export const loadWechatWorkspace$ = command(
  async ({ get }, orgId: string, signal: AbortSignal) => {
    const result = await settle(
      get(clerk$).organizations.getOrganization(
        { organizationId: orgId },
        undefined,
        signal,
      ),
      signal,
    );
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return null;
      }
      throw result.error;
    }
    return { id: result.value.id, name: result.value.name };
  },
);
export const wechatEnabled$ = command(
  async ({ get, set }, orgId: string, userId: string, signal: AbortSignal) => {
    if (
      !isFeatureEnabled(
        FeatureSwitchKey.WechatIntegration,
        await set(loadUserFeatureSwitchContext$, orgId, userId, signal),
      )
    ) {
      return false;
    }

    const result = await settle(
      get(clerk$).organizations.getOrganizationMembershipList({
        organizationId: orgId,
        userId: [userId],
        limit: 1,
      }),
    );

    signal.throwIfAborted();
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return false;
      }
      throw result.error;
    }
    return result.value.data.some((member) => {
      return member.publicUserData?.userId === userId;
    });
  },
);
export function wechatConfigured() {
  return !!(
    env("WECHAT_GATEWAY_URL") &&
    env("WECHAT_GATEWAY_SECRET") &&
    env("WECHAT_GATEWAY_CONTROL_SECRET")
  );
}
export function startWechatPoller(
  connectionId: string,
  generation: string,
  signal: AbortSignal,
) {
  return controlWechatPoller("/start", { connectionId, generation }, signal);
}
export function stopWechatPoller(connectionId: string, signal: AbortSignal) {
  return controlWechatPoller("/stop", { connectionId }, signal);
}
async function controlWechatPoller(
  path: string,
  body: unknown,
  signal: AbortSignal,
) {
  const url = env("WECHAT_GATEWAY_URL");
  const secret = env("WECHAT_GATEWAY_CONTROL_SECRET");
  if (!url || !secret) {
    throw new Error("WeChat receiver is not configured");
  }
  const response = await fetch(new URL(path, url), {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    throw new Error("WeChat receiver is unavailable");
  }
}

export function createWechatMembership(
  identity$: Computed<Promise<{ orgId: string; userId: string } | null>>,
) {
  return computed(async (get) => {
    const identity = await get(identity$);
    if (!identity) {
      return false;
    }
    const result = await settle(
      get(clerk$).organizations.getOrganizationMembershipList({
        organizationId: identity.orgId,
        userId: [identity.userId],
        limit: 1,
      }),
    );
    if (!result.ok) {
      if (isClerkResourceNotFound(result.error)) {
        return false;
      }
      throw result.error;
    }
    return result.value.data.some((member) => {
      return member.publicUserData?.userId === identity.userId;
    });
  });
}
