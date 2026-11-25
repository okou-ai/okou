import { artifactSharingContract } from "@okouai/api-contracts/contracts/artifact-sharing";
import {
  artifactReferencesContract,
  artifactReferencePath,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import {
  click,
  fill,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getButtonByName,
  findArtifactAction,
} from "../../artifacts-page/__tests__/artifact-catalog-test-helpers.ts";
import {
  artifactRun,
  artifactSummary,
  fileArtifactDetail,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const fileId = "00000000-0000-4000-8000-000000000721";
const summary = artifactSummary(
  "00000000-0000-4000-8000-000000000722",
  "file",
  "recording.mp4",
);
const canonical = artifactReferencePath(fileId, summary.title);
const signed = "https://files.example.test/recording.mp4?signature=private";
const account = {
  userId: "user_taylor",
  name: "Taylor Viewer",
  email: "taylor@example.com",
} as const;
const shareId = "00000000-0000-4000-8000-000000000723";

function permission(name: string) {
  const choice = queryAllByRoleFast("radio").find((element) => {
    return element.getAttribute("aria-label") === name;
  });
  if (!choice) {
    throw new Error(`Missing permission ${name}`);
  }
  return choice;
}

async function openArtifact(
  surface: "thread" | "catalog" | "viewer",
  emailSharing = true,
) {
  const detail = fileArtifactDetail(summary, {
    filename: summary.title,
    contentType: "video/mp4",
    fileId,
    url: canonical,
  });
  mockArtifactConversation(context, {
    catalog: [summary],
    getDetail: () => {
      return detail;
    },
    artifactRuns: () => {
      return [
        artifactRun({
          artifactId: summary.id,
          filename: summary.title,
          contentType: "video/mp4",
          fileId,
          url: canonical,
        }),
      ];
    },
    chatEvents: [],
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Unavailable" },
    });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(200, {
      url: signed,
      downloadUrl: signed,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: summary.title,
      contentType: "video/mp4",
      target: { kind: "file", id: fileId },
    });
  });
  context.mocks.api(artifactReferencesContract.ownerArtifact, ({ respond }) => {
    return respond(200, { artifactId: summary.id });
  });
  let audience: ArtifactShareStatus["audience"] = "private";
  const status = (): ArtifactShareStatus => {
    return {
      ownerUrl: new URL(canonical, "https://app.okou.ai").href,
      audience,
      shareId: audience === "private" ? null : shareId,
      organization: { id: "org_test", name: "Acme" },
      selectedTarget:
        audience === "private" ? null : { kind: "file", id: fileId },
      selectedVersion: null,
      candidateVersion: null,
      url: null,
      shortUrl: null,
    };
  };
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, status());
  });
  context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
    audience = body.audience;
    return respond(200, status());
  });
  let shares: { id: string; email: string }[] = [];
  context.mocks.api(artifactSharingContract.list, ({ params, respond }) => {
    expect(params).toMatchObject({ kind: "file", id: fileId });
    return respond(200, { shares });
  });
  context.mocks.api(artifactSharingContract.search, ({ respond }) => {
    return respond(200, { accounts: [account] });
  });
  context.mocks.api(
    artifactSharingContract.share,
    ({ params, body, respond }) => {
      expect(params).toMatchObject({ kind: "file", id: fileId });
      expect(body.email).toBe(account.email);
      shares = [{ id: shareId, email: body.email }];
      return respond(200, { share: shares[0]! });
    },
  );
  context.mocks.api(artifactSharingContract.remove, ({ params, respond }) => {
    shares = [];
    return respond(200, { removed: params.shareId });
  });
  await setupPage({
    context,
    host: "app.okou.ai",
    path:
      surface === "thread"
        ? `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`
        : surface === "catalog"
          ? "/artifacts"
          : canonical,
    featureSwitches: {
      [FeatureSwitchKey.HostedSiteEmailSharing]: emailSharing,
    },
  });
  if (surface === "thread") {
    await openResourceArtifact(summary.title);
  } else if (surface === "catalog") {
    click(await findArtifactAction(summary.title));
  }
  const label = surface === "viewer" ? "Share" : "Share artifact";
  await waitFor(() => {
    return expect(getButtonByName(label)).toBeVisible();
  });
  click(getButtonByName(label));
  const menu = await screen.findByRole("dialog", { name: "Share" });
  return { menu, label };
}

test.each(["thread", "catalog", "viewer"] as const)(
  "%s file preview offers invitations and keeps its content while audiences change",
  async (surface) => {
    const { menu } = await openArtifact(surface);
    expect(permission("Invited people")).toBeChecked();
    const video = document.querySelector("video");
    expect(video).toHaveAttribute("src", signed);
    const invite = getButtonByName("Invite", menu);
    const input = within(menu).getByRole("combobox", {
      name: "Share with people",
    });
    await fill(input, "Taylor");
    await screen.findByRole("option", { name: /Taylor Viewer/ });
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}{Enter}");
    await waitFor(() => {
      return expect(input).toHaveValue(account.email);
    });
    expect(invite).toBeEnabled();
    await user.click(invite);
    await expect(
      screen.findByText("Sharing invitation processed"),
    ).resolves.toBeInTheDocument();
    await within(menu).findByText(account.email);
    expect(within(menu).getByText("Owner")).toBeInTheDocument();
    for (const name of ["Workspace", "Anyone", "Invited people"]) {
      click(permission(name));
      await waitFor(() => {
        return expect(permission(name)).toBeChecked();
      });
      expect(document.querySelector("video")).toHaveAttribute("src", signed);
      // Invitations keep granting access in every audience, so the list stays.
      expect(within(menu).getByText(account.email)).toBeVisible();
    }
    click(getButtonByName(`Remove access for ${account.email}`, menu));
    await waitFor(() => {
      return expect(
        within(menu).queryByText(account.email),
      ).not.toBeInTheDocument();
    });
    expect(within(menu).getByText("Owner")).toBeInTheDocument();
  },
);

test("ordinary file invitations stay behind the existing server switch", async () => {
  const { menu } = await openArtifact("thread", false);
  expect(permission("Only me")).toBeChecked();
  expect(within(menu).queryByRole("combobox")).not.toBeInTheDocument();
});
