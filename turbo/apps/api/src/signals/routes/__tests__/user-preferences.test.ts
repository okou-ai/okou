import { randomUUID } from "node:crypto";
import {
  cliAuthApproveContract,
  cliAuthDeviceContract,
  cliAuthTokenContract,
} from "@okouai/api-contracts/contracts/cli-auth";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import {
  type UpdateUserPreferencesRequest,
  USER_PREFERENCES_UNINITIALIZED,
  userPreferencesContract,
} from "@okouai/api-contracts/contracts/user-preferences";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { cliAuthRoutes } from "../cli-auth";
import { featureSwitchesRoutes } from "../feature-switches";
import { userPreferencesRoutes } from "../user-preferences";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
interface AuthHeaders {
  readonly authorization: string;
}

const session: AuthHeaders = Object.freeze({
  authorization: "Bearer clerk-session",
});
const presentation = FeatureSwitchKey.PresentationOutputFormat;

const app = setupApp({
  context,
  routes: [
    ...userPreferencesRoutes,
    ...featureSwitchesRoutes,
    ...cliAuthRoutes,
  ],
});
const prefs = () => {
  return app(userPreferencesContract);
};
const switches = () => {
  return app(featureSwitchesContract);
};

function newUser() {
  return `user_${randomUUID()}`;
}

function newOrg() {
  return `org_${randomUUID()}`;
}

function signIn(
  userId: string,
  orgId: string,
  role: "org:admin" | "org:member" = "org:admin",
) {
  createRouteMocks(context).clerk.session(userId, orgId, role);
}

async function initialize(
  body: { timezone?: string; locale: "en-US" | "ja-JP" },
  headers: AuthHeaders = session,
) {
  return (await accept(prefs().initialize({ headers, body }), [200])).body;
}

async function read() {
  return (await accept(prefs().get({ headers: session }), [200])).body;
}

async function save(
  body: UpdateUserPreferencesRequest,
  headers: AuthHeaders = session,
) {
  return (await accept(prefs().update({ headers, body }), [200])).body;
}

async function rejectSave(
  body: UpdateUserPreferencesRequest,
  headers: AuthHeaders = session,
) {
  const response = await accept(prefs().update({ headers, body }), [400]);
  return JSON.stringify(response.body);
}

async function setPresentation(enabled: boolean) {
  const response = await accept(
    switches().update({
      headers: session,
      body: { switches: { [presentation]: enabled } },
    }),
    [200],
  );
  return response.body.effectiveSwitches[presentation];
}

async function issueCliToken(userId: string, orgId: string) {
  const device = await accept(
    app(cliAuthDeviceContract).create({ body: {} }),
    [200],
  );
  signIn(userId, orgId);
  await accept(
    app(cliAuthApproveContract).approve({
      headers: session,
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  const issued = await accept(
    app(cliAuthTokenContract).exchange({
      body: { device_code: device.body.device_code },
    }),
    [200],
  );
  if (issued.status !== 200) {
    throw new Error("Expected an issued CLI token");
  }
  context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
    data: [
      {
        role: "org:admin",
        organization: { id: orgId, slug: orgId.toLowerCase(), name: "Org" },
        publicUserData: { userId },
        createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      },
    ],
  });
  return { authorization: `Bearer ${issued.body.access_token}` };
}

describe("/api/user-preferences", () => {
  it("user-preferences-001 requires initialization and keeps the first saved timezone and locale", async () => {
    signIn(newUser(), newOrg());

    const uninitialized = await accept(
      prefs().get({ headers: session }),
      [409],
    );
    expect(uninitialized.body).toMatchObject({
      error: { code: USER_PREFERENCES_UNINITIALIZED },
    });

    const initialized = await initialize({
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
    });
    expect(initialized).toMatchObject({
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
    });
    await expect(read()).resolves.toStrictEqual(initialized);

    const repeated = await initialize({
      timezone: "America/Los_Angeles",
      locale: "en-US",
    });
    expect(repeated).toMatchObject({
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
    });
  });

  it("user-preferences-004 defaults the timezone to Pacific Time when none is provided", async () => {
    signIn(newUser(), newOrg());

    const initialized = await initialize({ locale: "en-US" });
    expect(initialized).toMatchObject({
      timezone: "America/Los_Angeles",
      locale: "en-US",
    });
    await expect(read()).resolves.toStrictEqual(initialized);
  });

  it("user-preferences-005 keeps the For You cover per workspace member until it is reset", async () => {
    const orgId = newOrg();
    const memberId = newUser();
    signIn(memberId, orgId);
    expect(
      (await initialize({ timezone: "UTC", locale: "en-US" })).forYouCoverId,
    ).toBeNull();

    expect((await save({ forYouCoverId: "cover-08" })).forYouCoverId).toBe(
      "cover-08",
    );
    expect((await read()).forYouCoverId).toBe("cover-08");

    signIn(newUser(), orgId);
    expect(
      (await initialize({ timezone: "UTC", locale: "en-US" })).forYouCoverId,
    ).toBeNull();
    signIn(memberId, newOrg());
    expect(
      (await initialize({ timezone: "UTC", locale: "en-US" })).forYouCoverId,
    ).toBeNull();

    signIn(memberId, orgId);
    expect((await save({ theme: "dark" })).forYouCoverId).toBe("cover-08");
    expect((await read()).forYouCoverId).toBe("cover-08");
    const reset = await save({ forYouCoverId: null });
    expect(reset).toMatchObject({ forYouCoverId: null, theme: "dark" });
    await expect(read()).resolves.toMatchObject({
      forYouCoverId: null,
      theme: "dark",
    });
  });

  it("user-preferences-009 hides presentation preferences while opted out and restores them after opting back in", async () => {
    signIn(newUser(), newOrg());
    await setPresentation(true);
    await initialize({ timezone: "UTC", locale: "en-US" });
    expect(
      (await save({ presentationFormat: "pptx" })).presentationFormat,
    ).toBe("pptx");

    await expect(setPresentation(false)).resolves.toBeFalsy();
    await expect(read()).resolves.not.toHaveProperty("presentationFormat");
    await expect(rejectSave({ presentationFormat: "html" })).resolves.toContain(
      "At least one preference must be provided",
    );
    const mixed = await save({ theme: "dark", presentationFormat: "html" });
    expect(mixed.theme).toBe("dark");
    expect(mixed).not.toHaveProperty("presentationFormat");
    await expect(
      initialize({ timezone: "UTC", locale: "en-US" }),
    ).resolves.not.toHaveProperty("presentationFormat");

    await expect(setPresentation(true)).resolves.toBeTruthy();
    await expect(read()).resolves.toMatchObject({
      presentationFormat: "pptx",
      theme: "dark",
    });
  });

  it("user-preferences-011 lets an ordinary member opt in and save HTML then PPTX presentations", async () => {
    signIn(newUser(), newOrg(), "org:member");

    const initial = await accept(switches().get({ headers: session }), [200]);
    expect(initial.body.effectiveSwitches[presentation]).toBeFalsy();
    await expect(
      initialize({ timezone: "UTC", locale: "en-US" }),
    ).resolves.not.toHaveProperty("presentationFormat");

    await expect(setPresentation(true)).resolves.toBeTruthy();
    const optedIn = await accept(switches().get({ headers: session }), [200]);
    expect(optedIn.body.effectiveSwitches[presentation]).toBeTruthy();
    expect((await read()).presentationFormat).toBeNull();

    expect(
      (await save({ presentationFormat: "html" })).presentationFormat,
    ).toBe("html");
    expect((await read()).presentationFormat).toBe("html");
    expect(
      (await save({ presentationFormat: "pptx" })).presentationFormat,
    ).toBe("pptx");
    expect((await read()).presentationFormat).toBe("pptx");
  });

  it("user-preferences-012 lets a CLI token save legacy preferences but not the presentation format", async () => {
    const userId = newUser();
    const orgId = newOrg();
    signIn(userId, orgId);
    await setPresentation(true);
    const cli = await issueCliToken(userId, orgId);

    await expect(save({ theme: "dark" }, cli)).resolves.toMatchObject({
      theme: "dark",
      presentationFormat: null,
    });
    await expect(
      rejectSave({ presentationFormat: "pptx", theme: "light" }, cli),
    ).resolves.toContain(
      "Presentation format preferences require a human session",
    );
    await expect(save({ locale: "en-US" }, cli)).resolves.toMatchObject({
      theme: "dark",
      presentationFormat: null,
    });

    signIn(userId, orgId);
    await expect(setPresentation(false)).resolves.toBeFalsy();
    const mixed = await save(
      { theme: "light", presentationFormat: "pptx" },
      cli,
    );
    expect(mixed.theme).toBe("light");
    expect(mixed).not.toHaveProperty("presentationFormat");
    await expect(
      rejectSave({ presentationFormat: "pptx" }, cli),
    ).resolves.toContain("At least one preference must be provided");

    await expect(setPresentation(true)).resolves.toBeTruthy();
    await expect(save({ locale: "en-US" }, cli)).resolves.toMatchObject({
      theme: "light",
      presentationFormat: null,
    });
  });
});
