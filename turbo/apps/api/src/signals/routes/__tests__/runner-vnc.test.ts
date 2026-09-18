import { randomUUID } from "node:crypto";
import { runnerVncContract } from "@okouai/api-contracts/contracts/runner-vnc";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { beforeEach, describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupRawAppRequest } from "../../../__tests__/test-helpers";
import { createDeferredPromise } from "../../utils";
import { runnerVncRoutes } from "../runner-vnc";
import { createAuthOrgAgentsBddApi } from "./helpers/api-bdd-auth-org";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { useSecretKmsProbe } from "./helpers/secret-kms-probe";
import {
  createVncRuntimeApi,
  initializeVncRuntimeTest,
  vncPassword,
  vncProfiles,
  vncRunnerHeaders,
  vncSecurity,
  vncSessionHeaders,
} from "./helpers/vnc-runtime";

const context = testContext();
const api = createVncRuntimeApi(context);
beforeEach(initializeVncRuntimeTest);

describe("private Runner VNC authority", () => {
  it("requires an explicit VNC grant and preserves the exact secret only in the no-store handoff", async () => {
    const f = await api.fixture({ grant: false });
    const kms = useSecretKmsProbe();
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
    await api.grant(f, true);
    const result = await accept(
      api.runner().resolve({
        headers: vncRunnerHeaders,
        params: { runId: f.runId },
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
          supportedProfiles: [...vncProfiles],
        },
      }),
      [200],
    );
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.body).toMatchObject({
      outcome: "resolved",
      host: "vnc.example.com",
      port: 5900,
      authentication: { method: "vnc_password", password: vncPassword },
      security: vncSecurity,
      authority: { generation: 1 },
    });
    const first = await api.resolved(f);
    await api.grant(f, true);
    expect((await api.resolved(f)).authority).toStrictEqual(first.authority);
    const listed = await accept(
      api.connections().list({ headers: vncSessionHeaders }),
      [200],
    );
    expect(JSON.stringify(listed.body)).not.toContain(vncPassword);
    expect(listed.body.connections[0]).not.toHaveProperty("instanceId");
    await api.grant(f, false);
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    await api.grant(f, true);
    expect((await api.resolved(f)).authority.grantId).not.toBe(
      first.authority.grantId,
    );
  });

  it("rejects wrong auth classes and exact winning-process mismatches before KMS", async () => {
    const f = await api.fixture();
    const kms = useSecretKmsProbe();
    const body = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
      supportedProfiles: [...vncProfiles],
    };
    for (const authorization of [
      undefined,
      "Bearer vm0_official_wrong",
      "Bearer clerk-session",
      `Bearer ${f.sandboxToken}`,
    ]) {
      const result = await api.runner().resolve({
        headers: { authorization },
        params: { runId: f.runId },
        body,
      });
      expect(result.status).toBe(401);
      expect(result.headers.get("cache-control")).toBe("no-store");
    }
    const auth = createAuthOrgAgentsBddApi(context);
    const actor = auth.user();
    auth.mockClerkOrg(actor);
    const pat = await auth.createCliToken(actor);
    await accept(
      api.runner().resolve({
        headers: { authorization: `Bearer ${pat.token}` },
        params: { runId: f.runId },
        body,
      }),
      [403],
    );
    api.authenticate(f);
    for (const override of [
      { connectionId: randomUUID() },
      { runnerIdentity: { ...f.runnerIdentity, runnerId: randomUUID() } },
      { runnerIdentity: { ...f.runnerIdentity, heartbeatGeneration: 7 } },
    ]) {
      await expect(api.resolve(f, override)).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    }
    await expect(
      api.resolve({ ...f, runId: randomUUID() }),
    ).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
  });

  it("keeps cross-owner connections opaque", async () => {
    const f = await api.fixture();
    const foreign = await api.fixture();
    api.authenticate(f);
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, { connectionId: foreign.connectionId }),
    ).resolves.toStrictEqual({ outcome: "unavailable" });
    expect(kms.decryptCalls).toBe(0);
  });

  it("reports unsupported exact profiles before decrypting and rejects injected authority fields", async () => {
    const f = await api.fixture();
    const kms = useSecretKmsProbe();
    await expect(
      api.resolve(f, { supportedProfiles: [] }),
    ).resolves.toStrictEqual({
      outcome: "unsupported_profile",
    });
    const request = setupRawAppRequest({ context, routes: runnerVncRoutes });
    const base = {
      connectionId: f.connectionId,
      runnerIdentity: f.runnerIdentity,
      supportedProfiles: [...vncProfiles],
    };
    for (const body of [
      {
        ...base,
        supportedProfiles: [
          { authMethod: "vnc_password", securityType: "none" },
        ],
      },
      {
        ...base,
        supportedProfiles: [{ authMethod: "none", securityType: "x509_vnc" }],
      },
      { ...base, host: "attacker.example.com" },
      { ...base, userId: f.userId },
      {
        ...base,
        authentication: { method: "vnc_password", password: "injected" },
      },
    ]) {
      const result = await request(
        runnerVncContract.resolve.path.replace(":runId", f.runId),
        {
          method: "POST",
          headers: { ...vncRunnerHeaders, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(result.status).toBe(400);
      expect(JSON.stringify(result.body)).not.toContain("injected");
    }
    expect(kms.decryptCalls).toBe(0);
  });

  it("rejects inactive and unclaimed Runs without requiring chat provenance", async () => {
    const f = await api.fixture();
    const kms = useSecretKmsProbe();
    for (const runtime of [
      { status: "pending" as const },
      { status: "completed" as const },
      { status: "cancelled" as const },
      { status: "failed" as const },
      { runnerId: null, heartbeatGeneration: null },
    ]) {
      const other = await api.runtime(f, { agentId: f.agentId, ...runtime });
      await expect(api.resolve({ ...f, ...other })).resolves.toStrictEqual({
        outcome: "unavailable",
      });
    }
    expect(kms.decryptCalls).toBe(0);
    for (const triggerSource of [
      "automation-schedule",
      "automation-event",
      "webhook",
      null,
    ] as const) {
      const other = await api.runtime(f, {
        agentId: f.agentId,
        triggerSource,
        chat: false,
      });
      expect((await api.resolve({ ...f, ...other })).outcome).toBe("resolved");
    }
  });

  it("rechecks feature and current membership on private calls", async () => {
    const f = await api.fixture();
    const kms = useSecretKmsProbe();
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: false,
    });
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    await updateFeatureSwitchesForUser(context, f, {
      [FeatureSwitchKey.VncAccess]: true,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: [], totalCount: 0 },
    );
    await expect(api.resolve(f)).resolves.toStrictEqual({
      outcome: "unavailable",
    });
    expect(kms.decryptCalls).toBe(0);
  });

  it("surfaces KMS failure as a sanitized error", async () => {
    const f = await api.fixture();
    useSecretKmsProbe(undefined, () => {
      return Promise.reject(new Error("KMS secret-response-canary"));
    });
    const result = await accept(
      api.runner().resolve({
        headers: vncRunnerHeaders,
        params: { runId: f.runId },
        body: {
          connectionId: f.connectionId,
          runnerIdentity: f.runnerIdentity,
          supportedProfiles: [...vncProfiles],
        },
      }),
      [500],
    );
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(result.body)).not.toContain("secret-response-canary");
    expect(JSON.stringify(result.body)).not.toContain(vncPassword);
  });

  it("allows rotation while KMS is pending and discards the old secret handoff", async () => {
    const f = await api.fixture();
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<Uint8Array>(context.signal);
    useSecretKmsProbe(undefined, (_request, call) => {
      if (call !== 1) {
        return undefined;
      }
      entered.resolve(undefined);
      return release.promise;
    });
    const pending = api.resolve(f);
    await entered.promise;
    await accept(
      api.credentials().update({
        headers: vncSessionHeaders,
        params: { credentialId: f.credentialId },
        body: {
          expectedRevision: 1,
          authentication: { method: "vnc_password", password: "rotated" },
        },
      }),
      [200],
    ).finally(() => {
      release.resolve(Buffer.from("0123456789abcdef0123456789abcdef"));
    });
    await expect(pending).resolves.toStrictEqual({ outcome: "unavailable" });
    await expect(api.resolved(f)).resolves.toMatchObject({
      authentication: { method: "vnc_password", password: "rotated" },
      authority: { generation: 2 },
    });
  });
});
