import { describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { uniquePhoneHandle } from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";
import { createDeferredPromise } from "../../utils";

const context = testContext();
const integrations = createBddIntegrationApi(context);

interface Latch {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

function latch(): Latch {
  const deferred = createDeferredPromise<void>(context.signal);
  const open = (): void => {
    if (!deferred.settled()) {
      deferred.resolve();
    }
  };
  return { promise: deferred.promise, open };
}

/** AgentPhone holds the first verification text until released. */
function holdFirstVerificationText() {
  const reached = latch();
  const release = latch();
  server.use(
    http.post("https://api.agentphone.test/v1/messages", async () => {
      reached.open();
      await release.promise;
      return HttpResponse.json({ id: "apmsg_held", status: "sent" });
    }),
  );
  return { reached: reached.promise, release: release.open };
}

/** AgentPhone rejects the first verification text, then accepts. */
function rejectFirstVerificationText() {
  let sends = 0;
  server.use(
    http.post("https://api.agentphone.test/v1/messages", () => {
      sends += 1;
      if (sends === 1) {
        return HttpResponse.json(
          { detail: "temporarily unavailable" },
          { status: 503 },
        );
      }
      return HttpResponse.json({ id: `apmsg_${sends}`, status: "sent" });
    }),
  );
}

describe("AgentPhone verification send cooldown", () => {
  it("agentphone-verification-002 keeps both cooldowns after a provider rejection until 60 seconds pass", async () => {
    integrations.configureAgentPhoneProvider();
    rejectFirstVerificationText();
    const first = integrations.user();
    const second = integrations.user();
    const phoneA = uniquePhoneHandle();
    const phoneB = uniquePhoneHandle();
    const start = now();
    mockNow(start);

    const rejected = await integrations.requestStartAgentPhoneLink(
      first,
      { phoneHandle: phoneA },
      [503],
    );
    expect(rejected.body).toMatchObject({
      error: { code: "PROVIDER_UNAVAILABLE" },
    });

    const sameUser = await integrations.requestStartAgentPhoneLink(
      first,
      { phoneHandle: phoneB },
      [429],
    );
    expect(sameUser.body).toMatchObject({
      error: { code: "TOO_MANY_REQUESTS" },
    });
    const samePhone = await integrations.requestStartAgentPhoneLink(
      second,
      { phoneHandle: phoneA },
      [429],
    );
    expect(samePhone.body).toMatchObject({
      error: { code: "TOO_MANY_REQUESTS" },
    });
    const otherPhone = await integrations.requestStartAgentPhoneLink(
      second,
      { phoneHandle: phoneB },
      [200],
    );
    expect(otherPhone.body).toMatchObject({ verificationSent: true });

    mockNow(start + 59_999);
    const early = await integrations.requestStartAgentPhoneLink(
      first,
      { phoneHandle: phoneA },
      [429],
    );
    expect(early.body).toMatchObject({
      error: { code: "TOO_MANY_REQUESTS" },
    });

    mockNow(start + 60_000);
    const retried = await integrations.requestStartAgentPhoneLink(
      first,
      { phoneHandle: phoneA },
      [200],
    );
    expect(retried.body).toStrictEqual({
      phoneHandle: phoneA,
      verificationSent: true,
    });
  });

  it("agentphone-verification-004 rejects another member's request for a phone whose verification is in flight", async () => {
    integrations.configureAgentPhoneProvider();
    const provider = holdFirstVerificationText();
    const first = integrations.user();
    const second = integrations.user();
    const phoneHandle = uniquePhoneHandle();

    const original = integrations.requestStartAgentPhoneLink(
      first,
      { phoneHandle },
      [200],
    );
    await provider.reached;

    const concurrent = await integrations.requestStartAgentPhoneLink(
      second,
      { phoneHandle },
      [429],
    );
    expect(concurrent.body).toMatchObject({
      error: { code: "TOO_MANY_REQUESTS" },
    });

    provider.release();
    const completed = await original;
    expect(completed.body).toStrictEqual({
      phoneHandle,
      verificationSent: true,
    });
  });

  it("agentphone-verification-005 rejects the same member's request for another phone while a verification is in flight", async () => {
    integrations.configureAgentPhoneProvider();
    const provider = holdFirstVerificationText();
    const member = integrations.user();
    const phoneHandle = uniquePhoneHandle();

    const original = integrations.requestStartAgentPhoneLink(
      member,
      { phoneHandle },
      [200],
    );
    await provider.reached;

    const concurrent = await integrations.requestStartAgentPhoneLink(
      member,
      { phoneHandle: uniquePhoneHandle() },
      [429],
    );
    expect(concurrent.body).toMatchObject({
      error: { code: "TOO_MANY_REQUESTS" },
    });

    provider.release();
    const completed = await original;
    expect(completed.body).toStrictEqual({
      phoneHandle,
      verificationSent: true,
    });
  });
});
