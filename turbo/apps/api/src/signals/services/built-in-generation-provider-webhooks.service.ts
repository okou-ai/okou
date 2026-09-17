import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";

import { apiBackendUrl } from "../../lib/api-backend-url";
import { env } from "../../lib/env";
import { webUrl } from "../../lib/web-url";

type BuiltInGenerationProviderWebhookProvider =
  | "fal"
  | "byteplus"
  | "minimax"
  | "heygen";

function webhookTokenPayload(args: {
  readonly provider: BuiltInGenerationProviderWebhookProvider;
  readonly generationId: string;
  readonly visualKey: string | undefined;
}): string {
  return [args.provider, args.generationId, args.visualKey ?? ""].join(":");
}

function signBuiltInGenerationProviderWebhookToken(args: {
  readonly provider: BuiltInGenerationProviderWebhookProvider;
  readonly generationId: string;
  readonly visualKey?: string;
}): string {
  return createHmac("sha256", env("SECRETS_ENCRYPTION_KEY"))
    .update(
      webhookTokenPayload({
        provider: args.provider,
        generationId: args.generationId,
        visualKey: args.visualKey,
      }),
    )
    .digest("hex");
}

export function verifyBuiltInGenerationProviderWebhookToken(args: {
  readonly provider: BuiltInGenerationProviderWebhookProvider;
  readonly generationId: string;
  readonly visualKey: string | undefined;
  readonly token: string;
}): boolean {
  const expected = signBuiltInGenerationProviderWebhookToken({
    provider: args.provider,
    generationId: args.generationId,
    visualKey: args.visualKey,
  });
  const actual = Buffer.from(args.token);
  const expectedBuffer = Buffer.from(expected);
  if (actual.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(actual, expectedBuffer);
}

export function verifyJoggAiWebhookSignature(args: {
  readonly body: string;
  readonly secret: string;
  readonly signature: string;
}): boolean {
  const expected = Buffer.from(
    createHmac("sha256", args.secret).update(args.body).digest("hex"),
  );
  const actual = Buffer.from(args.signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function falBuiltInGenerationWebhookUrl(args: {
  readonly generationId: string;
  readonly visualKey?: string;
}): string {
  const baseUrl = new URL(
    `/api/webhooks/built-in-generations/fal/${args.generationId}`,
    apiBackendUrl() ?? webUrl(),
  );
  baseUrl.searchParams.set(
    "token",
    signBuiltInGenerationProviderWebhookToken({
      provider: "fal",
      generationId: args.generationId,
      visualKey: args.visualKey,
    }),
  );
  if (args.visualKey) {
    baseUrl.searchParams.set("visualKey", args.visualKey);
  }
  return baseUrl.toString();
}

export function bytePlusBuiltInGenerationWebhookUrl(args: {
  readonly generationId: string;
  readonly visualKey?: string;
}): string {
  const baseUrl = new URL(
    `/api/webhooks/built-in-generations/byteplus/${args.generationId}`,
    apiBackendUrl() ?? webUrl(),
  );
  baseUrl.searchParams.set(
    "token",
    signBuiltInGenerationProviderWebhookToken({
      provider: "byteplus",
      generationId: args.generationId,
      visualKey: args.visualKey,
    }),
  );
  if (args.visualKey) {
    baseUrl.searchParams.set("visualKey", args.visualKey);
  }
  return baseUrl.toString();
}

export function miniMaxBuiltInGenerationWebhookUrl(args: {
  readonly generationId: string;
  readonly visualKey?: string;
}): string {
  const baseUrl = new URL(
    `/api/webhooks/built-in-generations/minimax/${args.generationId}`,
    apiBackendUrl() ?? webUrl(),
  );
  baseUrl.searchParams.set(
    "token",
    signBuiltInGenerationProviderWebhookToken({
      provider: "minimax",
      generationId: args.generationId,
      visualKey: args.visualKey,
    }),
  );
  if (args.visualKey) {
    baseUrl.searchParams.set("visualKey", args.visualKey);
  }
  return baseUrl.toString();
}

export function heyGenBuiltInGenerationWebhookUrl(args: {
  readonly generationId: string;
}): string {
  const baseUrl = new URL(
    `/api/webhooks/built-in-generations/heygen/${args.generationId}`,
    apiBackendUrl() ?? webUrl(),
  );
  baseUrl.searchParams.set(
    "token",
    signBuiltInGenerationProviderWebhookToken({
      provider: "heygen",
      generationId: args.generationId,
    }),
  );
  return baseUrl.toString();
}
