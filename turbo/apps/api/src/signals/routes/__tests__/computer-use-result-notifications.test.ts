import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createComputerUseBddApi } from "./helpers/api-bdd-computer-use";

const context = testContext();

interface TokenRequestParams {
  readonly capability: Record<string, readonly string[]>;
  readonly ttl: number;
  readonly clientId: string;
}

function isTokenRequestParams(value: unknown): value is TokenRequestParams {
  return (
    typeof value === "object" &&
    value !== null &&
    "capability" in value &&
    "ttl" in value &&
    "clientId" in value
  );
}

/** The realtime provider signs every token request it receives. */
function signTokenRequests(): void {
  context.mocks.ably.createTokenRequest.mockImplementation(
    (params: unknown) => {
      if (!isTokenRequestParams(params)) {
        throw new Error("Unexpected Ably token request parameters");
      }
      return Promise.resolve({
        keyName: "app.key",
        ttl: params.ttl,
        timestamp: now(),
        capability: JSON.stringify(params.capability),
        clientId: params.clientId,
        nonce: randomUUID(),
        mac: randomUUID(),
      });
    },
  );
}

interface Publication {
  readonly channelName: string;
  readonly eventName: unknown;
  readonly payload: unknown;
}

/** Records every realtime publication with the channel it reached. */
function recordPublications(
  onPublish: (publication: Publication) => void = () => {},
): Publication[] {
  const published: Publication[] = [];
  let currentChannel = "";
  context.mocks.ably.channelGet.mockImplementation((channelName) => {
    currentChannel = channelName;
  });
  context.mocks.ably.publish.mockImplementation(
    (eventName: unknown, payload: unknown) => {
      const publication = { channelName: currentChannel, eventName, payload };
      published.push(publication);
      onPublish(publication);
      return Promise.resolve();
    },
  );
  return published;
}

function resultChannel(admin: ApiTestUser, commandId: string): string {
  return `computer-use-result:${admin.userId}:${admin.orgId ?? ""}:${commandId}`;
}

function resultChangedChannels(published: readonly Publication[]) {
  return [
    ...new Set(
      published
        .filter((publication) => {
          return publication.eventName === "resultChanged";
        })
        .map((publication) => {
          return `${publication.channelName}|${String(publication.payload)}`;
        }),
    ),
  ];
}

describe("Computer Use CLI result subscriptions", () => {
  it("computer-use-result-notifications-001 grants a subscribe-only result channel only when the read caller opts in", async () => {
    const api = createComputerUseBddApi(context);
    const bdd = createBddApi(context);
    const admin = bdd.user({ orgRole: "org:admin" });
    const otherUser = bdd.user({ orgRole: "org:admin" });
    signTokenRequests();
    await api.startComputerUseHost(admin);

    const optedIn = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
      realtime: true,
      timeoutMs: 10_000,
    });
    const plain = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
    });
    const otherRead = await api.requestReadComputerUseCommand(
      otherUser,
      optedIn.commandId,
      [404],
    );

    const channelName = resultChannel(admin, optedIn.commandId);
    expect(optedIn.realtime).toStrictEqual({
      channelName,
      eventName: "resultChanged",
      tokenRequest: expect.objectContaining({
        clientId: expect.stringContaining(admin.userId),
        ttl: 70_000,
        capability: JSON.stringify({ [channelName]: ["subscribe"] }),
      }),
    });
    expect(plain).toStrictEqual({
      commandId: plain.commandId,
      status: "queued",
    });
    expect(otherRead.status).toBe(404);
  });

  it("computer-use-result-notifications-003 notifies a durable succeeded result and keeps completion idempotent", async () => {
    const api = createComputerUseBddApi(context);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    signTokenRequests();
    const host = await api.startComputerUseHost(admin);
    const created = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
      realtime: true,
    });
    await api.claimNextComputerUseCommand(host.connection);
    const readsAtPublish: Promise<unknown>[] = [];
    const published = recordPublications((publication) => {
      if (publication.eventName === "resultChanged") {
        readsAtPublish.push(
          api.readComputerUseCommand(admin, created.commandId),
        );
      }
    });
    const completion = {
      status: "succeeded",
      result: { apps: [] },
    } as const;

    const first = await api.requestCompleteComputerUseCommand(
      host.connection,
      created.commandId,
      completion,
      [200],
    );
    const second = await api.requestCompleteComputerUseCommand(
      host.connection,
      created.commandId,
      completion,
      [200],
    );
    const statusesAtPublish = await Promise.all(readsAtPublish);
    const final = await api.readComputerUseCommand(admin, created.commandId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(statusesAtPublish.length).toBeGreaterThan(0);
    expect(statusesAtPublish).toStrictEqual(
      statusesAtPublish.map(() => {
        return expect.objectContaining({ status: "succeeded" });
      }),
    );
    expect(final.status).toBe("succeeded");
    expect(resultChangedChannels(published)).toStrictEqual([
      `${resultChannel(admin, created.commandId)}|null`,
    ]);
  });

  it("computer-use-result-notifications-005 keeps the timeout result when a late completion arrives", async () => {
    const api = createComputerUseBddApi(context);
    const admin = createBddApi(context).user({ orgRole: "org:admin" });
    signTokenRequests();
    const startedAt = now();
    mockNow(startedAt);
    const host = await api.startComputerUseHost(admin);
    const created = await api.createComputerUseReadCommand(admin, {
      kind: "apps.list",
      realtime: true,
      timeoutMs: 1000,
    });
    await api.claimNextComputerUseCommand(host.connection);
    const published = recordPublications();
    mockNow(startedAt + 2000);

    await Promise.all([
      api.readComputerUseCommand(admin, created.commandId),
      api.readComputerUseCommand(admin, created.commandId),
    ]);
    const late = await api.requestCompleteComputerUseCommand(
      host.connection,
      created.commandId,
      { status: "succeeded", result: { apps: [] } },
      [200],
    );
    const final = await api.readComputerUseCommand(admin, created.commandId);

    expect(late.status).toBe(200);
    expect(final).toMatchObject({
      status: "failed",
      error: { code: "timeout" },
    });
    expect(resultChangedChannels(published)).toStrictEqual([
      `${resultChannel(admin, created.commandId)}|null`,
    ]);
  });
});
