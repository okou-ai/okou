import { describe, expect, it } from "vitest";

import { apiTestEnvironment } from "../../__tests__/test-environment";
import {
  apiEnvSchema,
  decodeApiEnv,
  VALIDATED_API_ENV,
} from "../../lib/env-schema";
import {
  parseEnvironmentFile,
  validatedEnvironmentRecord,
} from "../validate-env";

function environmentFile(
  values: Readonly<Record<string, string | undefined>>,
): string {
  return Object.entries(values)
    .map(([key, value]) => {
      return `${key}=${value ?? ""}\n`;
    })
    .join("");
}

describe("validatedEnvironmentRecord", () => {
  it("publishes the decoded values a runtime would otherwise validate", () => {
    const file = environmentFile({
      ...apiTestEnvironment,
      DATABASE_URL: "postgresql://user:pass@db.example.test/neondb?a=b",
      APNS_PRIVATE_KEY_BASE64:
        "-----BEGIN PRIVATE KEY-----\nc2VjcmV0==\n-----END PRIVATE KEY-----",
      OKOU_PRICE_CUSTOM: " price_a, ,price_b ",
      OKOU_ONE_TIME_CAMPAIGN: '{"launch":{"priceId":"p","couponId":"c"}}',
      DB_POOL_MAX: "",
      S3_ENDPOINT: "https://s3.example.test",
      UNRELATED_SECRET: "kept-out-of-the-record",
    });

    const record = parseEnvironmentFile(
      file + validatedEnvironmentRecord(file),
    )[VALIDATED_API_ENV];

    // Runtimes read each schema key from the record instead of validating.
    const published = JSON.parse(record ?? "") as Record<string, unknown>;
    const validated: Readonly<Record<string, unknown>> = decodeApiEnv(
      parseEnvironmentFile(file),
    );
    const names = Object.keys(apiEnvSchema());
    expect(
      names.map((name) => {
        return published[name];
      }),
    ).toStrictEqual(
      names.map((name) => {
        return validated[name];
      }),
    );
    expect(published).toMatchObject({
      DATABASE_URL: "postgresql://user:pass@db.example.test/neondb?a=b",
      APNS_PRIVATE_KEY_BASE64:
        "-----BEGIN PRIVATE KEY-----\nc2VjcmV0==\n-----END PRIVATE KEY-----",
      OKOU_PRICE_CUSTOM: ["price_a", "price_b"],
      OKOU_ONE_TIME_CAMPAIGN: { launch: { priceId: "p", couponId: "c" } },
      DB_POOL_MAX: 10,
      S3_PUBLIC_ENDPOINT: "https://s3.example.test",
    });
  });

  it("publishes the trimmed values the Vercel deployment receives", () => {
    const file = environmentFile({
      ...apiTestEnvironment,
      DATABASE_URL: "postgresql://user:pass@db.example.test/neondb",
      // A secret stored with a final newline renders an extra empty line.
      STRIPE_SECRET_KEY: "sk_test_rendered_with_newline\n",
      CRON_SECRET: "cron-secret  ",
    });

    const record = parseEnvironmentFile(
      file + validatedEnvironmentRecord(file),
    )[VALIDATED_API_ENV];

    expect(JSON.parse(record ?? "")).toMatchObject({
      STRIPE_SECRET_KEY: "sk_test_rendered_with_newline",
      CRON_SECRET: "cron-secret",
    });
  });
});
