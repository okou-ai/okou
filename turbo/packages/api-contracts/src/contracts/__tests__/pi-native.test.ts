import { describe, expect, it } from "vitest";
import {
  piModelConfigSchema,
  piModelConfigV2Schema,
  piModelConfigV3Schema,
} from "../runners";
import {
  PI_NATIVE_CREDENTIAL_PLACEHOLDER,
  piModelConfigV4Schema,
  piNativeInferenceUrl,
} from "../pi-native";
import {
  piNativeContextHasExactEgress,
  piNativeFirewall,
} from "../pi-native-firewall";
import fixtures from "./fixtures/pi-native.json";

describe("native Pi generation and egress contract", () => {
  it("rejects US Messages for user keys and unsupported models", () => {
    const fixture = fixtures.find(({ name }) => {
      return name === "built-in US anthropic/claude-sonnet-4.6";
    });
    if (!fixture) throw new Error("Missing US native fixture");
    for (const changed of [
      { credentialOwner: "organization", billingOwner: "user" },
      { credentialOwner: "member", billingOwner: "user" },
      { model: "anthropic/claude-fable-5.1", catalogModel: "claude-fable-5-1" },
      { baseUrl: "https://us.openrouter.ai/api/v1" },
    ]) {
      expect(
        piModelConfigV4Schema.safeParse({ ...fixture.config, ...changed })
          .success,
      ).toBe(false);
    }
  });
  it.each(fixtures)("reads $name only as generation 4", ({ config }) => {
    expect(piModelConfigSchema.parse(config)).toStrictEqual(config);
    expect(piModelConfigV2Schema.safeParse(config).success).toBe(false);
    expect(piModelConfigV3Schema.safeParse(config).success).toBe(false);
    expect(
      piModelConfigSchema.safeParse({ ...config, schemaVersion: 5 }).success,
    ).toBe(false);
  });

  it.each(fixtures)(
    "binds $name to exactly one native inference target",
    ({ config: input }) => {
      const config = piModelConfigV4Schema.parse(input);
      const firewall = piNativeFirewall(config);
      expect(firewall.apis).toHaveLength(1);
      expect(firewall.apis[0]?.base).toBe(piNativeInferenceUrl(config));
      expect(firewall.apis[0]?.hostPolicy).toStrictEqual({
        kind: "publicDestination",
      });
      const environment = Object.fromEntries(
        config.credentialBindings.map((binding) => {
          return [binding.environment, PI_NATIVE_CREDENTIAL_PLACEHOLDER];
        }),
      );
      const context = {
        environment,
        firewalls: [{ kind: "inline" as const, firewall }],
      };
      expect(piNativeContextHasExactEgress(config, context)).toBe(true);
      expect(
        piNativeContextHasExactEgress(config, { ...context, environment: {} }),
      ).toBe(false);
      expect(
        piNativeContextHasExactEgress(config, { ...context, firewalls: [] }),
      ).toBe(false);
      expect(
        piNativeContextHasExactEgress(config, {
          ...context,
          firewalls: [...context.firewalls, ...context.firewalls],
        }),
      ).toBe(false);
      const api = firewall.apis[0];
      if (!api) throw new Error("Missing native firewall");
      expect(
        piNativeContextHasExactEgress(config, {
          ...context,
          firewalls: [
            {
              kind: "inline",
              firewall: {
                ...firewall,
                apis: [{ ...api, base: config.baseUrl }],
              },
            },
          ],
        }),
      ).toBe(false);
    },
  );

  it.each(fixtures)(
    "fails closed on incompatible $name policy",
    ({ config }) => {
      for (const changed of [
        { transport: "sse-over-responses" },
        { api: "openai-responses" },
        { catalogModel: "claude-fable-5" },
        { credentialOwner: "subscription" },
        {
          billingOwner: config.billingOwner === "builtin" ? "user" : "builtin",
        },
        { requestPolicy: { maxAttempts: 3, cacheRetention: "short" } },
        { requestPolicy: { maxAttempts: 1, cacheRetention: "long" } },
        { credentialBindings: [] },
        { serviceTier: "fast" },
      ])
        expect(
          piModelConfigV4Schema.safeParse({ ...config, ...changed }).success,
          JSON.stringify(changed),
        ).toBe(false);
    },
  );

  it.each([
    "http://gateway.example.com",
    "https://127.0.0.1",
    "https://169.254.169.254",
    "https://10.1.1.1",
    "https://localhost",
    "https://private.local",
    "https://user:password@gateway.example.com",
    "https://gateway.example.com/?key=x",
    "https://gateway.example.com/{path}",
  ])("rejects unsafe custom endpoint %s", (baseUrl) => {
    const config = fixtures.find((fixture) => {
      return fixture.name === "custom";
    })?.config;
    expect(
      piModelConfigV4Schema.safeParse({ ...config, baseUrl }).success,
    ).toBe(false);
  });

  it("rejects mismatched cloud resources, regions, tokens and bundles", () => {
    const foundry = fixtures.find((fixture) => {
      return fixture.name === "foundry";
    })?.config;
    expect(
      piModelConfigV4Schema.safeParse({
        ...foundry,
        baseUrl: "https://native-fixture.openai.azure.com",
      }).success,
    ).toBe(false);
    const bedrock = fixtures.find((fixture) => {
      return fixture.name === "bedrock sigv4-session";
    })?.config;
    expect(
      piModelConfigV4Schema.safeParse({ ...bedrock, region: "us-west-2" })
        .success,
    ).toBe(false);
    expect(
      piModelConfigV4Schema.safeParse({ ...bedrock, authMode: "bearer" })
        .success,
    ).toBe(false);
    const messages = fixtures[0]?.config;
    expect(
      piModelConfigV4Schema.safeParse({
        ...messages,
        credentialBindings: [
          {
            kind: "api-key",
            environment: "CLAUDE_CODE_OAUTH_TOKEN",
            secretName: "CLAUDE_CODE_OAUTH_TOKEN",
            credentialHeader: {
              name: "Authorization",
              valueTemplate: "Bearer {{secret}}",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });
});
