import { HttpResponse, http } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import type { ConnectorAccountMutationIntent } from "@okouai/api-contracts/contracts/connector-accounts";

import { testContext } from "../../../__tests__/test-context";
import { server } from "../../../mocks/server";
import { createDeferredPromise } from "../../utils";
import { createBddApi } from "./helpers/api-bdd";
import {
  awsVerificationCode,
  createConnectorBddApi,
  mockAwsExternalCodeProvider,
} from "./helpers/api-bdd-connectors";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";

const context = testContext();
const AWS_TOKEN_URL = "https://us-east-1.signin.aws.amazon.com/v1/token";
const AWS_STS_URL = "https://sts.us-east-1.amazonaws.com/";

async function setupAwsFirewall() {
  const bdd = createBddApi(context);
  const fw = createFirewallApi(context);
  const runs = createRunsApi(context);
  const connectors = createConnectorBddApi(context);
  const actor = bdd.user();
  bdd.acceptAgentStorageWrites();
  runs.acceptStorageDownloads();
  runs.acceptTelemetryIngest();
  runs.configureRunnerGroup();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  await fw.provisionRunReadyOrg(actor);
  await runs.ensureOrgModelProvider(actor);
  const agent = await bdd.createAgent(actor, {
    displayName: "AWS refresh agent",
    description: "Exercises AWS refresh and reconnect.",
    visibility: "private",
  });
  const run = await runs.createRun(actor, {
    agentId: agent.agentId,
    prompt: "resolve AWS firewall auth",
    modelProvider: "anthropic-api-key",
  });
  const headers = fw.sandboxHeaders(actor, run.runId);
  mockAwsExternalCodeProvider();

  async function connect(account: ConnectorAccountMutationIntent) {
    const session = await connectors.startExternalCode(
      actor,
      "aws",
      "cli",
      account,
    );
    const result = await connectors.completeExternalCode(actor, "aws", {
      sessionId: session.sessionId,
      sessionToken: session.sessionToken,
      code: awsVerificationCode(session.authorizationUrl),
    });
    return result.connector;
  }

  const account = await connect({ intent: "add" });
  const createdAccountIds = [account.id];
  onTestFinished(async () => {
    for (const connectionId of createdAccountIds) {
      await connectors.deleteBuiltinConnectorAccount(
        actor,
        "aws",
        connectionId,
      );
    }
  });

  function request(connectionId: string, forceRefresh: boolean) {
    return fw.requestFirewallAuth(
      headers,
      {
        encryptedSecrets: fw.encryptedSecretsBody({}),
        authHeaders: {},
        authAwsSigv4: {
          accessKeyId: secretTemplate("AWS_ACCESS_KEY_ID"),
          secretAccessKey: secretTemplate("AWS_SECRET_ACCESS_KEY"),
          sessionToken: secretTemplate("AWS_SESSION_TOKEN"),
        },
        secretConnectorMap: {
          AWS_ACCESS_KEY_ID: "aws",
          AWS_SECRET_ACCESS_KEY: "aws",
          AWS_SESSION_TOKEN: "aws",
        },
        secretConnectorMetadataMap: {
          AWS_ACCESS_KEY_ID: {
            sourceType: "connector",
            sourceId: connectionId,
          },
          AWS_SECRET_ACCESS_KEY: {
            sourceType: "connector",
            sourceId: connectionId,
          },
          AWS_SESSION_TOKEN: {
            sourceType: "connector",
            sourceId: connectionId,
          },
        },
        forceRefresh,
      },
      [200, 502],
    );
  }

  return { actor, account, connect, connectors, createdAccountIds, request };
}

describe("AWS Sign-In refresh expiry", () => {
  it("stops repeated and concurrent refreshes until the exact account reconnects", async () => {
    const aws = await setupAwsFirewall();
    const started = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!release.settled()) {
        release.resolve(undefined);
      }
    });
    let refreshCalls = 0;
    server.use(
      http.post(AWS_TOKEN_URL, async () => {
        refreshCalls += 1;
        if (!started.settled()) {
          started.resolve(undefined);
        }
        await release.promise;
        return HttpResponse.json(
          { code: "TOKEN_EXPIRED", message: "The refresh token has expired." },
          { status: 401 },
        );
      }),
    );
    context.mocks.sentry.captureException.mockClear();

    const first = aws.request(aws.account.id, true);
    await started.promise;
    const concurrent = aws.request(aws.account.id, true);
    release.resolve(undefined);
    const responses = await Promise.all([first, concurrent]);
    responses.push(await aws.request(aws.account.id, false));
    responses.push(await aws.request(aws.account.id, true));
    for (const response of responses) {
      expect(response.status).toBe(502);
      expect(response.body).toStrictEqual({
        error: expect.objectContaining({
          code: "TOKEN_REFRESH_FAILED",
          failureReason: "reconnect_required",
          connectors: ["aws"],
        }),
      });
    }
    expect(refreshCalls).toBe(1);
    const expired = await aws.connectors.readConnectorBySlug(aws.actor, "aws");
    expect(expired.connectionStatus).toBe("reconnect-required");
    expect(expired.reconnectReason).toBe("credential_expired");
    expect(context.mocks.sentry.captureException).not.toHaveBeenCalled();

    const provider = mockAwsExternalCodeProvider();
    const reconnected = await aws.connect({
      intent: "reconnect",
      connectionId: aws.account.id,
    });
    expect(reconnected.id).toBe(aws.account.id);
    expect(reconnected.connectionStatus).toBe("connected");
    expect(reconnected.reconnectReason).toBeNull();
    const recovered = await aws.request(aws.account.id, true);
    expect(recovered.status).toBe(200);
    expect(recovered.body).toStrictEqual(
      expect.objectContaining({
        awsSigv4: {
          accessKeyId: "aws-external-code-credential-id",
          secretAccessKey: "aws-secret-access-key",
          sessionToken: "aws-session-token",
        },
      }),
    );
    expect(
      provider.tokenRequests.map(({ grantType }) => {
        return grantType;
      }),
    ).toStrictEqual(["authorization_code", "refresh_token"]);
  });

  it("keeps a healthy sibling account usable without substituting it for the expired account", async () => {
    const aws = await setupAwsFirewall();
    server.use(
      http.get(AWS_STS_URL, () => {
        return HttpResponse.xml(
          "<GetCallerIdentityResponse><GetCallerIdentityResult>" +
            "<UserId>AIDASIBLING</UserId><Account>123456789012</Account>" +
            "<Arn>arn:aws:iam::123456789012:user/sibling</Arn>" +
            "</GetCallerIdentityResult></GetCallerIdentityResponse>",
        );
      }),
    );
    const sibling = await aws.connect({ intent: "add" });
    aws.createdAccountIds.push(sibling.id);
    expect(sibling.id).not.toBe(aws.account.id);
    let refreshCalls = 0;
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        refreshCalls += 1;
        return HttpResponse.json({ code: "TOKEN_EXPIRED" }, { status: 401 });
      }),
    );
    expect((await aws.request(aws.account.id, true)).status).toBe(502);
    await aws.connectors.setDefaultBuiltinConnectorAccount(
      aws.actor,
      "aws",
      sibling.id,
    );
    expect((await aws.request(aws.account.id, false)).status).toBe(502);
    expect((await aws.request(sibling.id, false)).status).toBe(200);
    expect(refreshCalls).toBe(1);
    const accounts = await aws.connectors.listBuiltinConnectorAccounts(
      aws.actor,
      "aws",
    );
    expect(
      accounts.find(({ id }) => {
        return id === aws.account.id;
      }),
    ).toStrictEqual(
      expect.objectContaining({
        connectionStatus: "reconnect-required",
        reconnectReason: "credential_expired",
      }),
    );
    expect(
      accounts.find(({ id }) => {
        return id === sibling.id;
      }),
    ).toStrictEqual(
      expect.objectContaining({
        connectionStatus: "connected",
        reconnectReason: null,
      }),
    );
  });

  it("recognizes explicit expiry after an older generic reconnect state", async () => {
    const aws = await setupAwsFirewall();
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        return HttpResponse.json({ error: "invalid_grant" }, { status: 401 });
      }),
    );
    expect((await aws.request(aws.account.id, true)).status).toBe(502);
    const generic = await aws.connectors.readConnectorBySlug(aws.actor, "aws");
    expect(generic.reconnectReason).toBe("authorization_expired_or_revoked");

    let refreshCalls = 0;
    server.use(
      http.post(AWS_TOKEN_URL, () => {
        refreshCalls += 1;
        return HttpResponse.json({ code: "TOKEN_EXPIRED" }, { status: 401 });
      }),
    );
    expect((await aws.request(aws.account.id, true)).status).toBe(502);
    expect((await aws.request(aws.account.id, true)).status).toBe(502);
    expect(refreshCalls).toBe(1);
    const expired = await aws.connectors.readConnectorBySlug(aws.actor, "aws");
    expect(expired.reconnectReason).toBe("credential_expired");
  });

  it.each([
    {
      status: 401,
      code: "INVALID_CLIENT",
      failureReason: "reconnect_required",
    },
    { status: 400, code: "TOKEN_EXPIRED", failureReason: "reconnect_required" },
    { status: 400, code: undefined, failureReason: "reconnect_required" },
    { status: 429, code: "TOKEN_EXPIRED", failureReason: "upstream_provider" },
    { status: 503, code: "TOKEN_EXPIRED", failureReason: "upstream_provider" },
  ])(
    "keeps HTTP $status $code actionable and recoverable",
    async ({ status, code, failureReason }) => {
      const aws = await setupAwsFirewall();
      server.use(
        http.post(AWS_TOKEN_URL, () => {
          return HttpResponse.json(
            { code, message: "TOKEN_EXPIRED (The refresh token has expired.)" },
            { status },
          );
        }),
      );
      const failed = await aws.request(aws.account.id, true);
      expect(failed.status).toBe(502);
      expect(failed.body).toStrictEqual({
        error: expect.objectContaining({
          code: "TOKEN_REFRESH_FAILED",
          failureReason,
        }),
      });
      const account = await aws.connectors.readConnectorBySlug(
        aws.actor,
        "aws",
      );
      expect(account.reconnectReason).not.toBe("credential_expired");

      const provider = mockAwsExternalCodeProvider();
      expect((await aws.request(aws.account.id, true)).status).toBe(200);
      expect(provider.tokenRequests).toHaveLength(1);
      expect(
        (await aws.connectors.readConnectorBySlug(aws.actor, "aws"))
          .connectionStatus,
      ).toBe("connected");
    },
  );
});
