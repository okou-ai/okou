import { generateKeyPairSync, randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import type { ServerHttp2Session } from "node:http2";
import { http, HttpResponse } from "msw";
import { onTestFinished, vi } from "vitest";
import { iosPushRegistrationsContract } from "@okouai/api-contracts/contracts/ios-push-registrations";
import { setupApp } from "../../../../__tests__/test-helpers";
import { accept, type TestContext } from "../../../../__tests__/test-context";
import { mockEnv } from "../../../../lib/env";
import { now } from "../../../../lib/time";
import { server as providerServer } from "../../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../../utils";
import { iosPushRegistrationsRoutes } from "../../ios-push-registrations";

export function authenticateIosSession(
  context: TestContext,
  userId: string,
  orgId: string,
  sessionId = `sess_${userId}`,
) {
  context.mocks.clerk.authenticateRequest.mockResolvedValue({
    isAuthenticated: true,
    toAuth: () => {
      return { userId, orgId, orgRole: "org:admin", sessionId };
    },
  });
  context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
    { data: [{ publicUserData: { userId } }] },
  );
  context.mocks.clerk.sessions.getSession.mockResolvedValue({
    id: sessionId,
    userId,
    status: "active",
    expireAt: now() + 86_400_000,
  });
}

export async function registerIosPush(
  context: TestContext,
  actor: { userId: string; orgId: string },
  options: {
    installationId?: string;
    revision?: number;
    deviceToken?: string;
    environment?: "production" | "sandbox";
  } = {},
) {
  authenticateIosSession(context, actor.userId, actor.orgId);
  const binding = {
    installationId: options.installationId ?? randomUUID(),
    revision: options.revision ?? 1,
    deviceToken: options.deviceToken ?? "ab".repeat(32),
    environment: options.environment ?? "production",
  };
  await accept(
    setupApp({ context, routes: iosPushRegistrationsRoutes })(
      iosPushRegistrationsContract,
    ).register({
      headers: { authorization: "Bearer clerk-session" },
      body: binding,
    }),
    [200],
  );
  return binding;
}

/** Keep HTTP/2 framing while routing provider requests through shared MSW handlers. */
export async function createApnsFixture(
  context: TestContext,
  environment: "production" | "sandbox" = "production",
) {
  const http2 =
    await vi.importActual<typeof import("node:http2")>("node:http2");
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  mockEnv(
    "APNS_PRIVATE_KEY_BASE64",
    Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString(
      "base64",
    ),
  );
  mockEnv("APNS_SANDBOX_PRIVATE_KEY_BASE64", undefined);
  mockEnv("APNS_SANDBOX_KEY_ID", undefined);
  mockEnv("APNS_SANDBOX_TEAM_ID", undefined);
  mockEnv("APNS_KEY_ID", "TESTKEY001");
  mockEnv("APNS_TEAM_ID", "TESTTEAM01");
  if (environment === "sandbox") {
    mockEnv("APNS_PRIVATE_KEY_BASE64", undefined);
    mockEnv("APNS_KEY_ID", undefined);
    mockEnv("APNS_TEAM_ID", undefined);
    mockEnv(
      "APNS_SANDBOX_PRIVATE_KEY_BASE64",
      Buffer.from(privateKey.export({ type: "pkcs8", format: "pem" })).toString(
        "base64",
      ),
    );
    mockEnv("APNS_SANDBOX_KEY_ID", "TESTKEY002");
    mockEnv("APNS_SANDBOX_TEAM_ID", "TESTTEAM01");
  }
  const requests: {
    origin: string;
    headers: import("node:http2").IncomingHttpHeaders;
    payload: unknown;
  }[] = [];
  const responses: { status: number; reason?: string; pause?: boolean }[] = [];
  const arrivals = new EventEmitter();
  const pendingReplies: (() => void)[] = [];
  const transfers: Promise<void>[] = [];
  const failures: unknown[] = [];
  const sessions = new Set<ServerHttp2Session>();
  const origin =
    environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";
  providerServer.use(
    http.post(`${origin}/3/device/:deviceToken`, async ({ params }) => {
      if (!/^(?:[0-9a-f]{2}){32,256}$/u.test(String(params.deviceToken))) {
        const error = new Error("Unexpected APNs device token");
        failures.push(error);
        throw error;
      }
      const response = responses.shift() ?? { status: 200 };
      const released = createDeferredPromise<void>(context.signal);
      if (response.pause) {
        pendingReplies.push(() => {
          released.resolve();
        });
      } else {
        released.resolve();
      }
      arrivals.emit("request");
      await released.promise;
      return new HttpResponse(
        response.reason ? JSON.stringify({ reason: response.reason }) : null,
        { status: response.status },
      );
    }),
  );
  const server = http2.createServer();
  onTestFinished(async () => {
    for (const reply of pendingReplies.splice(0)) {
      reply();
    }
    await Promise.all(transfers);
    for (const session of sessions) {
      session.destroy();
    }
    const closed = once(server, "close");
    server.close();
    await closed;
    if (failures.length > 0) {
      throw new AggregateError(failures, "Unhandled APNs fixture requests");
    }
  });
  server.on("session", (session) => {
    sessions.add(session);
  });
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("end", () => {
      const forward = async () => {
        requests.push({ origin, headers, payload: JSON.parse(body) });
        const requestHeaders = new Headers();
        for (const [name, value] of Object.entries(headers)) {
          if (!name.startsWith(":") && typeof value === "string") {
            requestHeaders.set(name, value);
          }
        }
        const response = await fetch(
          new URL(String(headers[":path"]), origin),
          {
            method: headers[":method"],
            headers: requestHeaders,
            body,
            signal: context.signal,
          },
        );
        const responseBody = await response.text();
        if (!stream.destroyed) {
          stream.respond({ ":status": response.status });
          stream.end(responseBody);
        }
      };
      transfers.push(
        settleIncludingAbort(forward()).then((result) => {
          if (!result.ok) {
            failures.push(result.error);
            stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
          }
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test APNs address");
  }
  context.mocks.apns.connect.mockImplementation((authority) => {
    if (String(authority) !== origin) {
      const error = new Error(`Unhandled APNs origin: ${String(authority)}`);
      failures.push(error);
      throw error;
    }
    return http2.connect(`http://127.0.0.1:${address.port}`);
  });
  return {
    requests,
    responses,
    publicKey,
    nextRequest: () => {
      return once(arrivals, "request");
    },
    reply: () => {
      const reply = pendingReplies.shift();
      if (!reply) {
        throw new Error("No paused APNs response");
      }
      reply();
    },
  };
}
