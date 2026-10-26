import http2 from "node:http2";
import { once } from "node:events";
import { SignJWT, importPKCS8 } from "jose";
import { v5 as uuidv5 } from "uuid";
import { env } from "../../lib/env";
import { now } from "../../lib/time";
import { safeJsonParse, settleIncludingAbort } from "../utils";
import { singleton } from "../../lib/singleton";

type ApnsEnvironment = "production" | "sandbox";
const tokens = singleton(() => {
  return new Map<
    ApnsEnvironment,
    {
      keyId: string;
      teamId: string;
      privateKey: string;
      jwt: string;
      expires: number;
    }
  >();
});

function configuration(environment: ApnsEnvironment) {
  // The production key is topic/environment restricted. Never use it for sandbox.
  const privateKey = env(
    environment === "production"
      ? "APNS_PRIVATE_KEY_BASE64"
      : "APNS_SANDBOX_PRIVATE_KEY_BASE64",
  );
  const keyId = env(
    environment === "production" ? "APNS_KEY_ID" : "APNS_SANDBOX_KEY_ID",
  );
  const teamId = env(
    environment === "production" ? "APNS_TEAM_ID" : "APNS_SANDBOX_TEAM_ID",
  );
  if (!privateKey && !keyId && !teamId) {
    return null;
  }
  if (!privateKey || !keyId || !teamId) {
    throw new Error(`Incomplete APNs ${environment} configuration`);
  }
  return { privateKey, keyId, teamId };
}

export function hasApnsConfiguration(environment: ApnsEnvironment): boolean {
  return configuration(environment) !== null;
}

async function providerToken(environment: ApnsEnvironment): Promise<string> {
  const config = configuration(environment);
  if (!config) {
    throw new Error(`Missing APNs ${environment} configuration`);
  }
  const cached = tokens().get(environment);
  if (
    cached &&
    cached.expires > now() &&
    cached.privateKey === config.privateKey &&
    cached.keyId === config.keyId &&
    cached.teamId === config.teamId
  ) {
    return cached.jwt;
  }
  const key = await importPKCS8(
    Buffer.from(config.privateKey, "base64").toString("utf8"),
    "ES256",
  );
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: config.keyId })
    .setIssuer(config.teamId)
    .setIssuedAt(Math.floor(now() / 1000))
    .sign(key);
  tokens().set(environment, { ...config, jwt, expires: now() + 50 * 60_000 });
  return jwt;
}

/** One bounded provider attempt. Callback replay retains the existing at-least-once semantics. */
export async function sendApnsNotification(
  args: {
    readonly environment: ApnsEnvironment;
    readonly deviceToken: string;
    readonly notificationId: string;
    readonly payload: string;
  },
  signal: AbortSignal,
): Promise<{ readonly status: number; readonly reason?: string }> {
  const jwt = await providerToken(args.environment);
  signal.throwIfAborted();
  const session = http2.connect(
    args.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com",
  );
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const send = async () => {
    const request = session.request(
      {
        ":method": "POST",
        ":path": `/3/device/${args.deviceToken}`,
        authorization: `bearer ${jwt}`,
        "apns-topic": "ai.okou.ios",
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(now() / 1000) + 3600),
        "apns-collapse-id": args.notificationId,
        "apns-id": uuidv5(args.notificationId, uuidv5.URL),
      },
      { signal: deadline },
    );
    session.on("error", (error) => {
      request.destroy(error);
    });
    const response = once(request, "response", { signal: deadline });
    const ended = once(request, "end", { signal: deadline });
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 4096) {
        session.destroy(new Error("Oversized APNs response"));
      }
    });
    request.end(args.payload);
    const headers: unknown = (await Promise.all([response, ended]))[0][0];
    const status =
      headers && typeof headers === "object" && ":status" in headers
        ? Number(headers[":status"])
        : 0;
    const parsed = safeJsonParse(body);
    const reason =
      parsed &&
      typeof parsed === "object" &&
      "reason" in parsed &&
      typeof parsed.reason === "string"
        ? parsed.reason
        : undefined;
    return { status, reason };
  };
  const sent = await settleIncludingAbort(send());
  session.destroy();
  if (!sent.ok) {
    throw sent.error;
  }
  return sent.value;
}
