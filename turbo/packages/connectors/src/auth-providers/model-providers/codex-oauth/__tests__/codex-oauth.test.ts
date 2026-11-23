import { describe, expect, it } from "vitest";
import { HttpResponse, http } from "msw";
import { getModelProviderRefreshMetadata } from "../../../model-provider-auth";
import {
  getChatgptSecretName,
  getChatgptRefreshSecretName,
  isChatgptRefreshError,
  refreshChatgptToken,
  type ChatgptRefreshError,
} from "../oauth";
import { codexOauthProvider } from "../provider";
import { server } from "../../../__tests__/test-server";

const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_PUBLIC_CLIENT_ID = "test-codex-client-id";

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

function getCodexRefreshAccess() {
  return codexOauthProvider.access;
}

describe("connector/providers/codex-oauth", () => {
  describe("refreshChatgptToken", () => {
    it("refreshes access token and returns rotated refresh token", async () => {
      const handler = http.post(TOKEN_URL, async ({ request }) => {
        expect(request.headers.get("content-type")).toBe("application/json");
        const body = (await request.json()) as Record<string, unknown>;
        expect(body.client_id).toBe(CODEX_PUBLIC_CLIENT_ID);
        expect(body.grant_type).toBe("refresh_token");
        expect(body.refresh_token).toBe("old-rt");
        return HttpResponse.json({
          access_token: "new-at",
          refresh_token: "new-rt",
          expires_in: 600000,
        });
      });
      server.use(handler);

      const result = await refreshChatgptToken(
        CODEX_PUBLIC_CLIENT_ID,
        "old-rt",
        testRefreshSignal(),
      );
      expect(result.accessToken).toBe("new-at");
      expect(result.refreshToken).toBe("new-rt");
      expect(result.expiresIn).toBe(600000);
    });

    it("returns null refresh token when response omits it", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({ access_token: "new-at" });
      });
      server.use(handler);

      const result = await refreshChatgptToken(
        CODEX_PUBLIC_CLIENT_ID,
        "old-rt",
        testRefreshSignal(),
      );
      expect(result.accessToken).toBe("new-at");
      expect(result.refreshToken).toBeNull();
    });

    it("classifies refresh_token_expired into ChatgptRefreshError", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_expired",
              message: "token expired",
            },
          },
          { status: 401 },
        );
      });
      server.use(handler);

      await expect(
        refreshChatgptToken(
          CODEX_PUBLIC_CLIENT_ID,
          "old-rt",
          testRefreshSignal(),
        ),
      ).rejects.toMatchObject({
        name: "ChatgptRefreshError",
        code: "refresh_token_expired",
      });
    });

    it("classifies refresh_token_reused into ChatgptRefreshError", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          { error: { code: "refresh_token_reused", message: "reused" } },
          { status: 401 },
        );
      });
      server.use(handler);

      await expect(
        refreshChatgptToken(
          CODEX_PUBLIC_CLIENT_ID,
          "old-rt",
          testRefreshSignal(),
        ),
      ).rejects.toMatchObject({
        name: "ChatgptRefreshError",
        code: "refresh_token_reused",
      });
    });

    it("classifies refresh_token_invalidated into ChatgptRefreshError", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          {
            error: {
              code: "refresh_token_invalidated",
              message: "invalidated",
            },
          },
          { status: 401 },
        );
      });
      server.use(handler);

      const error = await refreshChatgptToken(
        CODEX_PUBLIC_CLIENT_ID,
        "old-rt",
        testRefreshSignal(),
      ).catch((e: unknown) => {
        return e;
      });
      expect(isChatgptRefreshError(error)).toBe(true);
      expect((error as ChatgptRefreshError).code).toBe(
        "refresh_token_invalidated",
      );
    });

    it("classifies unknown 401 codes into refresh_token_other", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json(
          { error: { code: "weird_unrelated_error", message: "huh" } },
          { status: 401 },
        );
      });
      server.use(handler);

      const error = await refreshChatgptToken(
        CODEX_PUBLIC_CLIENT_ID,
        "old-rt",
        testRefreshSignal(),
      ).catch((e: unknown) => {
        return e;
      });
      expect(isChatgptRefreshError(error)).toBe(true);
      expect((error as ChatgptRefreshError).code).toBe("refresh_token_other");
    });

    it("throws non-typed error on 5xx so caller can retry", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return new HttpResponse("Bad Gateway", { status: 502 });
      });
      server.use(handler);

      const error = await refreshChatgptToken(
        CODEX_PUBLIC_CLIENT_ID,
        "old-rt",
        testRefreshSignal(),
      ).catch((e: unknown) => {
        return e;
      });
      expect(error).toBeInstanceOf(Error);
      expect(isChatgptRefreshError(error)).toBe(false);
    });

    it("throws when refresh response is missing access_token", async () => {
      const handler = http.post(TOKEN_URL, () => {
        return HttpResponse.json({});
      });
      server.use(handler);

      await expect(
        refreshChatgptToken(
          CODEX_PUBLIC_CLIENT_ID,
          "old-rt",
          testRefreshSignal(),
        ),
      ).rejects.toThrow(/No access token in ChatGPT refresh response/);
    });
  });

  describe("codexOauthProvider", () => {
    it("is registered with model-provider refresh metadata", () => {
      expect(
        getModelProviderRefreshMetadata("codex-oauth-token"),
      ).toStrictEqual({
        isRefreshable: true,
        inputs: {
          refreshToken: "CHATGPT_REFRESH_TOKEN",
        },
        outputs: {
          accessToken: "CHATGPT_ACCESS_TOKEN",
          refreshToken: "CHATGPT_REFRESH_TOKEN",
        },
        refreshableSecrets: ["CHATGPT_ACCESS_TOKEN"],
      });
    });

    it("does not expose browser authorize or code exchange helpers", () => {
      expect(codexOauthProvider.grant.kind).toBe("none");
    });

    it("resolves the Codex public client for refresh", () => {
      const access = getCodexRefreshAccess();
      expect(access.resolveAuthClient({})).toBeUndefined();
      expect(
        access.resolveAuthClient({
          CODEX_OAUTH_CLIENT_ID: CODEX_PUBLIC_CLIENT_ID,
        }),
      ).toStrictEqual({
        clientRegistration: "static",
        clientType: "public",
        clientId: CODEX_PUBLIC_CLIENT_ID,
      });
    });

    it("returns documented secret names", () => {
      expect(getChatgptSecretName()).toBe("CHATGPT_ACCESS_TOKEN");
      expect(getChatgptRefreshSecretName()).toBe("CHATGPT_REFRESH_TOKEN");
    });
  });
});
