import { integrationsAgentPhoneContract } from "@okouai/api-contracts/contracts/integrations-agentphone";
import { http, HttpResponse } from "msw";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { server } from "../../../mocks/server";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { integrationsAgentPhoneRoutes } from "../integrations-agentphone";
import { uniquePhoneHandle } from "./helpers/api-bdd-agentphone";
import { createBddIntegrationApi } from "./helpers/api-bdd-integrations";

const context = testContext();

describe("AgentPhone verification send cooldown", () => {
  it("reserves a cold user/org race once without consuming the rejected phone", async () => {
    const integrations = createBddIntegrationApi(context);
    integrations.configureAgentPhoneProvider();
    const actor = integrations.user();
    const firstPhone = uniquePhoneHandle();
    const secondPhone = uniquePhoneHandle();
    mockNow(Date.parse("2026-10-22T00:00:00Z"));
    await integrations.getAgentPhoneLinkStatus(actor);
    server.use(
      http.post("https://api.agentphone.test/v1/messages", () => {
        return HttpResponse.json({});
      }),
    );

    const results = await Promise.all([
      integrations.requestStartAgentPhoneLink(
        actor,
        { phoneHandle: firstPhone },
        [200, 429],
      ),
      integrations.requestStartAgentPhoneLink(
        actor,
        { phoneHandle: secondPhone },
        [200, 429],
      ),
    ]);
    expect(
      results
        .map((result) => {
          return result.status;
        })
        .sort(),
    ).toStrictEqual([200, 429]);
    const rejectedPhone = results[0].status === 429 ? firstPhone : secondPhone;
    const independent = await integrations.requestStartAgentPhoneLink(
      integrations.user(),
      { phoneHandle: rejectedPhone },
      [200],
    );
    expect(independent.body).toStrictEqual({
      phoneHandle: rejectedPhone,
      verificationSent: true,
    });
  });

  it.each(["provider rejection", "network failure"])(
    "keeps both cooldowns after a %s until the original 60 seconds expire",
    async (failure) => {
      const integrations = createBddIntegrationApi(context);
      integrations.configureAgentPhoneProvider();
      const actor = integrations.user();
      const otherActor = integrations.user();
      const phoneHandle = uniquePhoneHandle();
      const otherPhone = uniquePhoneHandle();
      const startedAt = Date.parse("2026-10-22T00:00:00Z");
      mockNow(startedAt);
      server.use(
        http.post("https://api.agentphone.test/v1/messages", () => {
          return failure === "network failure"
            ? HttpResponse.error()
            : HttpResponse.json({ detail: "unavailable" }, { status: 503 });
        }),
      );

      const failed = await integrations.requestStartAgentPhoneLink(
        actor,
        { phoneHandle },
        [503],
      );
      expect(failed.body).toMatchObject({
        error: { code: "PROVIDER_UNAVAILABLE" },
      });
      server.use(
        http.post("https://api.agentphone.test/v1/messages", () => {
          return HttpResponse.json({});
        }),
      );

      const sameUser = await integrations.requestStartAgentPhoneLink(
        actor,
        { phoneHandle: otherPhone },
        [429],
      );
      expect(sameUser.body).toMatchObject({
        error: { code: "TOO_MANY_REQUESTS" },
      });
      const samePhone = await integrations.requestStartAgentPhoneLink(
        otherActor,
        { phoneHandle },
        [429],
      );
      expect(samePhone.body).toMatchObject({
        error: { code: "TOO_MANY_REQUESTS" },
      });

      // Rejected attempts must not consume the other phone or user's cooldown.
      const independent = await integrations.requestStartAgentPhoneLink(
        otherActor,
        { phoneHandle: otherPhone },
        [200],
      );
      expect(independent.body).toStrictEqual({
        phoneHandle: otherPhone,
        verificationSent: true,
      });

      mockNow(startedAt + 59_999);
      const beforeExpiry = await integrations.requestStartAgentPhoneLink(
        actor,
        { phoneHandle },
        [429],
      );
      expect(beforeExpiry.body).toMatchObject({
        error: { code: "TOO_MANY_REQUESTS" },
      });
      mockNow(startedAt + 60_000);
      const retried = await integrations.requestStartAgentPhoneLink(
        actor,
        { phoneHandle },
        [200],
      );
      expect(retried.body).toStrictEqual({
        phoneHandle,
        verificationSent: true,
      });
    },
  );

  it.each(["phone", "user/org"])(
    "rejects a concurrent request for the same %s before the provider responds",
    async (scope) => {
      const integrations = createBddIntegrationApi(context);
      integrations.configureAgentPhoneProvider();
      const actor = integrations.user();
      const phoneHandle = uniquePhoneHandle();
      mockNow(Date.parse("2026-10-22T00:00:00Z"));
      const entered = createDeferredPromise<void>(context.signal);
      const response = createDeferredPromise<void>(context.signal);
      server.use(
        http.post("https://api.agentphone.test/v1/messages", async () => {
          entered.resolve();
          await response.promise;
          return HttpResponse.json({});
        }),
      );

      const first = settleIncludingAbort(
        integrations.requestStartAgentPhoneLink(actor, { phoneHandle }, [200]),
      );
      onTestFinished(async () => {
        if (!response.settled()) {
          response.resolve();
        }
        await first;
      });
      await entered.promise;
      const concurrent = await integrations.requestStartAgentPhoneLink(
        scope === "phone" ? integrations.user() : actor,
        {
          phoneHandle: scope === "phone" ? phoneHandle : uniquePhoneHandle(),
        },
        [429],
      );
      expect(concurrent.body).toMatchObject({
        error: { code: "TOO_MANY_REQUESTS" },
      });
      response.resolve();
      const sent = await first;
      if (!sent.ok) {
        throw sent.error;
      }
      expect(sent.value.body).toStrictEqual({
        phoneHandle,
        verificationSent: true,
      });
    },
  );

  it("retains the committed cooldown when the API owner aborts an in-flight send", async () => {
    const integrations = createBddIntegrationApi(context);
    integrations.configureAgentPhoneProvider();
    const actor = integrations.user();
    const phoneHandle = uniquePhoneHandle();
    await integrations.getAgentPhoneLinkStatus(actor);
    const controller = new AbortController();
    const client = setupApp({
      context,
      routes: integrationsAgentPhoneRoutes,
      signal: AbortSignal.any([context.signal, controller.signal]),
      rethrowErrors: true,
    })(integrationsAgentPhoneContract);
    const entered = createDeferredPromise<void>(context.signal);
    const response = createDeferredPromise<void>(context.signal);
    server.use(
      http.post("https://api.agentphone.test/v1/messages", async () => {
        entered.resolve();
        await response.promise;
        return HttpResponse.json({});
      }),
    );
    const sending = settleIncludingAbort(
      client.startLink({
        headers: { authorization: "Bearer clerk-session" },
        body: { phoneHandle },
      }),
    );
    onTestFinished(async () => {
      controller.abort();
      if (!response.settled()) {
        response.resolve();
      }
      await sending;
    });
    await entered.promise;
    controller.abort(new DOMException("API owner stopped", "AbortError"));
    const cancelled = await sending;
    if (cancelled.ok) {
      throw new Error("Expected API owner cancellation to propagate");
    }
    expect(cancelled.error).toMatchObject({ name: "AbortError" });
    response.resolve();

    const retried = await integrations.requestStartAgentPhoneLink(
      actor,
      { phoneHandle },
      [429],
    );
    expect(retried.body).toMatchObject({
      error: { code: "TOO_MANY_REQUESTS" },
    });
  });
});
