import { randomUUID } from "node:crypto";
import { userModelPreferenceContract } from "@okouai/api-contracts/contracts/user-model-preference";
import { describe, expect, it } from "vitest";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { userModelPreferenceRoutes } from "../user-model-preference";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const preferences = setupApp({ context, routes: userModelPreferenceRoutes })(
  userModelPreferenceContract,
);

function signIn() {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
    "org:member",
  );
}

describe("member image preference", () => {
  it("user-model-image-preference-001 stores canonical Auto for a null model selection", async () => {
    signIn();

    const updated = await accept(
      preferences.update({
        headers,
        body: { selectedModel: null, serviceTier: null },
      }),
      [200],
    );
    const read = await accept(preferences.get({ headers }), [200]);
    const effort = await preferences.update({
      headers,
      body: {
        selectedModel: null,
        serviceTier: null,
        modelSettingsPatch: { model: "auto", effort: "high" },
      },
    });

    expect(updated.body).toMatchObject({
      selectedModel: "auto",
      serviceTier: null,
      modelSettings: {},
    });
    expect(read.body).toMatchObject({
      selectedModel: "auto",
      serviceTier: null,
    });
    expect(effort.status).toBe(400);
  });

  it("user-model-image-preference-003 stores, preserves and clears the member image default", async () => {
    signIn();

    const saved = await accept(
      preferences.update({
        headers,
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: "fal-ai/flux-pro/v1.1",
        },
      }),
      [200],
    );
    const preserved = await accept(
      preferences.update({
        headers,
        body: { selectedModel: null, serviceTier: null },
      }),
      [200],
    );
    const cleared = await accept(
      preferences.update({
        headers,
        body: {
          selectedModel: null,
          serviceTier: null,
          selectedImageModel: null,
        },
      }),
      [200],
    );

    expect(saved.body).toMatchObject({
      selectedModel: "auto",
      selectedImageModel: "fal-ai/flux-pro/v1.1",
      updatedAt: expect.any(String),
    });
    expect(preserved.body.selectedImageModel).toBe("fal-ai/flux-pro/v1.1");
    expect(cleared.body.selectedImageModel).toBeNull();
    const read = await accept(preferences.get({ headers }), [200]);
    expect(read.body.selectedImageModel).toBeNull();
  });
});
