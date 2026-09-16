import { describe, expect, it } from "vitest";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";

import {
  generateOkouToken,
  isPatToken,
  isSandboxToken,
  signPatJwtForTests,
  signSandboxJwtForTests,
  verifyCliToken,
  verifyComposeJobToken,
  verifySandboxToken,
  verifyOkouToken,
} from "../tokens";
import { now } from "../../../lib/time";
import { safeJsonParse } from "../../utils";

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function decodeOkouTokenPayloadForTest(token: string): Record<string, unknown> {
  const payload = token.slice("vm0_sandbox_".length).split(".")[1];
  if (!payload) {
    throw new Error("Expected a signed Okou token payload");
  }
  const parsed = safeJsonParse(Buffer.from(payload, "base64url").toString());
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Expected a signed Okou token object payload");
  }
  return Object.fromEntries(Object.entries(parsed));
}

describe("auth tokens", () => {
  it("verifies PAT CLI tokens", () => {
    const nowSeconds = currentSecond();
    const token = signPatJwtForTests({
      scope: "cli",
      userId: "user_pat",
      orgId: "org_pat",
      tokenId: "token_pat",
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    expect(isPatToken(token)).toBeTruthy();
    expect(verifyCliToken(token)).toStrictEqual({
      userId: "user_pat",
      orgId: "org_pat",
      tokenId: "token_pat",
    });
  });

  it("verifies sandbox and okou tokens behind the sandbox prefix", () => {
    const nowSeconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    const okouToken = signSandboxJwtForTests({
      scope: "okou",
      userId: "user_okou",
      orgId: "org_okou",
      runId: "run_okou",
      capabilities: ["file:write"],
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    expect(isSandboxToken(sandboxToken)).toBeTruthy();
    expect(verifySandboxToken(sandboxToken)).toStrictEqual({
      userId: "user_sandbox",
      orgId: "org_sandbox",
      runId: "run_sandbox",
    });
    expect(verifyOkouToken(sandboxToken)).toBeNull();
    expect(verifyOkouToken(okouToken)).toStrictEqual({
      userId: "user_okou",
      orgId: "org_okou",
      runId: "run_okou",
      capabilities: ["file:write"],
    });
  });

  it("generates a run token with the okou scope behind the sandbox prefix", () => {
    const okouToken = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(okouToken).toMatch(/^vm0_sandbox_/u);
    expect(decodeOkouTokenPayloadForTest(okouToken)).toMatchObject({
      scope: "okou",
    });
    expect(verifyOkouToken(okouToken)).toMatchObject({
      userId: "user_okou",
      runId: "run_okou",
      orgId: "org_okou",
    });
  });

  it("generates one Okou-scoped run token with the complete run claims", () => {
    const computerUseHostId = "00000000-0000-4000-8000-000000000001";
    const customConnectorId = "00000000-0000-4000-8000-000000000002";
    const customConnectorSourceId = "00000000-0000-4000-8000-000000000003";
    const okouToken = generateOkouToken(
      "user_shared",
      "run_shared",
      "org_shared",
      { [FeatureSwitchKey.Banking]: true },
      {
        computerUseHostId,
        cloudBrowserEnabled: true,
        imageRecognitionAvailable: true,
        customConnectorSourceIds: {
          [customConnectorId]: customConnectorSourceId,
        },
      },
    );

    const okouPayload = decodeOkouTokenPayloadForTest(okouToken);
    expect(okouPayload).toMatchObject({
      scope: "okou",
      userId: "user_shared",
      runId: "run_shared",
      orgId: "org_shared",
      computerUseHostId,
      cloudBrowserEnabled: true,
      customConnectorSourceIds: {
        [customConnectorId]: customConnectorSourceId,
      },
      capabilities: expect.arrayContaining([
        "banking:read",
        "browser:read",
        "browser:write",
        "computer-use:write",
        "image-recognition:write",
      ]),
      iat: expect.any(Number),
      exp: expect.any(Number),
    });
    expect(okouPayload.exp).toBe(Number(okouPayload.iat) + 2 * 60 * 60);
    expect(verifyOkouToken(okouToken)).toMatchObject({
      userId: "user_shared",
      runId: "run_shared",
      orgId: "org_shared",
      computerUseHostId,
      cloudBrowserEnabled: true,
      customConnectorSourceIds: {
        [customConnectorId]: customConnectorSourceId,
      },
    });
  });

  it("ignores unknown run capabilities while preserving known capabilities", () => {
    const nowSeconds = currentSecond();
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: "user_okou",
      orgId: "org_okou",
      runId: "run_okou",
      capabilities: ["file:read", "future:read", "file:write"],
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    expect(verifyOkouToken(token)).toStrictEqual({
      userId: "user_okou",
      orgId: "org_okou",
      runId: "run_okou",
      capabilities: ["file:read", "file:write"],
    });
  });

  it("rejects expired tokens and mismatched scopes", () => {
    const nowSeconds = currentSecond();
    const expiredToken = signPatJwtForTests({
      scope: "cli",
      userId: "user_expired",
      orgId: "org_expired",
      tokenId: "token_expired",
      iat: nowSeconds - 120,
      exp: nowSeconds - 60,
    });
    const composeJobToken = signSandboxJwtForTests({
      scope: "compose-job",
      userId: "user_compose",
      jobId: "job_compose",
      iat: nowSeconds,
      exp: nowSeconds + 60,
    });

    expect(verifyCliToken(expiredToken)).toBeNull();
    expect(verifySandboxToken(composeJobToken)).toBeNull();
    expect(verifyOkouToken(composeJobToken)).toBeNull();
    expect(verifyComposeJobToken(composeJobToken)).toStrictEqual({
      userId: "user_compose",
      jobId: "job_compose",
    });
  });

  it("includes maps capability in okou-scoped tokens", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("maps:read");
  });

  it("includes weather capability in okou-scoped tokens", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("weather:read");
  });

  it("includes chat thread read and write capabilities in okou-scoped tokens", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("chat-thread:read");
    expect(verifyOkouToken(token)?.capabilities).toContain("chat-thread:write");
  });

  it("includes chat event read and write capabilities in okou-scoped tokens", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(decodeOkouTokenPayloadForTest(token)).toMatchObject({
      capabilities: expect.arrayContaining([
        "chat-event:read",
        "chat-event:write",
      ]),
    });
    expect(verifyOkouToken(token)?.capabilities).toContain("chat-event:read");
    expect(verifyOkouToken(token)?.capabilities).toContain("chat-event:write");
  });

  it.each([
    [FeatureSwitchKey.PrivateArtifacts, "artifact:read"],
    [FeatureSwitchKey.PrivateArtifacts, "artifact:write"],
    [FeatureSwitchKey.Banking, "banking:read"],
    [FeatureSwitchKey.LarkIntegration, "lark:write"],
  ] as const)(
    "gates %s capability behind its feature switch",
    (feature, capability) => {
      const defaultToken = generateOkouToken(
        "user_okou",
        "run_okou",
        "org_okou",
      );
      const enabledToken = generateOkouToken(
        "user_okou",
        "run_okou",
        "org_okou",
        { [feature]: true },
      );

      expect(verifyOkouToken(defaultToken)?.capabilities).not.toContain(
        capability,
      );
      expect(verifyOkouToken(enabledToken)?.capabilities).toContain(capability);
    },
  );

  it("includes Slack read and write capabilities in okou-scoped tokens", () => {
    const token = generateOkouToken("user_slack", "run_slack", "org_slack");

    expect(verifyOkouToken(token)?.capabilities).toContain("slack:read");
    expect(verifyOkouToken(token)?.capabilities).toContain("slack:write");
  });

  it("grants social capability by default", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("social:read");
  });

  it("grants custom connector writes by default", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("connector:write");
  });

  it("grants scrape capability by default", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("scrape:read");
  });

  it("grants web-search capability by default", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("web-search:read");
  });

  it("grants finance capability by default", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("finance:read");
  });

  it("grants SEO capability by default", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain("seo:read");
  });

  it("includes people-search capability in okou-scoped tokens", () => {
    const token = generateOkouToken("user_okou", "run_okou", "org_okou");

    expect(verifyOkouToken(token)?.capabilities).toContain(
      "people-search:read",
    );
  });

  it("gates image recognition on run eligibility", () => {
    const staffOrgId = "org_3ANttyrbWYJk6JKRSTRLEsbsDLe";
    const ineligibleToken = generateOkouToken(
      "user_okou",
      "run_okou",
      staffOrgId,
    );
    const eligibleToken = generateOkouToken(
      "user_okou",
      "run_okou",
      staffOrgId,
      undefined,
      { imageRecognitionAvailable: true },
    );
    expect(verifyOkouToken(ineligibleToken)?.capabilities).not.toContain(
      "image-recognition:write",
    );
    expect(verifyOkouToken(eligibleToken)?.capabilities).toContain(
      "image-recognition:write",
    );
  });

  it("gates browser capabilities on thread access", () => {
    const defaultToken = generateOkouToken("user_okou", "run_okou", "org_okou");
    const enabledToken = generateOkouToken(
      "user_okou",
      "run_okou",
      "org_okou",
      undefined,
      { cloudBrowserEnabled: true },
    );

    expect(verifyOkouToken(defaultToken)?.capabilities).not.toContain(
      "browser:read",
    );
    expect(verifyOkouToken(defaultToken)?.capabilities).not.toContain(
      "browser:write",
    );
    expect(verifyOkouToken(enabledToken)).toMatchObject({
      cloudBrowserEnabled: true,
      capabilities: expect.arrayContaining(["browser:read", "browser:write"]),
    });
  });

  it("ignores retired capabilities in a signed mixed legacy token", () => {
    const retired = [
      "goal:read",
      "goal:agent-result:write",
      "goal:user-control:write",
    ];
    const token = signSandboxJwtForTests({
      scope: "okou",
      userId: "user_okou",
      runId: "run_okou",
      orgId: "org_okou",
      capabilities: [...retired, "chat-thread:read", "file:write"],
      iat: currentSecond(),
      exp: currentSecond() + 60,
    });
    expect(verifyOkouToken(token)?.capabilities).toStrictEqual([
      "chat-thread:read",
      "file:write",
    ]);
    const fresh = generateOkouToken("user_okou", "run_okou", "org_okou");
    const payload = decodeOkouTokenPayloadForTest(fresh);
    for (const capability of retired) {
      expect(payload.capabilities).not.toContain(capability);
    }
  });

  it("gates computer-use capability on an explicit host grant", () => {
    const defaultToken = generateOkouToken("user_okou", "run_okou", "org_okou");
    const scopedToken = generateOkouToken(
      "user_okou",
      "run_okou",
      "org_okou",
      undefined,
      { computerUseHostId: "00000000-0000-4000-8000-000000000001" },
    );

    expect(verifyOkouToken(defaultToken)?.capabilities).not.toContain(
      "computer-use:write",
    );
    expect(verifyOkouToken(defaultToken)?.computerUseHostId).toBeUndefined();
    expect(verifyOkouToken(scopedToken)).toMatchObject({
      computerUseHostId: "00000000-0000-4000-8000-000000000001",
      capabilities: expect.arrayContaining(["computer-use:write"]),
    });
  });
});
