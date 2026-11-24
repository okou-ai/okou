import { snapshotDataDescription } from "./computer-use-snapshot-sdp";
import { command } from "ccstate";
import { decryptSecretValue, encryptSecretValue } from "./crypto.utils";
import { safeSync, settleIncludingAbort } from "../utils";
import { and, eq, gte, inArray, isNull, isNotNull, sql } from "drizzle-orm";
import { array, object, string } from "zod";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { isStaffOrg } from "@okouai/core/staff-org";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { computerUseHosts } from "@okouai/db/runtime/computer-use-host";
import { computerUseCommands } from "@okouai/db/schema/computer-use-host";
import type { ComputerUseSnapshotSignal } from "@okouai/api-contracts/contracts/computer-use";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";

interface Owner {
  readonly userId: string;
  readonly orgId: string;
  readonly hostId: string;
}
type Peer = Owner & { readonly commandId: string } & (
    | {
        readonly role: "receiver";
        readonly runId: string;
        readonly answer?: string;
      }
    | {
        readonly role: "sender";
        readonly connectionGeneration: number;
        readonly sessionId: string;
        readonly offer?: string;
        readonly ice?: boolean;
      }
  );

export function snapshotSessionId(
  run: string,
  host: string,
  generation: number,
  mode: "auto" | "relay",
) {
  return [run, host, generation, mode].join(".");
}

// Check current ownership independently of the capability captured at Run creation.
export const snapshotRunAccess$ = command(
  async (
    { get, set },
    owner: Owner & {
      readonly runId: string;
      readonly connectionGeneration?: number;
    },
    signal: AbortSignal,
  ) => {
    if (!isStaffOrg(owner.orgId)) {
      return "denied";
    }
    const [active] = await get(db$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
      .innerJoin(
        computerUseHosts,
        eq(computerUseHosts.id, chatThreads.computerUseHostId),
      )
      .where(
        and(
          eq(agentRuns.id, owner.runId),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.status, "running"),
          isNull(agentRuns.runnerCancellationMode),
          eq(chatThreads.orgId, owner.orgId),
          eq(chatThreads.userId, owner.userId),
          eq(computerUseHosts.id, owner.hostId),
          eq(computerUseHosts.orgId, owner.orgId),
          eq(computerUseHosts.userId, owner.userId),
          isNull(computerUseHosts.revokedAt),
          ...(owner.connectionGeneration === undefined
            ? []
            : [
                eq(
                  computerUseHosts.connectionGeneration,
                  owner.connectionGeneration,
                ),
                eq(computerUseHosts.status, "online"),
              ]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!active) {
      return "denied";
    }
    const context = await set(
      loadUserFeatureSwitchContext$,
      owner.orgId,
      owner.userId,
      signal,
    );
    return isFeatureEnabled(
      FeatureSwitchKey.ComputerUseWebRtcSnapshots,
      context,
    )
      ? "enabled"
      : "disabled";
  },
);

interface SnapshotHost {
  readonly id: string;
  readonly userId: string;
  readonly orgId: string;
  readonly connectionGeneration: number;
  readonly supportedCapabilities: readonly string[];
}

export const snapshotSessionForCapture$ = command(
  async (
    { set },
    host: SnapshotHost,
    capture: {
      readonly runId?: string | null;
      readonly kind: string;
      readonly snapshotReceiver?: "auto" | "relay";
    },
    signal: AbortSignal,
  ) => {
    const { runId, kind, snapshotReceiver: mode } = capture;
    if (
      !mode ||
      !runId ||
      kind !== "app.state" ||
      !host.supportedCapabilities.includes("snapshots.webrtc.v1")
    ) {
      return undefined;
    }
    const access = await set(
      snapshotRunAccess$,
      { ...host, hostId: host.id, runId },
      signal,
    );
    return access === "enabled"
      ? snapshotSessionId(runId, host.id, host.connectionGeneration, mode)
      : undefined;
  },
);

export const snapshotClaimEnabled$ = command(
  async (
    { set },
    host: SnapshotHost,
    command: {
      readonly kind: string;
      readonly runId: string | null;
      readonly payload: Record<string, unknown>;
    },
    signal: AbortSignal,
  ) => {
    const session = command.payload.snapshotSession;
    if (typeof session !== "string") {
      return false;
    }
    const mode = session.endsWith(".relay") ? "relay" : "auto";
    return (
      session ===
      (await set(
        snapshotSessionForCapture$,
        host,
        { ...command, snapshotReceiver: mode },
        signal,
      ))
    );
  },
);

export const snapshotResultAccess$ = command(
  async (
    { set },
    caller: {
      readonly orgId: string;
      readonly userId: string;
      readonly hostId?: string;
      readonly runId?: string;
    },
    command: {
      readonly payload: Record<string, unknown>;
      readonly runId: string | null;
      readonly hostId: string;
    },
    signal: AbortSignal,
  ) => {
    if (!caller.hostId || typeof command.payload.snapshotSession !== "string") {
      return "ordinary";
    }
    if (!caller.runId || caller.runId !== command.runId) {
      return "denied";
    }
    return await set(
      snapshotRunAccess$,
      { ...caller, hostId: command.hostId, runId: caller.runId },
      signal,
    );
  },
);

const STUN_URL = "stun:stun.cloudflare.com:3478";
const turnResponse = object({
  iceServers: array(
    object({
      urls: array(string()),
      username: string().optional(),
      credential: string().optional(),
    }),
  ),
});

// These credentials authorize relay allocations and must stay outside the Guest.
// A missing or unavailable relay still permits a direct-path experiment.
async function hostIceServers(signal: AbortSignal) {
  const key = env("COMPUTER_USE_TURN_KEY_ID");
  const token = env("COMPUTER_USE_TURN_API_TOKEN");
  if (!key || !token) {
    return [{ urls: [STUN_URL] }];
  }
  const request = await settleIncludingAbort(async () => {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(key)}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]),
        body: JSON.stringify({ ttl: 120 }),
      },
    );
    if (!response.ok) {
      return [{ urls: [STUN_URL] }];
    }
    const result = turnResponse.safeParse(await response.json());
    return result.success ? result.data.iceServers : [{ urls: [STUN_URL] }];
  });
  signal.throwIfAborted();
  return request.ok ? request.value : [{ urls: [STUN_URL] }];
}

function snapshotSignalScope(peer: Peer) {
  const commands = computerUseCommands;
  return and(
    eq(commands.id, peer.commandId),
    eq(commands.orgId, peer.orgId),
    eq(commands.userId, peer.userId),
    eq(commands.hostId, peer.hostId),
    eq(commands.kind, "app.state"),
    ...(peer.role === "receiver"
      ? [eq(commands.runId, peer.runId)]
      : [eq(commands.claimedConnectionGeneration, peer.connectionGeneration)]),
    inArray(commands.status, ["queued", "running", "succeeded"]),
    gte(commands.createdAt, new Date(nowDate().getTime() - 30_000)),
  );
}

const issueMacIceServers$ = command(
  async (
    { set },
    peer: Extract<Peer, { role: "sender" }>,
    runId: string,
    signal: AbortSignal,
  ) => {
    const commands = computerUseCommands;
    const scope = snapshotSignalScope(peer);
    // Reserve issuance once even under concurrent or retried requests.
    const [reserved] = await set(writeDb$)
      .update(commands)
      .set({ snapshotOffer: "" })
      .where(and(scope, isNull(commands.snapshotOffer)))
      .returning({ id: commands.id });
    signal.throwIfAborted();
    if (!reserved) {
      return null;
    }
    const iceServers = await hostIceServers(signal);
    if (
      (await set(
        snapshotRunAccess$,
        { ...peer, runId, connectionGeneration: peer.connectionGeneration },
        signal,
      )) !== "enabled"
    ) {
      return null;
    }
    return iceServers;
  },
);

const saveSnapshotDescription$ = command(
  async (
    { set },
    peer: Peer,
    sdp: string,
    relayOnly: boolean,
    signal: AbortSignal,
  ) => {
    const description = snapshotDataDescription(sdp, peer.role, relayOnly);
    if (!description) {
      return false;
    }
    const commands = computerUseCommands;
    const column =
      peer.role === "sender" ? commands.snapshotOffer : commands.snapshotAnswer;
    // Preserve the first description across competing or repeated updates. Retries
    // compare plaintext after the write because each seal has an independent nonce.
    const first = sql`coalesce(nullif(${column}, ''), ${encryptSecretValue(description)})`;
    const [stored] = await set(writeDb$)
      .update(commands)
      .set(
        peer.role === "sender"
          ? { snapshotOffer: first }
          : { snapshotAnswer: first },
      )
      .where(
        and(
          snapshotSignalScope(peer),
          peer.role === "sender" ? isNotNull(column) : undefined,
        ),
      )
      .returning({ sealed: column });
    signal.throwIfAborted();
    return Boolean(
      stored?.sealed && decryptSecretValue(stored.sealed) === description,
    );
  },
);

export function openSnapshotKey(key: unknown): string | undefined {
  if (typeof key !== "string") {
    return undefined;
  }
  const result = safeSync(() => {
    return decryptSecretValue(key);
  });
  return "ok" in result ? result.ok : undefined;
}

// Signaling is bounded to a single recent capture, including its short post-completion
// window so a cold negotiation can warm the following capture. Neither column
// is returned by the ordinary command/history endpoints.
export const exchangeSnapshotSignal$ = command(
  async (
    { get, set },
    peer: Peer,
    signal: AbortSignal,
  ): Promise<ComputerUseSnapshotSignal | null> => {
    if (!isStaffOrg(peer.orgId)) {
      return null;
    }
    const commands = computerUseCommands;
    const scope = snapshotSignalScope(peer);
    const [row] = await get(db$)
      .select({
        runId: commands.runId,
        payload: commands.payload,
        offer: commands.snapshotOffer,
        answer: commands.snapshotAnswer,
        generation: computerUseHosts.connectionGeneration,
      })
      .from(commands)
      .innerJoin(computerUseHosts, eq(computerUseHosts.id, commands.hostId))
      .where(and(scope, eq(computerUseHosts.status, "online")))
      .limit(1);
    signal.throwIfAborted();
    if (!row?.runId || typeof row.payload.snapshotSession !== "string") {
      return null;
    }
    const relayOnly = row.payload.snapshotSession.endsWith(".relay");
    if (
      row.payload.snapshotSession !==
      snapshotSessionId(
        row.runId,
        peer.hostId,
        row.generation,
        relayOnly ? "relay" : "auto",
      )
    ) {
      return null;
    }
    if (
      (await set(
        snapshotRunAccess$,
        { ...peer, runId: row.runId, connectionGeneration: row.generation },
        signal,
      )) !== "enabled"
    ) {
      return null;
    }

    if (peer.role === "sender" && peer.ice) {
      const iceServers = await set(
        issueMacIceServers$,
        peer,
        row.runId,
        signal,
      );
      return iceServers ? { description: null, iceServers, relayOnly } : null;
    }
    const remoteSdp = peer.role === "sender" ? peer.offer : peer.answer;
    if (remoteSdp !== undefined) {
      if (peer.role === "receiver" && !row.offer) {
        return null;
      }
      if (
        !(await set(
          saveSnapshotDescription$,
          peer,
          remoteSdp,
          relayOnly,
          signal,
        ))
      ) {
        return null;
      }
    }
    const sealed = peer.role === "sender" ? row.answer : row.offer;
    return { description: sealed ? decryptSecretValue(sealed) : null };
  },
);
