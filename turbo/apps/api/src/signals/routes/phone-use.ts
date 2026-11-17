import { joinAll, settle } from "../utils";
import { createHash, randomUUID } from "node:crypto";
import { command, type Command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";
import {
  phoneUseContract as contract,
  phoneUseChannel,
  phoneActionSchema,
  phoneOperationSchema,
} from "@okouai/api-contracts/contracts/phone-use";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  phoneUseDevices as devices,
  phoneUseGrants as grants,
  phoneUseOperations as operations,
} from "@okouai/db/schema/phone-use";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import type { AuthContext } from "../../types/auth";

import { env } from "../../lib/env";
import { now, nowDate } from "../../lib/time";
import { authRoute } from "../auth/auth-route";
import { organizationAuthContext$ } from "../auth/auth-context";
import { bodyResultOf, pathParamsOf } from "../context/request";
import { db$, writeDb$ } from "../external/db";
import { verifyClerkComputerUseSession } from "../external/clerk";
import {
  createPhoneUseToken,
  phoneUseDeviceIsPresent,
  publishPhoneUseHint,
} from "../external/realtime";
import { putS3Object$, signPresignedGetUrl$ } from "../external/s3";
import { loadUserFeatureSwitchContext$ } from "../services/feature-switches.service";
import type { RouteEntry } from "../route-entry";

type OrganizationAuthContext = AuthContext & { readonly orgId: string };
class PhoneUseError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
function deny(message: string): never {
  throw new PhoneUseError(403, message);
}
function conflict(message: string): never {
  throw new PhoneUseError(409, message);
}
function missing(): never {
  throw new PhoneUseError(404, "Phone Use resource not found");
}
function owned(auth: OrganizationAuthContext) {
  return and(eq(devices.orgId, auth.orgId), eq(devices.userId, auth.userId));
}
function operationOwner(auth: OrganizationAuthContext) {
  return and(
    eq(operations.orgId, auth.orgId),
    eq(operations.userId, auth.userId),
  );
}
const feature$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const context = await set(
    loadUserFeatureSwitchContext$,
    auth.orgId,
    auth.userId,
    signal,
  );
  return isFeatureEnabled(FeatureSwitchKey.PhoneUse, context);
});
function guard<T>(
  inner: Command<Promise<T>, [AbortSignal]>,
  mode: "session" | "agent" | "both",
  cleanup = false,
) {
  const admitted$ = command(async ({ set }, signal: AbortSignal) => {
    if (!cleanup && !(await set(feature$, signal))) {
      deny("Phone Use is disabled");
    }
    signal.throwIfAborted();
    return set(inner, signal);
  });
  return authRoute(
    {
      requireOrganization: true,
      accept: mode === "both" ? ["session", "agent"] : [mode],
      ...(mode !== "session"
        ? { requiredCapability: "phone-use:read" as const }
        : {}),
    },
    command(async ({ set }, signal: AbortSignal) => {
      const result = await settle(set(admitted$, signal), signal);
      if (result.ok) {
        return result.value;
      }
      if (result.error instanceof PhoneUseError) {
        const codes = {
          400: "BAD_REQUEST",
          403: "FORBIDDEN",
          404: "NOT_FOUND",
          409: "CONFLICT",
        };
        return {
          status: result.error.status,
          body: {
            error: {
              message: result.error.message,
              code: codes[result.error.status],
            },
          },
        };
      }
      throw result.error;
    }),
  );
}

const host$ = command(
  async ({ get }, id: string, generation: number, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    if (auth.tokenType !== "session" || !auth.sessionId) {
      deny("A native Clerk session is required");
    }
    const [device] = await get(db$)
      .select()
      .from(devices)
      .where(
        and(
          owned(auth),
          eq(devices.id, id),
          eq(devices.sessionId, auth.sessionId),
          eq(devices.generation, generation),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!device) {
      conflict("This device connection has been replaced");
    }
    if (
      !(await verifyClerkComputerUseSession(
        { orgId: auth.orgId, userId: auth.userId, sessionId: auth.sessionId },
        signal,
      ))
    ) {
      deny("The native session has expired");
    }
    return device;
  },
);
const runGrant$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (
    auth.tokenType !== "agent" ||
    !auth.phoneUseGrantId ||
    !auth.phoneUseDeviceId ||
    !auth.capabilities.includes("phone-use:write")
  ) {
    deny(
      "Enable your phone in this chat's Connectors menu. Start a new Run after authorization.",
    );
  }
  const [grant] = await get(db$)
    .select({
      id: grants.id,
      deviceId: grants.deviceId,
      sessionId: devices.sessionId,
    })
    .from(grants)
    .innerJoin(
      devices,
      and(
        eq(devices.id, grants.deviceId),
        eq(devices.generation, grants.deviceGeneration),
        eq(devices.userId, grants.userId),
        eq(devices.orgId, grants.orgId),
      ),
    )
    .innerJoin(
      agentRuns,
      and(
        eq(agentRuns.chatThreadId, grants.threadId),
        eq(agentRuns.id, auth.runId),
        eq(agentRuns.status, "running"),
      ),
    )
    .where(
      and(
        eq(grants.id, auth.phoneUseGrantId),
        eq(grants.deviceId, auth.phoneUseDeviceId),
        eq(grants.orgId, auth.orgId),
        eq(grants.userId, auth.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!grant) {
    deny("This Run no longer has an active Phone Use grant");
  }
  const valid = await verifyClerkComputerUseSession(
    { userId: auth.userId, orgId: auth.orgId, sessionId: grant.sessionId },
    signal,
  );
  signal.throwIfAborted();
  if (!valid) {
    deny("The owner's Phone Use session has ended");
  }
  return { id: grant.id, deviceId: grant.deviceId, runId: auth.runId };
});
function deviceView(value: typeof devices.$inferSelect, present = false) {
  const online =
    present && value.ready && value.lastSeenAt.getTime() > now() - 45_000;
  return {
    id: value.id,
    displayName: value.displayName,
    osVersion: value.osVersion,
    appVersion: value.appVersion,
    generation: value.generation,
    online,
    lastSeenAt: value.lastSeenAt.toISOString(),
  };
}
function operationView(value: typeof operations.$inferSelect) {
  return phoneOperationSchema.parse({
    id: value.id,
    deviceId: value.deviceId,
    runId: value.runId,
    grantId: value.grantId,
    action: phoneActionSchema.parse(value.action),
    status: value.status,
    result: value.result,
    error: value.error,
    createdAt: value.createdAt.toISOString(),
    expiresAt: value.expiresAt.toISOString(),
  });
}
const list$ = command(async ({ get }, signal: AbortSignal) => {
  const rows = await get(db$)
    .select()
    .from(devices)
    .where(owned(get(organizationAuthContext$)));
  signal.throwIfAborted();
  const listed = await joinAll(
    rows.map(async (device) => {
      return deviceView(device, await phoneUseDeviceIsPresent(device, signal));
    }),
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: { devices: listed } };
});
const registerBody$ = bodyResultOf(contract.register);
const register$ = command(async ({ get, set }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  if (auth.tokenType !== "session" || !auth.sessionId) {
    deny("A Clerk session is required");
  }
  const body = await get(registerBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    !(await verifyClerkComputerUseSession(
      { orgId: auth.orgId, userId: auth.userId, sessionId: auth.sessionId },
      signal,
    ))
  ) {
    deny("Invalid native session");
  }
  const values = {
    orgId: auth.orgId,
    userId: auth.userId,
    sessionId: auth.sessionId,
    installationId: body.data.installationId,
    displayName: body.data.displayName,
    osVersion: body.data.osVersion,
    appVersion: body.data.appVersion,
    ready: false,
    lastSeenAt: nowDate(),
  };
  const [device] = await set(writeDb$)
    .insert(devices)
    .values(values)
    .onConflictDoUpdate({
      target: [devices.orgId, devices.userId, devices.installationId],
      set: { ...values, generation: sql`${devices.generation}+1` },
    })
    .returning();
  signal.throwIfAborted();
  if (!device) {
    throw new Error("Device registration returned no row");
  }
  await set(writeDb$)
    .update(operations)
    .set({
      status: "unknown",
      error: "Native connection replaced; reconcile on the phone",
      completedAt: nowDate(),
    })
    .where(
      and(
        eq(operations.deviceId, device.id),
        inArray(operations.status, ["queued", "running", "approval_required"]),
        not(
          exists(
            get(db$)
              .select({ id: grants.id })
              .from(grants)
              .where(
                and(
                  eq(grants.id, operations.grantId),
                  gt(grants.deviceGeneration, device.generation - 1),
                ),
              ),
          ),
        ),
      ),
    );
  signal.throwIfAborted();
  return { status: 200 as const, body: deviceView(device) };
});
const heartbeatBody$ = bodyResultOf(contract.heartbeat),
  heartbeatPath$ = pathParamsOf(contract.heartbeat);
const heartbeat$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(heartbeatBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const path = get(heartbeatPath$);
  await set(host$, path.deviceId, body.data.generation, signal);
  await set(writeDb$)
    .update(devices)
    .set({ ready: body.data.ready, lastSeenAt: nowDate() })
    .where(
      and(
        eq(devices.id, path.deviceId),
        eq(devices.generation, body.data.generation),
      ),
    );
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
});
const disconnectBody$ = bodyResultOf(contract.disconnect),
  disconnectPath$ = pathParamsOf(contract.disconnect);
const disconnect$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(disconnectBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const path = get(disconnectPath$);
  await set(host$, path.deviceId, body.data.generation, signal);
  const [disconnected] = await set(writeDb$)
    .update(devices)
    .set({ ready: false, generation: sql`${devices.generation}+1` })
    .where(
      and(
        eq(devices.id, path.deviceId),
        eq(devices.generation, body.data.generation),
      ),
    )
    .returning({ id: devices.id });
  signal.throwIfAborted();
  if (!disconnected) {
    conflict("Native connection was replaced");
  }
  await set(writeDb$)
    .delete(grants)
    .where(
      and(
        eq(grants.deviceId, path.deviceId),
        lte(grants.deviceGeneration, body.data.generation),
      ),
    );
  signal.throwIfAborted();
  await set(writeDb$)
    .update(operations)
    .set({
      status: "unknown",
      error: "Stopped on the phone; effects must be reconciled",
      completedAt: nowDate(),
    })
    .where(
      and(
        eq(operations.deviceId, path.deviceId),
        inArray(operations.status, ["queued", "running", "approval_required"]),
        not(
          exists(
            get(db$)
              .select({ id: grants.id })
              .from(grants)
              .where(
                and(
                  eq(grants.id, operations.grantId),
                  gt(grants.deviceGeneration, body.data.generation),
                ),
              ),
          ),
        ),
      ),
    );
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
});
const realtimeBody$ = bodyResultOf(contract.realtime),
  realtimePath$ = pathParamsOf(contract.realtime);
const realtime$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(realtimeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const device = await set(
    host$,
    get(realtimePath$).deviceId,
    body.data.generation,
    signal,
  );
  const channel = phoneUseChannel(
    device.orgId,
    device.userId,
    device.id,
    device.generation,
  );
  return {
    status: 200 as const,
    body: {
      channel,
      tokenRequest: await createPhoneUseToken(channel, device.userId, signal),
    },
  };
});
const chats$ = command(async ({ get }, signal: AbortSignal) => {
  const auth = get(organizationAuthContext$);
  const rows = await get(db$)
    .select({ id: chatThreads.id, title: chatThreads.title })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(eq(chatThreads.userId, auth.userId), eq(agents.orgId, auth.orgId)),
    )
    .orderBy(
      desc(
        sql`coalesce(${chatThreads.lastMessageAt}, ${chatThreads.createdAt})`,
      ),
    )
    .limit(30);
  signal.throwIfAborted();
  return { status: 200 as const, body: { chats: rows } };
});
const grantBody$ = bodyResultOf(contract.grant);
const ownedThread$ = command(
  async ({ get }, threadId: string, signal: AbortSignal) => {
    const auth = get(organizationAuthContext$);
    const [thread] = await get(db$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(chatThreads.id, threadId),
          eq(chatThreads.userId, auth.userId),
          eq(agents.orgId, auth.orgId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      missing();
    }
    return thread;
  },
);
const chatGrant$ = command(async ({ get, set }, signal: AbortSignal) => {
  const { threadId } = get(pathParamsOf(contract.chatGrant));
  await set(ownedThread$, threadId, signal);
  const auth = get(organizationAuthContext$);
  const [selection] = await get(db$)
    .select({ deviceId: grants.deviceId, generation: grants.deviceGeneration })
    .from(grants)
    .innerJoin(
      devices,
      and(
        eq(devices.id, grants.deviceId),
        eq(devices.generation, grants.deviceGeneration),
        owned(auth),
      ),
    )
    .where(
      and(
        eq(grants.threadId, threadId),
        eq(grants.orgId, auth.orgId),
        eq(grants.userId, auth.userId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  return { status: 200 as const, body: { selection: selection ?? null } };
});
const grant$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(grantBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (body.data.allow && !(await set(feature$, signal))) {
    deny("Phone Use is disabled");
  }
  const auth = get(organizationAuthContext$);
  const thread = await set(ownedThread$, body.data.threadId, signal);
  // Chat access belongs to the signed-in owner. Device lifecycle requests
  // still require the phone's own session through host$.
  const [device] = await get(db$)
    .select()
    .from(devices)
    .where(
      and(
        owned(auth),
        eq(devices.id, body.data.deviceId),
        eq(devices.generation, body.data.generation),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!device) {
    missing();
  }
  if (body.data.allow) {
    if (
      !(await verifyClerkComputerUseSession(
        { orgId: auth.orgId, userId: auth.userId, sessionId: device.sessionId },
        signal,
      ))
    ) {
      deny("The phone's session has ended. Reconnect Okou iOS Use.");
    }
    await set(writeDb$)
      .insert(grants)
      .values({
        orgId: auth.orgId,
        userId: auth.userId,
        threadId: thread.id,
        deviceId: device.id,
        deviceGeneration: device.generation,
      })
      .onConflictDoUpdate({
        target: [grants.orgId, grants.userId, grants.threadId],
        setWhere: and(
          or(
            ne(grants.deviceId, device.id),
            ne(grants.deviceGeneration, device.generation),
          ),
          exists(
            get(db$)
              .select({ id: devices.id })
              .from(devices)
              .where(
                and(
                  eq(devices.id, device.id),
                  eq(devices.generation, device.generation),
                ),
              ),
          ),
        ),
        set: {
          id: randomUUID(),
          deviceId: device.id,
          deviceGeneration: device.generation,
          createdAt: nowDate(),
        },
      });
  } else {
    await set(writeDb$)
      .delete(grants)
      .where(
        and(
          eq(grants.orgId, auth.orgId),
          eq(grants.userId, auth.userId),
          eq(grants.threadId, thread.id),
          eq(grants.deviceId, device.id),
          eq(grants.deviceGeneration, device.generation),
        ),
      );
  }
  await publishPhoneUseHint(
    phoneUseChannel(auth.orgId, auth.userId, device.id, device.generation),
    signal,
  );
  return { status: 200 as const, body: { ok: true as const } };
});
const stoppedPhoneRun$ = command(
  async (
    { get },
    claim: { runId: string; deviceId: string; grantId?: string },
    signal: AbortSignal,
  ) => {
    const [stopped] = await get(db$)
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.runId, claim.runId),
          eq(operations.deviceId, claim.deviceId),
          claim.grantId ? eq(operations.grantId, claim.grantId) : undefined,
          eq(operations.status, "succeeded"),
          sql`${operations.action}->>'kind' = 'session.stop'`,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return Boolean(stopped);
  },
);
const closeRunAdmission$ = command(
  async (
    { set },
    claim: { runId: string; grantId: string },
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .update(operations)
      .set({
        status: sql`case when ${operations.status} = 'queued' then 'failed' else 'unknown' end`,
        error:
          "Run phone admission closed; authorized in-flight effects may finish",
        completedAt: nowDate(),
      })
      .where(
        and(
          eq(operations.runId, claim.runId),
          eq(operations.grantId, claim.grantId),
          inArray(operations.status, [
            "queued",
            "running",
            "approval_required",
          ]),
        ),
      );
    signal.throwIfAborted();
  },
);
const createBody$ = bodyResultOf(contract.create);
const create$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(createBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  if (
    body.data.action.kind !== "session.stop" &&
    !(await set(feature$, signal))
  ) {
    deny("Phone Use is disabled");
  }
  const grant = await set(runGrant$, signal);
  const auth = get(organizationAuthContext$);
  const stopping = body.data.action.kind === "session.stop";
  if (
    !stopping &&
    (await set(
      stoppedPhoneRun$,
      { runId: grant.runId, deviceId: grant.deviceId, grantId: grant.id },
      signal,
    ))
  ) {
    conflict(
      "This Run's phone session ended. Start a new Run for another task.",
    );
  }
  const [device] = await get(db$)
    .select()
    .from(devices)
    .where(
      and(
        owned(auth),
        eq(devices.id, grant.deviceId),
        stopping ? undefined : eq(devices.ready, true),
        stopping ? undefined : gt(devices.lastSeenAt, new Date(now() - 45_000)),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!device) {
    conflict("Open Okou iOS Use and go online");
  }
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(body.data.action))
    .digest("hex");
  await set(writeDb$)
    .insert(operations)
    .values({
      id: body.data.id,
      orgId: auth.orgId,
      userId: auth.userId,
      runId: grant.runId,
      grantId: grant.id,
      deviceId: device.id,
      action: body.data.action,
      payloadHash,
      status: stopping ? "succeeded" : "queued",
      result: stopping
        ? { admissionClosed: true, nativeAcknowledged: false }
        : null,
      completedAt: stopping ? nowDate() : null,
      expiresAt: new Date(now() + 45_000),
    })
    .onConflictDoNothing({ target: operations.id });
  signal.throwIfAborted();
  const [row] = await get(db$)
    .select()
    .from(operations)
    .where(
      and(
        operationOwner(auth),
        eq(operations.id, body.data.id),
        eq(operations.runId, grant.runId),
        eq(operations.grantId, grant.id),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row || row.payloadHash !== payloadHash) {
    conflict("Operation ID was already used with another payload or authority");
  }
  if (stopping) {
    await set(
      closeRunAdmission$,
      { runId: grant.runId, grantId: grant.id },
      signal,
    );
  }
  await publishPhoneUseHint(
    phoneUseChannel(device.orgId, device.userId, device.id, device.generation),
    signal,
  );
  return { status: 200 as const, body: operationView(row) };
});
const getPath$ = pathParamsOf(contract.get);
const get$ = command(async ({ get, set }, signal: AbortSignal) => {
  const grant = await set(runGrant$, signal);
  const auth = get(organizationAuthContext$);
  const [row] = await get(db$)
    .select()
    .from(operations)
    .where(
      and(
        operationOwner(auth),
        eq(operations.id, get(getPath$).operationId),
        eq(operations.grantId, grant.id),
        eq(operations.runId, grant.runId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row) {
    missing();
  }
  if (
    ["queued", "running", "approval_required"].includes(row.status) &&
    row.expiresAt.getTime() <= now()
  ) {
    const [expired] = await set(writeDb$)
      .update(operations)
      .set({
        // Local approval may already have dispatched input while its result
        // is still in flight. Only an unclaimed queued operation is not sent.
        status: row.status === "queued" ? "failed" : "unknown",
        error: "Operation deadline expired; never replay an uncertain effect",
        completedAt: nowDate(),
      })
      .where(and(eq(operations.id, row.id), eq(operations.status, row.status)))
      .returning();
    signal.throwIfAborted();
    if (expired) {
      return { status: 200 as const, body: operationView(expired) };
    }
  }
  return { status: 200 as const, body: operationView(row) };
});
const screenshotPath$ = pathParamsOf(contract.screenshot);
const screenshot$ = command(async ({ get, set }, signal: AbortSignal) => {
  const grant = await set(runGrant$, signal);
  const auth = get(organizationAuthContext$);
  const [row] = await get(db$)
    .select()
    .from(operations)
    .where(
      and(
        operationOwner(auth),
        eq(operations.id, get(screenshotPath$).operationId),
        eq(operations.grantId, grant.id),
        eq(operations.runId, grant.runId),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row?.screenshotKey) {
    missing();
  }
  const url = await set(signPresignedGetUrl$, {
    bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
    key: row.screenshotKey,
    publicEndpoint: true,
    filename: "phone-screenshot.png",
    signingDate: nowDate(),
    responseCacheControl: "private, no-store",
  });
  signal.throwIfAborted();
  return { status: 200 as const, body: { url } };
});
const retireEndedOperations$ = command(
  async (
    { get, set },
    device: typeof devices.$inferSelect,
    signal: AbortSignal,
  ) => {
    await set(writeDb$)
      .update(operations)
      .set({
        status: sql`case when ${operations.status} = 'queued' then 'failed' else 'unknown' end`,
        error:
          "Operation expired or its Run/grant ended; inspect uncertain effects before another input",
        completedAt: nowDate(),
      })
      .where(
        and(
          eq(operations.deviceId, device.id),
          exists(
            get(db$)
              .select({ id: devices.id })
              .from(devices)
              .where(
                and(
                  eq(devices.id, device.id),
                  eq(devices.generation, device.generation),
                ),
              ),
          ),
          inArray(operations.status, [
            "queued",
            "running",
            "approval_required",
          ]),
          or(
            lte(operations.expiresAt, nowDate()),
            not(
              exists(
                get(db$)
                  .select({ id: grants.id })
                  .from(grants)
                  .innerJoin(
                    agentRuns,
                    and(
                      eq(agentRuns.id, operations.runId),
                      eq(agentRuns.chatThreadId, grants.threadId),
                      eq(agentRuns.status, "running"),
                      eq(agentRuns.orgId, device.orgId),
                      eq(agentRuns.userId, device.userId),
                    ),
                  )
                  .where(
                    and(
                      eq(grants.id, operations.grantId),
                      eq(grants.deviceId, device.id),
                      eq(grants.deviceGeneration, device.generation),
                      eq(grants.orgId, device.orgId),
                      eq(grants.userId, device.userId),
                    ),
                  ),
              ),
            ),
          ),
        ),
      );
    signal.throwIfAborted();
  },
);
const activeNativeRun$ = command(
  async (
    { get, set },
    device: typeof devices.$inferSelect,
    claim: { threadId?: string; runId: string; grantId?: string },
    signal: AbortSignal,
  ) => {
    const [active] = await get(db$)
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .innerJoin(
        grants,
        and(
          eq(grants.threadId, agentRuns.chatThreadId),
          claim.threadId ? eq(grants.threadId, claim.threadId) : undefined,
          eq(grants.deviceId, device.id),
          eq(grants.deviceGeneration, device.generation),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, claim.runId),
          eq(agentRuns.userId, device.userId),
          eq(agentRuns.orgId, device.orgId),
          eq(agentRuns.status, "running"),
          claim.grantId ? eq(grants.id, claim.grantId) : undefined,
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const stopped =
      Boolean(active) &&
      (await set(
        stoppedPhoneRun$,
        {
          runId: claim.runId,
          deviceId: device.id,
          ...(claim.grantId ? { grantId: claim.grantId } : {}),
        },
        signal,
      ));
    signal.throwIfAborted();
    return { active: Boolean(active) && !stopped, stopped };
  },
);
const claimPhoneOperation$ = command(
  async (
    { get, set },
    device: typeof devices.$inferSelect,
    claim: { readonly threadId?: string; readonly activeRunId?: string },
    signal: AbortSignal,
  ) => {
    const [running] = await get(db$)
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.deviceId, device.id),
          inArray(operations.status, ["running", "approval_required"]),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (running) {
      return { status: 200 as const, body: { operation: null } };
    }
    const liveGrant = exists(
      get(db$)
        .select({ id: grants.id })
        .from(grants)
        .innerJoin(
          agentRuns,
          and(
            eq(agentRuns.id, operations.runId),
            eq(agentRuns.chatThreadId, grants.threadId),
            eq(agentRuns.status, "running"),
          ),
        )
        .where(
          and(
            eq(grants.id, operations.grantId),
            eq(grants.deviceId, device.id),
            eq(grants.deviceGeneration, device.generation),
            eq(grants.orgId, device.orgId),
            eq(grants.userId, device.userId),
            eq(agentRuns.orgId, device.orgId),
            eq(agentRuns.userId, device.userId),
            claim.threadId ? eq(grants.threadId, claim.threadId) : undefined,
          ),
        ),
    );
    const [candidate] = await get(db$)
      .select()
      .from(operations)
      .where(
        and(
          eq(operations.deviceId, device.id),
          eq(operations.status, "queued"),
          gt(operations.expiresAt, nowDate()),
          claim.activeRunId
            ? eq(operations.runId, claim.activeRunId)
            : undefined,
          liveGrant,
        ),
      )
      .orderBy(asc(operations.createdAt))
      .limit(1);
    signal.throwIfAborted();
    if (!candidate) {
      return { status: 200 as const, body: { operation: null } };
    }
    const [row] = await set(writeDb$)
      .update(operations)
      .set({ status: "running", claimedGeneration: device.generation })
      .where(
        and(
          liveGrant,
          eq(operations.id, candidate.id),
          eq(operations.status, "queued"),
          gt(operations.expiresAt, nowDate()),
          claim.activeRunId
            ? eq(operations.runId, claim.activeRunId)
            : undefined,
          exists(
            get(db$)
              .select({ id: devices.id })
              .from(devices)
              .where(
                and(
                  eq(devices.id, device.id),
                  eq(devices.generation, device.generation),
                  eq(devices.ready, true),
                ),
              ),
          ),
        ),
      )
      .returning();
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { operation: row ? operationView(row) : null },
    };
  },
);
const nextBody$ = bodyResultOf(contract.next),
  nextPath$ = pathParamsOf(contract.next);
const next$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(nextBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const device = await set(
    host$,
    get(nextPath$).deviceId,
    body.data.generation,
    signal,
  );
  await set(retireEndedOperations$, device, signal);
  signal.throwIfAborted();
  if (body.data.activeRunId) {
    const active = await set(
      activeNativeRun$,
      device,
      {
        ...(body.data.threadId ? { threadId: body.data.threadId } : {}),
        runId: body.data.activeRunId,
        ...(body.data.activeGrantId
          ? { grantId: body.data.activeGrantId }
          : {}),
      },
      signal,
    );
    signal.throwIfAborted();
    if (!active.active) {
      return {
        status: 200 as const,
        body: {
          operation: null,
          sessionEnded: true,
          stopRequested: active.stopped,
        },
      };
    }
  }
  if (!device.ready) {
    return { status: 200 as const, body: { operation: null } };
  }
  return set(claimPhoneOperation$, device, body.data, signal);
});
const retainScreenshot$ = command(
  async (
    { set },
    upload: {
      operationId: string;
      generation: number;
      orgId: string;
      userId: string;
      base64: string;
    },
    signal: AbortSignal,
  ) => {
    const image = Buffer.from(upload.base64, "base64");
    if (
      image.length > 6_000_000 ||
      image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    ) {
      throw new PhoneUseError(400, "A bounded PNG screenshot is required");
    }
    const key = `phone-use/${upload.orgId}/${upload.userId}/${upload.operationId}/screenshot.png`;
    // Link retention before the external upload. Cancellation may retire the
    // result while upload is in flight; its private image must remain collectible.
    const [linked] = await set(writeDb$)
      .update(operations)
      .set({ screenshotKey: key })
      .where(
        and(
          eq(operations.id, upload.operationId),
          eq(operations.claimedGeneration, upload.generation),
        ),
      )
      .returning({ id: operations.id });
    signal.throwIfAborted();
    if (!linked) {
      missing();
    }
    await set(
      putS3Object$,
      {
        bucket: env("R2_USER_STORAGES_BUCKET_NAME"),
        key,
        body: image,
        contentType: "image/png",
      },
      signal,
    );
    signal.throwIfAborted();
    return key;
  },
);
const completeBody$ = bodyResultOf(contract.complete),
  completePath$ = pathParamsOf(contract.complete);
const complete$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(completeBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const device = await set(
    host$,
    get(completePath$).deviceId,
    body.data.generation,
    signal,
  );
  const [row] = await get(db$)
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.id, body.data.operationId),
        eq(operations.deviceId, device.id),
        eq(operations.claimedGeneration, device.generation),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (!row) {
    missing();
  }
  if (!["running", "approval_required"].includes(row.status)) {
    return { status: 200 as const, body: { ok: true as const } };
  }
  const result = body.data.result;
  if (
    row.status === "approval_required" &&
    result.status === "approval_required"
  ) {
    return { status: 200 as const, body: { ok: true as const } };
  }
  let screenshotKey: string | undefined;
  if (result.screenshotBase64) {
    screenshotKey = await set(
      retainScreenshot$,
      {
        operationId: row.id,
        generation: device.generation,
        orgId: device.orgId,
        userId: device.userId,
        base64: result.screenshotBase64,
      },
      signal,
    );
  }
  await set(writeDb$)
    .update(operations)
    .set({
      status: result.status,
      result: {
        ...result.data,
        ...(screenshotKey || row.screenshotKey
          ? {
              screenshotPhase:
                row.action.kind === "observe" ? "observation" : "before_input",
            }
          : {}),
      },
      error: result.error ?? null,
      screenshotKey: screenshotKey ?? row.screenshotKey,
      completedAt: result.status === "approval_required" ? null : nowDate(),
      expiresAt:
        result.status === "approval_required"
          ? new Date(now() + 5 * 60_000)
          : row.expiresAt,
    })
    .where(
      and(
        eq(operations.id, row.id),
        eq(operations.status, row.status),
        eq(operations.claimedGeneration, device.generation),
      ),
    );
  signal.throwIfAborted();
  return { status: 200 as const, body: { ok: true as const } };
});

const validateBody$ = bodyResultOf(contract.validate),
  validatePath$ = pathParamsOf(contract.validate);
const validate$ = command(async ({ get, set }, signal: AbortSignal) => {
  const body = await get(validateBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const device = await set(
    host$,
    get(validatePath$).deviceId,
    body.data.generation,
    signal,
  );
  const [operation] = await get(db$)
    .select({
      id: operations.id,
      runId: operations.runId,
      grantId: operations.grantId,
    })
    .from(operations)
    .innerJoin(
      grants,
      and(
        eq(grants.id, operations.grantId),
        eq(grants.deviceId, operations.deviceId),
        eq(grants.orgId, operations.orgId),
        eq(grants.userId, operations.userId),
        eq(grants.deviceGeneration, device.generation),
      ),
    )
    .innerJoin(
      agentRuns,
      and(
        eq(agentRuns.id, operations.runId),
        eq(agentRuns.chatThreadId, grants.threadId),
        eq(agentRuns.status, "running"),
      ),
    )
    .where(
      and(
        eq(operations.id, body.data.operationId),
        eq(operations.deviceId, device.id),
        eq(operations.claimedGeneration, device.generation),
        inArray(operations.status, ["running", "approval_required"]),
        gt(operations.expiresAt, nowDate()),
      ),
    )
    .limit(1);
  signal.throwIfAborted();
  if (
    !device.ready ||
    !operation ||
    (await set(
      stoppedPhoneRun$,
      {
        runId: operation.runId,
        deviceId: device.id,
        grantId: operation.grantId,
      },
      signal,
    ))
  ) {
    deny("Operation authority has expired or was revoked");
  }
  return { status: 200 as const, body: { ok: true as const } };
});

export const phoneUseRoutes: readonly RouteEntry[] = [
  { route: contract.devices, handler: guard(list$, "both") },
  { route: contract.register, handler: guard(register$, "session") },
  { route: contract.heartbeat, handler: guard(heartbeat$, "session") },
  { route: contract.disconnect, handler: guard(disconnect$, "session", true) },
  { route: contract.realtime, handler: guard(realtime$, "session") },
  { route: contract.chats, handler: guard(chats$, "session") },
  { route: contract.grant, handler: guard(grant$, "session", true) },
  { route: contract.chatGrant, handler: guard(chatGrant$, "session", true) },
  { route: contract.create, handler: guard(create$, "agent", true) },
  { route: contract.get, handler: guard(get$, "agent", true) },
  { route: contract.screenshot, handler: guard(screenshot$, "agent") },
  { route: contract.next, handler: guard(next$, "session") },
  { route: contract.validate, handler: guard(validate$, "session") },
  { route: contract.complete, handler: guard(complete$, "session", true) },
];
