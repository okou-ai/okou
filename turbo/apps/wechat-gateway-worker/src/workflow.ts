import { setTimeout } from "node:timers/promises";
import { object, string, uuid } from "zod";
import { wechatReceiverContract as contract } from "@okouai/api-contracts/contracts/integrations-wechat";
import { wechatUpdatesSchema } from "@okouai/api-contracts/contracts/wechat-protocol";
import {
  getWechatUpdates,
  WechatSessionExpiredError,
} from "@okouai/core/wechat-client";
import { signature } from "./auth";
import { decodePendingBatch } from "./pending";
import { unseal } from "./crypto";
import {
  BLOCK_MS,
  type Env,
  type ReceiverParams,
  type ReceiverState,
} from "./types";
const sessionSchema = object({
  generation: uuid(),
  baseUrl: string(),
  token: string(),
});
async function api(
  env: Env,
  path: string,
  value: unknown,
  signal: AbortSignal,
) {
  const origin = new URL(env.API_ORIGIN);
  if (origin.protocol !== "https:" || origin.origin !== env.API_ORIGIN)
    throw new Error("API_ORIGIN must be an HTTPS origin");
  const body = JSON.stringify(value);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(new URL(path, origin), {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/json",
      "x-wechat-timestamp": timestamp,
      "x-wechat-signature": await signature(
        env.WECHAT_GATEWAY_SECRET,
        `${timestamp}.${body}`,
      ),
    },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(80_000)]),
  });
  if (!response.ok)
    throw new Error(`WeChat receiver API returned ${response.status}`);
  return response.json();
}
export async function receiveWechatBlock(env: Env, params: ReceiverParams) {
  const { connectionId, ownerId } = params;
  const actor = env.WECHAT_RECEIVER.get(
    env.WECHAT_RECEIVER.idFromName(connectionId),
  );
  const previous = await actor.open(ownerId);
  if (!previous) return false;
  const until = Date.now() + BLOCK_MS;
  const signal = AbortSignal.timeout(BLOCK_MS + 50_000);
  const bootstrap = contract.bootstrap.responses[200].parse(
    await api(
      env,
      contract.bootstrap.path,
      { connectionId, generation: previous.generation },
      signal,
    ),
  );
  if (!bootstrap.active) {
    await actor.finish(ownerId, false);
    return false;
  }
  let state: ReceiverState | null = await actor.renew(
    ownerId,
    bootstrap.session
      ? new Response(
          JSON.stringify({
            ...bootstrap.session,
            generation: bootstrap.generation,
          }),
        ).body
      : null,
  );
  if (!state?.session) return false;
  const session = sessionSchema.parse(
    await unseal(
      env.WECHAT_RECEIVER_ENCRYPTION_KEY,
      connectionId,
      state.session,
    ),
  );
  // Flush messages immediately; the one-second gap applies to the next poll.
  // Bound burst traffic below the per-instance subrequest budget.
  let nextPollAt = Date.now();
  for (
    let polls = 0;
    state && (state.pending || (Date.now() < until && polls < 250));
  ) {
    if (state.pending) {
      const stream = await actor.readPending(ownerId);
      if (!stream) return false;
      const updates = wechatUpdatesSchema.parse(
        await decodePendingBatch(
          env.WECHAT_RECEIVER_ENCRYPTION_KEY,
          connectionId,
          stream,
        ),
      );
      const result = contract.deliver.responses[200].parse(
        await api(
          env,
          contract.deliver.path,
          { connectionId, generation: session.generation, updates },
          signal,
        ),
      );
      if (!result.active || result.refresh) {
        await actor.finish(ownerId, !!result.refresh);
        return false;
      }
      if (result.retryAfterMs) {
        await setTimeout(result.retryAfterMs, undefined, { signal });
        state = await actor.open(ownerId);
        continue;
      }
      state = await actor.acknowledge(ownerId, state.pending.id);
      continue;
    }
    await setTimeout(Math.max(0, nextPollAt - Date.now()), undefined, {
      signal,
    });
    try {
      const updates = await getWechatUpdates(
        session.baseUrl,
        session.token,
        state.cursor,
        signal,
      );
      state = await actor.checkpoint(
        ownerId,
        state.cursor,
        updates ? new Response(JSON.stringify(updates)).body : null,
      );
      nextPollAt = Date.now() + 1_000;
      polls++;
    } catch (error) {
      if (!(error instanceof WechatSessionExpiredError)) throw error;
      if (!(await actor.open(ownerId))) return false;
      const result = contract.expire.responses[200].parse(
        await api(
          env,
          contract.expire.path,
          { connectionId, generation: session.generation },
          signal,
        ),
      );
      await actor.finish(ownerId, !!result.refresh);
      return false;
    }
  }
  if (state)
    await setTimeout(Math.max(0, nextPollAt - Date.now()), undefined, {
      signal,
    });
  return state !== null;
}
