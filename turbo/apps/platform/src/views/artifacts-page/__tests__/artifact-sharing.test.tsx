import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  artifactAccessContract,
  type ArtifactVisibilityResponse,
  type ArtifactVisibilityValue,
} from "@okouai/api-contracts/contracts/artifact-access";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { getButtonByName } from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const host = "app.okou.ai";
const path = "/artifacts/coast025ab.png";
const ownerUrl = "https://app.okou.ai/artifacts/owner025ab.png";

const fileId = "55000000-0000-4000-8000-000000000025";

function permissions(
  visibility: ArtifactVisibilityValue,
): ArtifactVisibilityResponse {
  const sharedUrl =
    visibility === "public" ? "https://a.okou.io/short025ab.png" : null;
  return {
    artifactId: fileId,
    kind: "file",
    visibility,
    ownerUrl,
    shareUrl: sharedUrl,
    shortUrl: sharedUrl,
    organization: { id: "acme", name: "Acme" },
  };
}

async function openOwnerMenu(
  audience: "private" | "public",
  invitations = false,
) {
  const file = "https://media.example.test/coast.png";
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: file,
      downloadUrl: file,
      filename: "Coast.png",
      contentType: "image/png",
      expiresAt: "2099-01-01T00:00:00Z",
      artifactId: fileId,
      target: { kind: "file", id: fileId },
    });
  });
  context.mocks.api(artifactAccessContract.getVisibility, ({ respond }) => {
    return respond(200, permissions(audience));
  });
  await setupPage({
    context,
    host,
    path,
    featureSwitches: { [FeatureSwitchKey.ArtifactUserSharing]: invitations },
  });
  await expect(
    screen.findByRole("heading", { name: "Coast.png" }),
  ).resolves.toBeInTheDocument();
  click(getButtonByName("Share"));
  return await screen.findByRole("radiogroup");
}

test("artifact-sharing-001 explains the three audiences to the private file owner", async () => {
  const menu = await openOwnerMenu("private");
  for (const [name, description, checked] of [
    ["Only me", "Only you can open it", "true"],
    ["Anyone at Acme", "Teammates can view", "false"],
    ["Anyone with the link", "No sign-in needed", "false"],
  ] as const) {
    const choice = within(menu).getByLabelText(name);
    expect(choice).toHaveAccessibleDescription(description);
    expect(within(menu).getByText(description)).toBeVisible();
    expect(choice).toHaveAttribute("aria-checked", checked);
  }
  expect(getButtonByName("Copy link")).toBeEnabled();
});

test("artifact-sharing-004 copies the permission response's canonical owner address", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openOwnerMenu("public");
  click(getButtonByName("Copy link"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([ownerUrl]);
  });
});

test("artifact-sharing-007 returns to the full artifact link after the visitor explicitly chooses sign-in", async () => {
  const navigation = context.mocks.browser.locationAssign();
  const route =
    path +
    "?redirect_url=" +
    encodeURIComponent("https://outside.example.test/other") +
    "#coast";
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No public file" },
    });
  });
  await setupPage({ context, path: route, auth: null, host });
  await expect(
    screen.findByRole("heading", { name: "You can’t view this artifact" }),
  ).resolves.toBeInTheDocument();
  expect(navigation.calls).toStrictEqual([]);
  click(getButtonByName("Sign in"));
  await waitFor(() => {
    const destination = new URL(navigation.calls[0] ?? "", location.href);
    expect(destination.origin + destination.pathname).toBe(
      "https://" + host + "/sign-in",
    );
    expect(
      new URLSearchParams(destination.hash.split("?")[1]).get("redirect_url"),
    ).toBe("https://" + host + route);
  });
});

test.each([false, true])(
  "artifact-sharing-002 The owner copies the canonical link across all audiences (invitations %s)",
  async (invitations) => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const amendments: ArtifactVisibilityValue[] = [];
    context.mocks.api(
      artifactAccessContract.updateVisibility,
      ({ body, respond }) => {
        amendments.push(body.visibility);
        return respond(200, permissions(body.visibility));
      },
    );
    context.mocks.api(artifactAccessContract.listShares, ({ respond }) => {
      return respond(200, { shares: [] });
    });
    const menu = within(await openOwnerMenu("private", invitations));
    await waitFor(() => {
      const people = screen.queryByRole("combobox", {
        name: "Share with people",
      });
      expect(people !== null).toBe(invitations);
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(/link copied/i)).toBeNull();
    const labels = invitations
      ? ["Workspace", "Anyone", "Invited people"]
      : ["Anyone at Acme", "Anyone with the link", "Only me"];
    for (const [index, label] of labels.entries()) {
      const option = menu.getByLabelText(label);
      click(option);
      await waitFor(() => {
        return expect(amendments).toHaveLength(index + 1);
      });
      await waitFor(() => {
        return expect(option).toHaveAttribute("aria-checked", "true");
      });
      click(getButtonByName("Copy link"));
      await waitFor(() => {
        return expect(clipboard.writes[index]).toBe(ownerUrl);
      });
    }
    expect(amendments).toStrictEqual(["organization", "public", "private"]);
  },
);
