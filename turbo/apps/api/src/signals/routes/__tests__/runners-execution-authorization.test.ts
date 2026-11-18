import { instructionsContract } from "@okouai/api-contracts/contracts/instructions";
import { okouTokenClaimsSchema } from "@okouai/api-contracts/contracts/run-execution-authorization";
import { expect, test } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow, now } from "../../../lib/time";
import { instructionsRoutes } from "../instructions";
import { createBddApi } from "./helpers/api-bdd";
import { createFirewallApi, secretTemplate } from "./helpers/api-bdd-firewall";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import { publicChatActor } from "./helpers/public-chat-actor";

const context = testContext();
const api = createRunsApi(context);
const bdd = createBddApi(context);
const firewall = createFirewallApi(context);
const authHeaders = Object.freeze({
  Authorization: `Bearer ${secretTemplate("OKOU_TOKEN")}`,
});

function claimsFromIssuedToken(token: string) {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new Error("Expected an issued token payload");
  }
  return okouTokenClaimsSchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
}

test("resolves the Run's original capabilities despite another genuine envelope and changed features", async () => {
  const owned = await publicChatActor(context, {
    clockTime: Date.UTC(2026, 10, 18, 0, 0, 0),
  });
  owned.ownsFeatureSwitches();
  if (!owned.actor.orgId) {
    throw new Error("Expected workspace ownership");
  }
  const switchOwner = { ...owned.actor, orgId: owned.actor.orgId };
  await owned.run(async () => {
    const { defaultAgentId } = await bdd.readOnboardingStatus(owned.actor);
    if (!defaultAgentId) {
      throw new Error("Expected the default executor");
    }
    await updateFeatureSwitchesForUser(context, switchOwner, {
      singleAgent: true,
    });
    const original = await api.createThreadRun(owned.actor, {
      agentId: defaultAgentId,
      prompt: "Use the original admitted Instructions permission",
    });
    const first = await owned.executionInput(original.runId);
    const originalToken = first.platformEnvironment.OKOU_TOKEN;
    if (!originalToken) {
      throw new Error("Expected the original issued capability token");
    }
    await updateFeatureSwitchesForUser(context, switchOwner, {
      singleAgent: false,
    });
    const peer = await api.createThreadRun(owned.actor, {
      agentId: defaultAgentId,
      prompt: "Use the later admission permissions",
    });
    const second = await owned.executionInput(peer.runId);
    if (!second.encryptedSecrets) {
      throw new Error("Expected the peer Run's genuine envelope");
    }
    const sandboxHeaders = {
      authorization: `Bearer ${first.sandboxToken}`,
    };
    const resolved = await firewall.requestFirewallAuth(
      sandboxHeaders,
      { encryptedSecrets: second.encryptedSecrets, authHeaders },
      [200],
    );
    if (resolved.status !== 200) {
      throw new Error("Expected original Run authorization");
    }
    const resolvedHeader = resolved.body.headers.Authorization;
    if (!resolvedHeader?.startsWith("Bearer ")) {
      throw new Error("Expected the resolved bearer credential");
    }
    expect(claimsFromIssuedToken(resolvedHeader.slice(7))).toStrictEqual(
      claimsFromIssuedToken(originalToken),
    );
    expect(resolved.body).toMatchObject({
      resolvedSecrets: ["OKOU_TOKEN"],
      expiresAt: Math.floor(now() / 1000) + 30,
    });
    const client = setupApp({ context, routes: instructionsRoutes })(
      instructionsContract,
    );
    await accept(
      client.get({ headers: { authorization: resolvedHeader } }),
      [200],
    );
    await accept(
      client.get({
        headers: {
          authorization: `Bearer ${second.platformEnvironment.OKOU_TOKEN}`,
        },
      }),
      [403],
    );

    const personalSource = Object.values(
      first.secretConnectorMetadataMap ?? {},
    ).find((source) => {
      return source.sourceType === "model-provider";
    });
    if (!personalSource?.metadataKey) {
      throw new Error("Expected the dispatched personal model source");
    }
    for (const secretConnectorMap of [
      { OKOU_TOKEN: personalSource.metadataKey },
      undefined,
    ]) {
      await firewall.requestFirewallAuth(
        sandboxHeaders,
        {
          encryptedSecrets: second.encryptedSecrets,
          authHeaders,
          secretConnectorMap,
          secretConnectorMetadataMap: { OKOU_TOKEN: personalSource },
        },
        [424],
      );
    }
    await api.requestCancelRun(owned.actor, original.runId, [200]);
    await firewall.requestFirewallAuth(
      sandboxHeaders,
      { encryptedSecrets: second.encryptedSecrets, authHeaders },
      [403],
    );
  });
});

test("caps the auth lease at the original expiry and refuses a fresh token lifetime", async () => {
  const owned = await publicChatActor(context, {
    clockTime: Date.UTC(2026, 10, 18, 0, 0, 0),
  });
  await owned.run(async () => {
    const run = await api.createThreadRun(owned.actor, {
      agentId: owned.agentId,
      prompt: "Retain the original absolute token expiry",
    });
    const execution = await owned.executionInput(run.runId);
    const token = execution.platformEnvironment.OKOU_TOKEN;
    if (!token || !execution.encryptedSecrets) {
      throw new Error("Expected the issued token and actual envelope");
    }
    const original = claimsFromIssuedToken(token);
    const headers = { authorization: `Bearer ${execution.sandboxToken}` };
    const body = { encryptedSecrets: execution.encryptedSecrets, authHeaders };
    mockNow((original.exp - 10) * 1000);
    const leased = await firewall.requestFirewallAuth(headers, body, [200]);
    if (leased.status !== 200) {
      throw new Error("Expected the still-valid original authority");
    }
    expect(leased.body.expiresAt).toBe(original.exp);
    const authorization = leased.body.headers.Authorization;
    if (!authorization?.startsWith("Bearer ")) {
      throw new Error("Expected the resolved bearer credential");
    }
    expect(claimsFromIssuedToken(authorization.slice(7))).toStrictEqual(
      original,
    );
    mockNow(original.exp * 1000);
    const expired = await firewall.requestFirewallAuth(headers, body, [403]);
    expect(expired.body).toMatchObject({
      error: { code: "FORBIDDEN", message: "Run authorization has expired" },
    });
  });
});
