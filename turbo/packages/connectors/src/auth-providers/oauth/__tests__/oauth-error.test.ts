import { describe, it, expect } from "vitest";
import {
  isOAuthProviderHttpError,
  OAuthProviderHttpError,
  oauthFailureDiagnostics,
  throwOAuthError,
} from "../error";
import { ProviderHttpError, ProviderResponseError } from "../../provider-error";

function makeResponse(status: number, body: string): Response {
  return new Response(body, { status, statusText: "Bad Request" });
}

describe("throwOAuthError", () => {
  it("includes error and error_description from JSON response", async () => {
    const response = makeResponse(
      400,
      JSON.stringify({
        error: "invalid_grant",
        error_description: "The refresh token is expired",
      }),
    );

    await expect(
      throwOAuthError("Notion", "refresh", response),
    ).rejects.toThrow(
      "Notion token refresh failed: 400 invalid_grant (The refresh token is expired)",
    );
  });

  it("includes error code alone when no description", async () => {
    const response = makeResponse(
      401,
      JSON.stringify({ error: "unauthorized_client" }),
    );

    await expect(
      throwOAuthError("Figma", "exchange", response),
    ).rejects.toThrow("Figma token exchange failed: 401 unauthorized_client");
  });

  it("includes raw text for non-JSON response", async () => {
    const response = makeResponse(500, "Internal Server Error");

    await expect(
      throwOAuthError("GitHub", "exchange", response),
    ).rejects.toThrow(
      "GitHub token exchange failed: 500 Internal Server Error",
    );
  });

  it("handles empty response body", async () => {
    const response = makeResponse(502, "");

    await expect(
      throwOAuthError("Slack", "exchange", response),
    ).rejects.toThrow("Slack token exchange failed: 502");
  });

  it("throws a typed HTTP error with status", async () => {
    const response = makeResponse(502, "");

    const error = await throwOAuthError("Slack", "exchange", response).catch(
      (e: unknown) => {
        return e;
      },
    );

    expect(isOAuthProviderHttpError(error)).toBe(true);
    expect(isOAuthProviderHttpError(error) ? error.status : null).toBe(502);
  });

  it("preserves the standard OAuth error code", async () => {
    const response = makeResponse(
      400,
      JSON.stringify({
        error: "invalid_grant",
        error_description: "The refresh token is expired",
      }),
    );

    const error = await throwOAuthError("Notion", "refresh", response).catch(
      (e: unknown) => {
        return e;
      },
    );

    expect(isOAuthProviderHttpError(error) ? error.oauthError : null).toBe(
      "invalid_grant",
    );
    expect(
      isOAuthProviderHttpError(error) ? error.oauthErrorSubtype : null,
    ).toBeUndefined();
  });

  it("preserves provider-specific OAuth error subtype", async () => {
    const response = makeResponse(
      400,
      JSON.stringify({
        error: "invalid_grant",
        error_description: "Session control expired",
        error_subtype: "invalid_rapt",
      }),
    );

    const error = await throwOAuthError(
      "Google Cloud",
      "refresh",
      response,
    ).catch((e: unknown) => {
      return e;
    });

    expect(isOAuthProviderHttpError(error)).toBe(true);
    if (!isOAuthProviderHttpError(error)) {
      throw new Error("Expected OAuthProviderHttpError");
    }
    expect(error.oauthError).toBe("invalid_grant");
    expect(error.oauthErrorSubtype).toBe("invalid_rapt");
    expect(error.message).toContain("Session control expired");
  });

  it("truncates long response bodies", async () => {
    const longBody = "x".repeat(600);
    const response = makeResponse(400, longBody);

    const error = await throwOAuthError("Notion", "refresh", response).catch(
      (e: Error) => {
        return e;
      },
    );

    expect(error.message).toContain("Notion token refresh failed: 400 ");
    expect(error.message).toMatch(/\.\.\.$/);
    // 500 chars + "..." = truncated
    const detail = error.message.replace(
      "Notion token refresh failed: 400 ",
      "",
    );
    expect(detail.length).toBeLessThanOrEqual(504); // 500 + "..."
  });

  it("truncates long OAuth error descriptions", async () => {
    const longDescription = "x".repeat(600);
    const response = makeResponse(
      400,
      JSON.stringify({
        error: "invalid_grant",
        error_description: longDescription,
      }),
    );

    const error = await throwOAuthError("Notion", "refresh", response).catch(
      (e: Error) => {
        return e;
      },
    );

    expect(error.message).toBe(
      `Notion token refresh failed: 400 invalid_grant (${"x".repeat(500)}...)`,
    );
  });

  it("includes full JSON body when no standard error fields", async () => {
    const response = makeResponse(
      400,
      JSON.stringify({ message: "something went wrong", code: 123 }),
    );

    await expect(
      throwOAuthError("Stripe", "refresh", response),
    ).rejects.toThrow(
      'Stripe token refresh failed: 400 {"message":"something went wrong","code":123}',
    );
  });

  it("includes valid JSON scalar response bodies", async () => {
    const response = makeResponse(400, JSON.stringify("temporarily down"));

    await expect(
      throwOAuthError("Stripe", "refresh", response),
    ).rejects.toThrow('Stripe token refresh failed: 400 "temporarily down"');
  });
});

describe("oauthFailureDiagnostics", () => {
  it("keeps only bounded error metadata without provider-controlled values", () => {
    const secret = "provider-controlled-secret-canary";
    const knownError = new OAuthProviderHttpError(
      secret,
      400,
      "invalid_client",
      secret,
      secret,
    );
    expect(oauthFailureDiagnostics(knownError)).toStrictEqual({
      failureKind: "oauth_http",
      httpStatus: 400,
      oauthError: "invalid_client",
    });
    const cause = new SyntaxError(secret, { cause: { [secret]: secret } });
    cause.name = secret;
    const unexpected = new TypeError(secret, { cause });
    unexpected.name = secret;
    unexpected.stack = secret;
    expect(oauthFailureDiagnostics(unexpected)).toStrictEqual({
      failureKind: "unexpected",
      exceptionClass: "TypeError",
      causeClass: "SyntaxError",
    });
    const untrustedErrors = [
      unexpected,
      new OAuthProviderHttpError(secret, 400, secret, secret, secret),
      new ProviderHttpError(secret, 403),
      new ProviderResponseError(secret),
      new ProviderResponseError(
        secret,
        {
          stage: "profile",
          reason: "provider_error",
          invalidFields: [secret],
          providerCode: secret,
          contentType: secret,
        },
        { access_token: secret, [secret]: secret },
      ),
      new Error(secret, { cause: secret }),
      { message: secret, status: secret, oauthError: secret },
    ];
    for (const error of untrustedErrors) {
      expect(JSON.stringify(oauthFailureDiagnostics(error))).not.toContain(
        secret,
      );
    }
  });
});
