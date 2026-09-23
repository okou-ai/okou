import { randomUUID } from "node:crypto";
import { expect, onTestFinished, test } from "vitest";

import { accountErasureStatusContract } from "@okouai/api-contracts/contracts/account-erasure-status";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { withMockNowForTest } from "../../../lib/time";
import {
  closeErasureSubjectFixture,
  markErasureSubjectVerifiedFixture,
  removeErasureSubjectsFixture,
} from "../../../test-fixtures/account-erasure-subject";
import { accountErasureStatusRoutes } from "../account-erasure-status";
import { createRouteMocks } from "./helpers/route-test";

function client(context: ReturnType<typeof testContext>) {
  return setupApp({ context, routes: accountErasureStatusRoutes })(
    accountErasureStatusContract,
  );
}

function userId() {
  return `user_status_${randomUUID()}`;
}

async function decision(subjectId: string) {
  const job = await closeErasureSubjectFixture({
    subjectKind: "user",
    subjectId,
  });
  onTestFinished(async () => {
    await removeErasureSubjectsFixture([job.jobId]);
  });
  return job;
}

test("a pre-deletion owner credential reports only its own committed deletion after session loss", async () => {
  const context = testContext();
  const owner = userId();
  const peer = userId();
  createRouteMocks(context).clerk.session(owner, `org_${randomUUID()}`);
  const issued = await accept(
    client(context).capability({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  const capabilityHeaders = {
    authorization: `Bearer ${issued.body.token}`,
  };
  expect(
    (
      await accept(
        client(context).status({ headers: capabilityHeaders }),
        [200],
      )
    ).body.status,
  ).toBe("active");

  // No Clerk credential is present on the status request. Another account's
  // deletion decision cannot be learned through this owner's capability.
  await decision(peer);
  expect(
    (
      await accept(
        client(context).status({ headers: capabilityHeaders }),
        [200],
      )
    ).body.status,
  ).toBe("active");
  const owned = await decision(owner);
  expect(
    (
      await accept(
        client(context).status({ headers: capabilityHeaders }),
        [200],
      )
    ).body.status,
  ).toBe("pending");

  // The fixture models an independently completed B1 job. Reading status
  // does not advance that job.
  await markErasureSubjectVerifiedFixture(owned.jobId);
  expect(
    (
      await accept(
        client(context).status({ headers: capabilityHeaders }),
        [200],
      )
    ).body.status,
  ).toBe("complete");
});

test("missing, expired, and altered credentials reveal no account status", async () => {
  const context = testContext();
  const owner = userId();
  createRouteMocks(context).clerk.session(owner, `org_${randomUUID()}`);
  const issued = await accept(
    client(context).capability({
      headers: { authorization: "Bearer clerk-session" },
    }),
    [200],
  );
  const token = issued.body.token;
  await withMockNowForTest(Date.parse(issued.body.expiresAt) + 1, async () => {
    await accept(
      client(context).status({ headers: { authorization: `Bearer ${token}` } }),
      [404],
    );
  });
  const changed = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  for (const authorization of [
    undefined,
    `Bearer ${owner}`,
    `Bearer ${changed}`,
  ]) {
    const headers = authorization ? { authorization } : {};
    await accept(client(context).status({ headers }), [404]);
  }
  await accept(client(context).capability({ headers: {} }), [401]);
});
