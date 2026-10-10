import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";

import type { ConnectorAuthMethodRuntimeConfig } from "../../../connector-config";
import { connectorCatalogAuthMethodSchema } from "../../../connector-catalog/artifacts/artifacts";
import {
  connectorCatalogExecutableCapabilityState,
  evaluateConnectorCatalogCompatibility,
} from "../../../connector-catalog/compatibility";
import { refreshConnectorAuthProviderAccessTokenWithMethod } from "../../connector-auth";
import { ProviderHttpError, ProviderResponseError } from "../../provider-error";
import { server } from "../../__tests__/test-server";

const TOKEN_URL = "https://auth.greenhouse.io/token";
const INPUTS = {
  clientId: "synthetic-client-id",
  clientSecret: "synthetic-client-secret",
  userId: "123",
};
const METHOD_ID = "oauth";
const METHOD = {
  storage: {
    version: 1,
    secrets: ["GREENHOUSE_CLIENT_SECRET", "GREENHOUSE_ACCESS_TOKEN"],
    variables: ["GREENHOUSE_CLIENT_ID", "GREENHOUSE_USER_ID"],
  },
  grant: {
    kind: "manual",
    fields: {
      GREENHOUSE_CLIENT_ID: {
        publicId: "clientId",
        label: "Client ID",
        required: true,
        storage: "variable",
      },
      GREENHOUSE_CLIENT_SECRET: {
        publicId: "clientSecret",
        label: "Client Secret",
        required: true,
        storage: "secret",
      },
      GREENHOUSE_USER_ID: {
        publicId: "userId",
        label: "Authorized User ID",
        required: true,
        storage: "variable",
      },
    },
  },
  access: {
    kind: "refresh-token",
    envBindings: {
      GREENHOUSE_ACCESS_TOKEN: "$secrets.GREENHOUSE_ACCESS_TOKEN",
    },
    inputs: {
      clientId: "$vars.GREENHOUSE_CLIENT_ID",
      clientSecret: "$secrets.GREENHOUSE_CLIENT_SECRET",
      userId: "$vars.GREENHOUSE_USER_ID",
    },
    outputs: { accessToken: "$secrets.GREENHOUSE_ACCESS_TOKEN" },
    refreshableSecrets: ["GREENHOUSE_ACCESS_TOKEN"],
  },
  revoke: { kind: "none" },
} as const satisfies ConnectorAuthMethodRuntimeConfig;

function refresh(signal = new AbortController().signal, inputs = INPUTS) {
  return refreshConnectorAuthProviderAccessTokenWithMethod(
    {
      connectorSlug: "greenhouse",
      authMethodId: METHOD_ID,
      method: METHOD,
      inputs,
    },
    signal,
  );
}

function tokenResponse(
  accessToken = "synthetic-access-token",
  expiresIn = 3600,
) {
  return HttpResponse.json({
    token_type: "Bearer",
    access_token: accessToken,
    expires_in: expiresIn,
  });
}

describe("Greenhouse automatic OAuth access", () => {
  it("acquires and renews tokens through the registered client-credentials contract", async () => {
    const requests: {
      authorization: string | null;
      contentType: string | null;
      parameters: Record<string, string>;
    }[] = [];
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        requests.push({
          authorization: request.headers.get("authorization"),
          contentType: request.headers.get("content-type"),
          parameters: Object.fromEntries(
            new URLSearchParams(await request.text()),
          ),
        });
        return tokenResponse(`synthetic-token-${requests.length}`, 1200);
      }),
    );

    await expect(refresh()).resolves.toEqual({
      outputs: { accessToken: "synthetic-token-1" },
      expiresIn: 1200,
    });
    await expect(refresh()).resolves.toEqual({
      outputs: { accessToken: "synthetic-token-2" },
      expiresIn: 1200,
    });
    expect(requests).toEqual([
      {
        authorization: `Basic ${Buffer.from(`${INPUTS.clientId}:${INPUTS.clientSecret}`).toString("base64")}`,
        contentType: "application/x-www-form-urlencoded",
        parameters: { grant_type: "client_credentials", sub: INPUTS.userId },
      },
      {
        authorization: `Basic ${Buffer.from(`${INPUTS.clientId}:${INPUTS.clientSecret}`).toString("base64")}`,
        contentType: "application/x-www-form-urlencoded",
        parameters: { grant_type: "client_credentials", sub: INPUTS.userId },
      },
    ]);
  });

  it.each([401, 403, 429, 500])(
    "surfaces HTTP %s without provider bodies or credentials",
    async (status) => {
      server.use(
        http.post(TOKEN_URL, () => {
          return new HttpResponse(
            `private-provider-body ${INPUTS.clientSecret}`,
            { status },
          );
        }),
      );
      const result = refresh();
      await expect(result).rejects.toBeInstanceOf(ProviderHttpError);
      await expect(result).rejects.toMatchObject({
        status,
        message: `Greenhouse access token request failed: ${status}`,
      });
    },
  );

  it.each([
    { token_type: "Basic", access_token: "private-token", expires_in: 3600 },
    { token_type: "Bearer", access_token: "", expires_in: 3600 },
    { token_type: "Bearer", access_token: "private-token", expires_in: 0 },
    { token_type: "Bearer", access_token: "private-token", expires_in: 1.5 },
    { token_type: "Bearer", access_token: "private-token", expires_in: "3600" },
    { access_token: "private-token", expires_in: 3600 },
  ])("rejects an incomplete or invalid OAuth response: %j", async (payload) => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json(payload);
      }),
    );
    const result = refresh();
    await expect(result).rejects.toBeInstanceOf(ProviderResponseError);
    await expect(result).rejects.toHaveProperty(
      "message",
      "Invalid Greenhouse access token response",
    );
  });

  it("rejects malformed JSON without echoing its body", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return new HttpResponse("private-invalid-json", {
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    await expect(refresh()).rejects.toHaveProperty(
      "message",
      "Invalid Greenhouse access token response",
    );
  });

  it.each(["", "user@example.com", "123&scope=all"])(
    "rejects invalid subject %j instead of selecting the service user",
    async (userId) => {
      server.use(
        http.post(TOKEN_URL, () => {
          return tokenResponse();
        }),
      );
      await expect(
        refresh(undefined, { ...INPUTS, userId }),
      ).rejects.toHaveProperty(
        "message",
        "Invalid Greenhouse authorizing user ID",
      );
    },
  );

  it("refuses token endpoint redirects", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.redirect("https://example.invalid/token", 307);
      }),
      http.post("https://example.invalid/token", () => {
        return tokenResponse();
      }),
    );
    await expect(refresh()).rejects.toThrow();
  });

  it("honors cancellation before sending credentials", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(refresh(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("honors the owning signal while the token exchange is in flight", async () => {
    const controller = new AbortController();
    server.use(
      http.post(TOKEN_URL, () => {
        controller.abort();
        return tokenResponse();
      }),
    );
    await expect(refresh(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});

function catalogMethod() {
  return connectorCatalogAuthMethodSchema.parse({
    ...METHOD,
    id: METHOD_ID,
    label: "OAuth",
    description: null,
    visible: true,
    grant: {
      kind: "manual",
      fields: Object.entries(METHOD.grant.fields).map(
        ([privateName, field]) => {
          return {
            ...field,
            privateName,
            placeholder: null,
          };
        },
      ),
    },
  });
}

describe("Greenhouse executable OAuth rollout", () => {
  it("admits the matching catalog without global client configuration", () => {
    expect(
      evaluateConnectorCatalogCompatibility({
        artifact: {
          connectors: [{ slug: "greenhouse", authMethods: [catalogMethod()] }],
        },
        capability: connectorCatalogExecutableCapabilityState({
          isConfigured: () => {
            return false;
          },
        }),
      }),
    ).toEqual([]);
  });

  it("filters the new method when its provider registration is unavailable", () => {
    const capability = connectorCatalogExecutableCapabilityState({
      isConfigured: () => {
        return false;
      },
    });
    expect(
      evaluateConnectorCatalogCompatibility({
        artifact: {
          connectors: [{ slug: "greenhouse", authMethods: [catalogMethod()] }],
        },
        capability: {
          ...capability,
          registrations: capability.registrations.filter((registration) => {
            return registration.connectorSlug !== "greenhouse";
          }),
        },
      }),
    ).toEqual([
      {
        connectorSlug: "greenhouse",
        authMethodId: METHOD_ID,
        reasons: ["missing-access-provider"],
      },
    ]);
  });

  it("leaves the legacy generic static method compatible during consumer-first deployment", () => {
    const legacyMethod = connectorCatalogAuthMethodSchema.parse({
      id: "api-token",
      label: "API key",
      description: null,
      visible: true,
      storage: { version: 1, secrets: ["GREENHOUSE_TOKEN"], variables: [] },
      grant: {
        kind: "manual",
        fields: [
          {
            privateName: "GREENHOUSE_TOKEN",
            publicId: "apiKey",
            label: "API key",
            required: true,
            placeholder: null,
            storage: "secret",
          },
        ],
      },
      access: {
        kind: "static",
        envBindings: { GREENHOUSE_TOKEN: "$secrets.GREENHOUSE_TOKEN" },
      },
      revoke: { kind: "none" },
    });
    expect(
      evaluateConnectorCatalogCompatibility({
        artifact: {
          connectors: [{ slug: "greenhouse", authMethods: [legacyMethod] }],
        },
        capability: connectorCatalogExecutableCapabilityState({
          isConfigured: () => {
            return false;
          },
        }),
      }),
    ).toEqual([]);
  });
});
