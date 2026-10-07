import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import type { ImageModelId } from "@okouai/api-contracts/contracts/image-models";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { createRouteMocks } from "./helpers/route-test";
const context = testContext();
const mocks = createRouteMocks(context);
function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}
function seedFixture() {
  const id = randomUUID();
  return {
    userId: `user_image_preference_${id}`,
    orgId: `org_image_preference_${id}`,
  };
}
function useSession(fixture: ReturnType<typeof seedFixture>) {
  mocks.clerk.session(fixture.userId, fixture.orgId);
}
describe("member image preference", () => {
  it("stores, preserves, and clears a member image default", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);

    const stored = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: "fal-ai/flux-pro/v1.1",
        },
      }),
      [200],
    );
    expect(stored.body).toMatchObject({
      selectedModel: null,
      selectedImageModel: "fal-ai/flux-pro/v1.1",
    });
    expect(stored.body.updatedAt).not.toBeNull();

    const preserved = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: null, serviceTier: null },
      }),
      [200],
    );
    expect(preserved.body).toMatchObject({
      selectedModel: null,
      selectedImageModel: "fal-ai/flux-pro/v1.1",
    });

    const explicitlyCleared = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: null,
        },
      }),
      [200],
    );
    expect(explicitlyCleared.body.selectedImageModel).toBeNull();
  });

  it("pushes the image-default kind whenever the request carries the field", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);

    context.mocks.ably.publish.mockClear();
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: "gpt-image-2",
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["defaultModel", "defaultImageModel"] },
    );

    context.mocks.ably.publish.mockClear();
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: null,
        },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["defaultModel", "defaultImageModel"] },
    );

    context.mocks.ably.publish.mockClear();
    await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: { selectedModel: null, serviceTier: null },
      }),
      [200],
    );
    await flushWaitUntilForTest();
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "userPreferenceChanged",
      { kinds: ["defaultModel"] },
    );
  });

  it("rejects an image default outside the selectable catalog", async () => {
    const fixture = await seedFixture();
    useSession(fixture);
    const preferenceClient = setupApp({
      context,
      routes: userModelPreferenceRoutes,
    })(userModelPreferenceContract);
    const outsideCatalog = "not-an-image-model" as unknown as ImageModelId;

    const response = await accept(
      preferenceClient.update({
        headers: authHeaders(),
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: outsideCatalog,
        },
      }),
      [400],
    );
    expect(response.status).toBe(400);
  });
});
