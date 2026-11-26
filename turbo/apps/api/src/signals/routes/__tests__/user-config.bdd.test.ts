import { expect, test } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { mockNow, now } from "../../../lib/time";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createAuthDeviceApiActions } from "./helpers/api-bdd-auth-device";
import { createUserConfigBddApi } from "./helpers/api-bdd-user-config";

const context = testContext();
const device = createAuthDeviceApiActions(context);
const userConfig = createUserConfigBddApi(context);

const SESSION_COOKIE = "__session=browser-session";

async function issueCliToken(actor: ApiTestUser): Promise<string> {
  const started = await device.startCliDevice();
  await device.requestCliApproval(
    actor,
    { device_code: started.device_code },
    [200],
  );
  const issued = await device.requestCliToken(started.device_code, [200]);
  if (issued.status !== 200) {
    throw new Error("Expected an issued CLI token");
  }
  return issued.body.access_token;
}

function identity(actor: ApiTestUser) {
  return {
    userId: actor.userId,
    email: actor.email,
    orgId: actor.orgId ?? null,
  };
}

test("user-config.bdd-004 resolves session identities and rejects missing or non-bearer credentials", async () => {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
  const loner = bdd.user({ orgId: null });
  userConfig.mockClerkUsers([admin, member, loner]);
  const cookie = { cookie: SESSION_COOKIE };

  for (const actor of [admin, member, loner]) {
    userConfig.mockSession(actor);
    const me = await userConfig.requestMe(cookie, [200]);
    expect(me.body).toMatchObject(identity(actor));
  }

  userConfig.mockSession(null);
  await expect(userConfig.requestMe(cookie, [401])).resolves.toMatchObject({
    body: { error: { code: "UNAUTHORIZED" } },
  });

  userConfig.mockSession(admin);
  for (const headers of [
    {},
    { authorization: "Basic YWRtaW46c2VjcmV0" },
    { authorization: "Bearer " },
  ]) {
    await expect(userConfig.requestMe(headers, [401])).resolves.toMatchObject({
      body: { error: { code: "UNAUTHORIZED" } },
    });
  }

  userConfig.mockSession(null);
  await expect(
    userConfig.requestMe({ authorization: "Bearer opaque-format" }, [401]),
  ).resolves.toMatchObject({ body: { error: { code: "UNAUTHORIZED" } } });

  userConfig.mockSession(member);
  const withCookie = await userConfig.requestMe(
    { authorization: "Bearer opaque-format", cookie: SESSION_COOKIE },
    [200],
  );
  expect(withCookie.body).toMatchObject(identity(member));
});

test("user-config.bdd-005 resolves CLI tokens with Clerk organization membership", async () => {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.provisionWorkspace(admin);
  const member = bdd.user({ orgId: admin.orgId, orgRole: "org:member" });
  const loner = bdd.user();

  for (const actor of [admin, member]) {
    const token = await issueCliToken(actor);
    const me = await device.readMeWithBearer(token, actor, [200]);
    expect(me.body).toStrictEqual(identity(actor));
  }

  const lonerToken = await issueCliToken(loner);
  const withoutMembership = { ...loner, orgId: null };
  const lonerMe = await device.readMeWithBearer(
    lonerToken,
    withoutMembership,
    [200],
  );
  expect(lonerMe.body).toStrictEqual(identity(withoutMembership));
});

test("user-config.bdd-008 expires CLI tokens after their 90-day lifetime", async () => {
  const bdd = createBddApi(context);
  const admin = bdd.user();
  await bdd.provisionWorkspace(admin);
  const token = await issueCliToken(admin);

  const fresh = await device.readMeWithBearer(token, admin, [200]);
  expect(fresh.body).toMatchObject({
    userId: admin.userId,
    orgId: admin.orgId,
  });

  mockNow(now() + 91 * 24 * 60 * 60 * 1000);
  await expect(
    device.readMeWithBearer(token, admin, [401]),
  ).resolves.toMatchObject({ body: { error: { code: "UNAUTHORIZED" } } });
});
