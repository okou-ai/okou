import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import {
  createAgentPhoneBddApi,
  uniquePhoneHandle,
} from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import type { ApiTestUser } from "./helpers/api-bdd";

const context = testContext();
const integrations = createBddIntegrationApi(context);
const agentPhone = createAgentPhoneBddApi(context);

/** AgentPhone with a signed webhook; provider texts are captured. */
function configureSignedAgentPhone() {
  integrations.configureAgentPhoneProvider();
  integrations.configureAgentPhoneWebhook();
  return agentPhone.captureAgentPhoneSends();
}

type Capture = ReturnType<typeof configureSignedAgentPhone>;

async function connectedMember(capture: Capture, phone: string) {
  const member = integrations.user();
  const proof = await agentPhone.requestConnectLink(phone, capture);
  await integrations.requestConnectAgentPhone(member, proof, [200]);
  return member;
}

async function linkedHandle(member: ApiTestUser) {
  const link = await integrations.getAgentPhoneLinkStatus(member);
  return link.linked ? link.phoneHandle : null;
}

describe("AgentPhone connection status and explicit phone switching", () => {
  it("agentphone-connect.bdd-001 checks a signed connect link without linking, then recognizes the connected number", async () => {
    const capture = configureSignedAgentPhone();
    const phone = uniquePhoneHandle();
    const proof = await agentPhone.requestConnectLink(phone, capture);
    const member = integrations.user();

    const before = await integrations.requestAgentPhoneConnectStatus(
      member,
      proof,
      [200],
    );
    expect(before.body).toStrictEqual({ kind: "connect" });
    const link = await integrations.getAgentPhoneLinkStatus(member);
    expect(link.linked).toBeFalsy();

    await integrations.requestConnectAgentPhone(member, proof, [200]);
    const after = await integrations.requestAgentPhoneConnectStatus(
      member,
      proof,
      [200],
    );
    expect(after.body).toStrictEqual({ kind: "connected", phoneHandle: phone });
  });

  it("agentphone-connect.bdd-002 requires explicit switching and releases the previous number only after success", async () => {
    const capture = configureSignedAgentPhone();
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    const member = await connectedMember(capture, firstPhone);
    const proof = await agentPhone.requestConnectLink(secondPhone, capture);

    const status = await integrations.requestAgentPhoneConnectStatus(
      member,
      proof,
      [200],
    );
    expect(status.body).toStrictEqual({
      kind: "phone_mismatch",
      currentPhoneHandle: firstPhone,
    });

    await integrations.requestConnectAgentPhone(member, proof, [409]);
    await expect(linkedHandle(member)).resolves.toBe(firstPhone);

    const switchBody = { ...proof, replacePhoneHandle: firstPhone };
    await integrations.requestConnectAgentPhone(member, switchBody, [200]);
    await integrations.requestConnectAgentPhone(member, switchBody, [200]);
    await expect(linkedHandle(member)).resolves.toBe(secondPhone);

    const other = integrations.user();
    const released = await agentPhone.requestConnectLink(firstPhone, capture);
    await integrations.requestConnectAgentPhone(other, released, [200]);
    await expect(linkedHandle(other)).resolves.toBe(firstPhone);
  });

  it("agentphone-connect.bdd-003 keeps both bindings when another account claims the requested number after the status check", async () => {
    const capture = configureSignedAgentPhone();
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    const member = await connectedMember(capture, firstPhone);
    const proof = await agentPhone.requestConnectLink(secondPhone, capture);
    const mismatch = await integrations.requestAgentPhoneConnectStatus(
      member,
      proof,
      [200],
    );
    expect(mismatch.body).toStrictEqual({
      kind: "phone_mismatch",
      currentPhoneHandle: firstPhone,
    });

    const other = integrations.user();
    await integrations.requestConnectAgentPhone(other, proof, [200]);
    const status = await integrations.requestAgentPhoneConnectStatus(
      member,
      proof,
      [200],
    );
    expect(status.body).toStrictEqual({ kind: "phone_in_use" });
    await integrations.requestConnectAgentPhone(
      member,
      { ...proof, replacePhoneHandle: firstPhone },
      [409],
    );

    await expect(linkedHandle(member)).resolves.toBe(firstPhone);
    await expect(linkedHandle(other)).resolves.toBe(secondPhone);
  });

  it("agentphone-connect.bdd-005 switches from an iMessage email handle to a phone number", async () => {
    const capture = configureSignedAgentPhone();
    const email = `bdd-${randomUUID()}@example.test`;
    const member = integrations.user();
    const emailProof = await agentPhone.requestConnectLink(
      email,
      capture,
      "imessage",
    );
    await integrations.requestConnectAgentPhone(member, emailProof, [200]);
    await expect(linkedHandle(member)).resolves.toBe(email);
    const phone = uniquePhoneHandle();
    const phoneProof = await agentPhone.requestConnectLink(phone, capture);

    await integrations.requestConnectAgentPhone(
      member,
      { ...phoneProof, replacePhoneHandle: email },
      [200],
    );

    await expect(linkedHandle(member)).resolves.toBe(phone);
  });

  it("agentphone-connect.bdd-006 rejects a stale confirmation after the current number changes", async () => {
    const capture = configureSignedAgentPhone();
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    const member = await connectedMember(capture, firstPhone);
    const secondProof = await agentPhone.requestConnectLink(
      secondPhone,
      capture,
    );
    const thirdProof = await agentPhone.requestConnectLink(
      uniquePhoneHandle(),
      capture,
    );

    await integrations.requestConnectAgentPhone(
      member,
      { ...secondProof, replacePhoneHandle: firstPhone },
      [200],
    );
    await integrations.requestConnectAgentPhone(
      member,
      { ...thirdProof, replacePhoneHandle: firstPhone },
      [409],
    );

    await expect(linkedHandle(member)).resolves.toBe(secondPhone);
  });

  it("agentphone-connect.bdd-007 rejects a tampered proof for status and switching without removing the old number", async () => {
    const capture = configureSignedAgentPhone();
    const firstPhone = uniquePhoneHandle();
    const member = await connectedMember(capture, firstPhone);
    const proof = await agentPhone.requestConnectLink(
      uniquePhoneHandle(),
      capture,
    );
    const tampered = { ...proof, signature: "0".repeat(64) };

    await integrations.requestAgentPhoneConnectStatus(member, tampered, [400]);
    await integrations.requestConnectAgentPhone(
      member,
      { ...tampered, replacePhoneHandle: firstPhone },
      [400],
    );

    await expect(linkedHandle(member)).resolves.toBe(firstPhone);
  });
});
