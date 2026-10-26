import { accept } from "@okouai/connectors/accept";
import { Buffer } from "node:buffer";
import { createSign } from "node:crypto";

import { now } from "../../lib/time";

const INSTALLATION_ID_RE = /^\d+$/;

function validateInstallationId(installationId: string): string {
  if (!INSTALLATION_ID_RE.test(installationId)) {
    throw new Error(
      `Invalid GitHub installation ID: expected numeric string, got "${installationId}"`,
    );
  }
  return installationId;
}

function base64url(value: string): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function parsePemKey(input: string): string {
  if (!input.startsWith("-----BEGIN")) {
    return Buffer.from(input, "base64").toString("utf8");
  }

  const match = input.match(
    /^(-----BEGIN [^-]+-----)[\s]+([\s\S]+?)[\s]+(-----END [^-]+-----)$/,
  );
  if (!match) {
    return input;
  }

  const header = match[1];
  const bodyMatch = match[2];
  const footer = match[3];
  if (!header || !bodyMatch || !footer) {
    return input;
  }

  const body = bodyMatch.replace(/\s+/g, "\n");
  return `${header}\n${body}\n${footer}\n`;
}

function createAppJwt(appId: string, privateKeyPemOrBase64: string): string {
  const nowSeconds = Math.floor(now() / 1000);
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64url(
    JSON.stringify({
      iat: nowSeconds - 60,
      exp: nowSeconds + 600,
      iss: appId,
    }),
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(
    parsePemKey(privateKeyPemOrBase64),
    "base64url",
  );

  return `${signingInput}.${signature}`;
}

export async function getGithubInstallationAccessToken(
  args: {
    readonly appId: string;
    readonly privateKey: string;
    readonly installationId: string;
  },
  _signal: AbortSignal,
): Promise<{ readonly token: string; readonly expiresAt: string }> {
  const installationId = validateInstallationId(args.installationId);
  const jwt = createAppJwt(args.appId, args.privateKey);
  const response = await accept(
    fetch(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    ),
    [201],
  );

  const data = (await response.json()) as {
    readonly token: string;
    readonly expires_at: string;
  };
  return { token: data.token, expiresAt: data.expires_at };
}
