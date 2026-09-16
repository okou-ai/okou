import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { PUBLIC_BRAND } from "@okouai/core/public-brand";
import { organizationAuthContext$ } from "../auth/auth-context";
import { writeDb$ } from "../external/db";
import { prepareIntegrationContent$ } from "./integration-artifact-reply.service";

function mapStrings(
  value: unknown,
  replace: (text: string) => string,
): unknown {
  if (typeof value === "string") {
    return replace(value);
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => {
      return mapStrings(item, replace);
    });
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => {
        return [key, mapStrings(item, replace)];
      }),
    );
  }
  return value;
}

/** Rewrite selected message content only; routes retain their target metadata. */
export const snapshotIntegrationMessage$ = command(
  async (
    { get, set },
    args: {
      readonly content: Readonly<Record<string, unknown>>;
      readonly publicBrand?: PublicBrand;
    },
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    const auth = get(organizationAuthContext$);
    const contents = new Set<string>();
    mapStrings(args.content, (text) => {
      contents.add(text);
      return text;
    });
    const originals = [...contents];
    const rewritten = await set(
      prepareIntegrationContent$,
      {
        db: set(writeDb$),
        userId: auth.userId,
        orgId: auth.orgId,
        chatThreadId: null,
        publicBrand: args.publicBrand ?? PUBLIC_BRAND,
        // Each API call is an independent send, including repeated calls in
        // one run. Message-send APIs do not promise provider idempotency.
        deliveryKey: `message:${randomUUID()}`,
        contents: originals,
      },
      signal,
    );
    const replacements = new Map(
      originals.map((text, index) => {
        return [text, rewritten[index]!] as const;
      }),
    );
    return Object.fromEntries(
      Object.entries(args.content).map(([key, value]) => {
        return [
          key,
          mapStrings(value, (text) => {
            return replacements.get(text)!;
          }),
        ];
      }),
    );
  },
);
