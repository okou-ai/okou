import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import {
  createAgentPhoneBddApi,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";

const context = testContext();

function connectionFlow() {
  const integrations = createBddIntegrationApi(context);
  const phone = createAgentPhoneBddApi(context);
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  context.mocks.ably.publish.mockResolvedValue(undefined);
  const sends = phone.captureAgentPhoneSends();
  return {
    integrations,
    phone,
    sends,
    actor: integrations.user(),
    async proof(
      handle = uniquePhoneHandle(),
      channel: "sms" | "imessage" = "sms",
    ) {
      return await phone.requestConnectLink(handle, sends, channel);
    },
  };
}

describe("AgentPhone connection status and explicit phone switching", () => {
  it("checks a signed connection without linking, then recognizes the connected number", async () => {
    const flow = connectionFlow();
    const proof = await flow.proof();
    const before = await flow.integrations.requestAgentPhoneConnectStatus(
      flow.actor,
      proof,
      [200],
    );
    expect(before.body).toStrictEqual({ kind: "connect" });
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(flow.actor),
    ).resolves.toMatchObject({
      linked: false,
    });
    await flow.integrations.requestConnectAgentPhone(flow.actor, proof, [200]);
    const after = await flow.integrations.requestAgentPhoneConnectStatus(
      flow.actor,
      proof,
      [200],
    );
    expect(after.body).toStrictEqual({
      kind: "connected",
      phoneHandle: proof.phoneHandle,
    });
  });

  it("requires explicit switching and releases the previous number only after success", async () => {
    const flow = connectionFlow();
    const first = await flow.proof();
    await flow.integrations.requestConnectAgentPhone(flow.actor, first, [200]);
    const next = await flow.proof();
    const status = await flow.integrations.requestAgentPhoneConnectStatus(
      flow.actor,
      next,
      [200],
    );
    expect(status.body).toStrictEqual({
      kind: "phone_mismatch",
      currentPhoneHandle: first.phoneHandle,
    });
    await flow.integrations.requestConnectAgentPhone(flow.actor, next, [409]);
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(flow.actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: first.phoneHandle,
    });
    const switchRequest = { ...next, replacePhoneHandle: first.phoneHandle };
    await flow.integrations.requestConnectAgentPhone(
      flow.actor,
      switchRequest,
      [200],
    );
    await flow.integrations.requestConnectAgentPhone(
      flow.actor,
      switchRequest,
      [200],
    );
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(flow.actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: next.phoneHandle,
    });
    const other = flow.integrations.user();
    await flow.integrations.requestConnectAgentPhone(other, first, [200]);
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(other),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: first.phoneHandle,
    });
  });

  it("preserves both bindings when another account claims the requested number after the status check", async () => {
    const flow = connectionFlow();
    const first = await flow.proof();
    await flow.integrations.requestConnectAgentPhone(flow.actor, first, [200]);
    const next = await flow.proof();
    const checked = await flow.integrations.requestAgentPhoneConnectStatus(
      flow.actor,
      next,
      [200],
    );
    expect(checked.body).toMatchObject({ kind: "phone_mismatch" });
    const other = flow.integrations.user();
    await flow.integrations.requestConnectAgentPhone(other, next, [200]);
    const occupied = await flow.integrations.requestAgentPhoneConnectStatus(
      flow.actor,
      next,
      [200],
    );
    expect(occupied.body).toStrictEqual({ kind: "phone_in_use" });
    await flow.integrations.requestConnectAgentPhone(
      flow.actor,
      { ...next, replacePhoneHandle: first.phoneHandle },
      [409],
    );
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(flow.actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: first.phoneHandle,
    });
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(other),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: next.phoneHandle,
    });
  });

  it("allows only one competing replacement of the confirmed binding", async () => {
    const flow = connectionFlow();
    const first = await flow.proof();
    await flow.integrations.requestConnectAgentPhone(flow.actor, first, [200]);
    const candidates = [await flow.proof(), await flow.proof()];
    const results = await Promise.all(
      candidates.map((proof) => {
        return flow.integrations.requestConnectAgentPhone(
          flow.actor,
          { ...proof, replacePhoneHandle: first.phoneHandle },
          [200, 409],
        );
      }),
    );
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 409]);
    const winner =
      candidates[
        results.findIndex((result) => {
          return result.status === 200;
        })
      ];
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(flow.actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: winner?.phoneHandle,
    });
  });

  it("switches from an iMessage email handle to a phone number", async () => {
    const flow = connectionFlow();
    const first = await flow.proof(
      `sender-${crypto.randomUUID()}@example.com`,
      "imessage",
    );
    await flow.integrations.requestConnectAgentPhone(flow.actor, first, [200]);
    const next = await flow.proof();
    await flow.integrations.requestConnectAgentPhone(
      flow.actor,
      { ...next, replacePhoneHandle: first.phoneHandle },
      [200],
    );
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(flow.actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: next.phoneHandle,
    });
  });

  it("rejects a stale confirmation after the current number changes", async () => {
    const flow = connectionFlow();
    const first = await flow.proof();
    await flow.integrations.requestConnectAgentPhone(flow.actor, first, [200]);
    const next = await flow.proof();
    const stale = await flow.proof();
    await flow.integrations.requestConnectAgentPhone(
      flow.actor,
      { ...next, replacePhoneHandle: first.phoneHandle },
      [200],
    );
    await flow.integrations.requestConnectAgentPhone(
      flow.actor,
      { ...stale, replacePhoneHandle: first.phoneHandle },
      [409],
    );
    await expect(
      flow.integrations.getAgentPhoneLinkStatus(flow.actor),
    ).resolves.toMatchObject({
      linked: true,
      phoneHandle: next.phoneHandle,
    });
  });

  it.each(["tampered", "expired"])(
    "rejects a %s proof for status and switching without removing the old number",
    async (failure) => {
      const flow = connectionFlow();
      const first = await flow.proof();
      await flow.integrations.requestConnectAgentPhone(
        flow.actor,
        first,
        [200],
      );
      const next = await flow.proof();
      const invalid =
        failure === "tampered" ? { ...next, signature: "0".repeat(64) } : next;
      if (failure === "expired") {
        mockNow(now() + 601_000);
      }
      await flow.integrations.requestAgentPhoneConnectStatus(
        flow.actor,
        invalid,
        [400],
      );
      await flow.integrations.requestConnectAgentPhone(
        flow.actor,
        { ...invalid, replacePhoneHandle: first.phoneHandle },
        [400],
      );
      await expect(
        flow.integrations.getAgentPhoneLinkStatus(flow.actor),
      ).resolves.toMatchObject({
        linked: true,
        phoneHandle: first.phoneHandle,
      });
    },
  );

  it("requires authentication for connection status", async () => {
    const flow = connectionFlow();
    const result = await flow.integrations.requestAgentPhoneConnectStatus(
      null,
      await flow.proof(),
      [401],
    );
    expect(result.status).toBe(401);
  });
});
