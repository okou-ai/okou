import { now } from "../../lib/time.ts";
import { command, computed, state } from "ccstate";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { integrationsWechatContract } from "@okouai/api-contracts/client/integrations-wechat";
import type {
  WechatAttempt,
  WechatPollStatus,
} from "@okouai/api-contracts/contracts/integrations-wechat";
import { apiClient$ } from "../api-client.ts";
import { featureSwitch$ } from "../external/feature-switch.ts";
import { runtimeAuthenticatedIdentity$ } from "../auth-context.ts";
import { accept } from "../../lib/accept.ts";
import { resetSignal, waitLoopUntil } from "../utils.ts";
const reload$ = state(0);
const flow$ = state<{
  open: boolean;
  attempt: WechatAttempt | null;
  status: WechatPollStatus;
}>({ open: false, attempt: null, status: "waiting" });
const code$ = state("");
const resetFlow$ = resetSignal();
export const wechatFlow$ = computed((get) => {
  return get(flow$);
});
export const wechatCode$ = computed((get) => {
  return get(code$);
});
export const setWechatCode$ = command(({ set }, code: string) => {
  return set(code$, code);
});
export const wechatStatus$ = computed(async (get) => {
  if (!get(featureSwitch$)[FeatureSwitchKey.WechatIntegration]) {
    return null;
  }
  get(reload$);
  await get(runtimeAuthenticatedIdentity$);
  const client = get(apiClient$)(integrationsWechatContract, {
    apiBase: "api",
  });
  return (await accept(client.status({ headers: {} }), [200])).body;
});
export const refreshWechat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    set(reload$, (n) => {
      return n + 1;
    });
    await get(wechatStatus$);
    signal.throwIfAborted();
  },
);
const poll$ = command(
  async (
    { get, set },
    attempt: WechatAttempt,
    verifyCode: string | undefined,
    signal: AbortSignal,
  ) => {
    const client = get(apiClient$)(integrationsWechatContract, {
      apiBase: "api",
    });
    let pendingCode = verifyCode;
    await waitLoopUntil(
      async () => {
        if (now() >= Date.parse(attempt.expiresAt)) {
          set(flow$, { open: true, attempt, status: "expired" });
          return true;
        }
        const response = await accept(
          client.poll({
            headers: {},
            body: {
              id: attempt.id,
              ...(pendingCode ? { verifyCode: pendingCode } : {}),
            },
            fetchOptions: { signal },
          }),
          [200],
          signal,
        );
        signal.throwIfAborted();
        pendingCode = undefined;
        const status = response.body.status;
        set(flow$, { open: status !== "connected", attempt, status });
        if (status === "connected") {
          await set(refreshWechat$, signal);
          return true;
        }
        return status !== "waiting" && status !== "scanned";
      },
      1000,
      signal,
    );
    signal.throwIfAborted();
  },
);
const startWechatConnect$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const flowSignal = set(resetFlow$, signal);
    set(code$, "");
    set(flow$, { open: true, attempt: null, status: "waiting" });
    const client = get(apiClient$)(integrationsWechatContract, {
      apiBase: "api",
    });
    const result = await accept(
      client.connect({ headers: {}, fetchOptions: { signal: flowSignal } }),
      [200],
      flowSignal,
    );
    signal.throwIfAborted();
    flowSignal.throwIfAborted();
    const attempt = result.body;
    set(flow$, { open: true, attempt, status: "waiting" });
    await set(poll$, attempt, undefined, flowSignal);
  },
);
const verifyWechat$ = command(async ({ get, set }, signal: AbortSignal) => {
  const attempt = get(flow$).attempt;
  if (!attempt) {
    return;
  }
  const code = get(code$);
  set(code$, "");
  const flowSignal = set(resetFlow$, signal);
  await set(poll$, attempt, code, flowSignal);
});
export const connectWechat$ = command(
  async ({ set }, action: "start" | "verify", signal: AbortSignal) => {
    await set(action === "start" ? startWechatConnect$ : verifyWechat$, signal);
  },
);
export const closeWechat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const attempt = get(flow$).attempt;
    set(resetFlow$, signal);
    set(flow$, { open: false, attempt: null, status: "waiting" });
    set(code$, "");
    if (attempt) {
      const client = get(apiClient$)(integrationsWechatContract, {
        apiBase: "api",
      });
      await accept(
        client.cancel({
          headers: {},
          body: { id: attempt.id },
          fetchOptions: { signal },
        }),
        [204],
        signal,
      );
    }
  },
);
export const disconnectWechat$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    await set(closeWechat$, signal);
    const client = get(apiClient$)(integrationsWechatContract, {
      apiBase: "api",
    });
    await accept(
      client.disconnect({ headers: {}, fetchOptions: { signal } }),
      [204],
      signal,
    );
    await set(refreshWechat$, signal);
  },
);
export const initWechat$ = command(({ set }) => {
  set(flow$, { open: false, attempt: null, status: "waiting" });
  set(code$, "");
  set(reload$, (n) => {
    return n + 1;
  });
});
