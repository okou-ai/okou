import {
  artifactAccessContract,
  type ArtifactUserShareEntry,
  type ArtifactVisibilityResponse,
  type ArtifactVisibilityValue,
} from "@okouai/api-contracts/contracts/artifact-access";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencesContract,
  artifactReferencePath,
} from "@okouai/api-contracts/contracts/artifact-references";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { act, screen, waitFor, within } from "@testing-library/react";
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
import { openSharing } from "../../artifacts-page/__tests__/site-access-fixtures.ts";

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

function permission(name: string) {
  const choice = queryAllByRoleFast("radio").find((element) => {
    return element.getAttribute("aria-label") === name;
  });
  if (!choice) {
    throw new Error(`Missing permission ${name}`);
  }
  return choice;
}

async function previewArtifact(
  surface: "thread" | "catalog" | "viewer",
  emailSharing = true,
  configureSharing?: () => void,
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
      artifactId: summary.id,
      target: { kind: "file", id: fileId },
    });
  });
  context.mocks.api(artifactReferencesContract.ownerArtifact, ({ respond }) => {
    return respond(200, { artifactId: summary.id });
  });
  let audience: ArtifactVisibilityValue = "private";
  const status = (): ArtifactVisibilityResponse => {
    return {
      artifactId: fileId,
      kind: "file",
      visibility: audience,
      ownerUrl: new URL(canonical, "https://app.okou.ai").href,
      shareUrl: null,
      shortUrl: null,
      organization: { id: "org_test", name: "Acme" },
    };
  };
  context.mocks.api(artifactAccessContract.getVisibility, ({ respond }) => {
    return respond(200, status());
  });
  context.mocks.api(
    artifactAccessContract.updateVisibility,
    ({ body, respond }) => {
      audience = body.visibility;
      return respond(200, status());
    },
  );
  let shares: ArtifactUserShareEntry[] = [];
  context.mocks.api(
    artifactAccessContract.listShares,
    ({ params, respond }) => {
      expect(params).toMatchObject({ artifactId: fileId });
      return respond(200, { shares });
    },
  );
  context.mocks.api(
    artifactAccessContract.searchShareAccounts,
    ({ respond }) => {
      return respond(200, { accounts: [account] });
    },
  );
  context.mocks.api(
    artifactAccessContract.addShare,
    ({ params, body, respond }) => {
      expect(params).toMatchObject({ artifactId: fileId });
      expect(body).toStrictEqual({ userId: account.userId });
      shares = [
        { userId: account.userId, email: account.email, name: account.name },
      ];
      return respond(200, { share: shares[0]! });
    },
  );
  context.mocks.api(
    artifactAccessContract.removeShare,
    ({ params, respond }) => {
      expect(params.userId).toBe(account.userId);
      shares = [];
      return respond(200, { removed: params.userId });
    },
  );
  configureSharing?.();
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
      [FeatureSwitchKey.ArtifactUserSharing]: emailSharing,
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
  return { label };
}

async function openArtifact(
  surface: "thread" | "catalog" | "viewer",
  emailSharing = true,
  configureSharing?: () => void,
) {
  const { label } = await previewArtifact(
    surface,
    emailSharing,
    configureSharing,
  );
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
    const people = () => {
      return within(menu).getByRole("list", { name: "People with access" });
    };
    for (const name of ["Workspace", "Anyone", "Invited people"]) {
      click(permission(name));
      await waitFor(() => {
        expect(permission(name)).toBeChecked();
        expect(within(menu).getByRole("radiogroup")).toHaveAttribute(
          "aria-busy",
          "false",
        );
      });
      expect(document.querySelector("video")).toHaveAttribute("src", signed);
      // Invitations keep granting access in every audience, so the list stays.
      expect(people()).toHaveTextContent(account.email);
    }
    click(permission("Workspace"));
    await waitFor(() => {
      expect(permission("Workspace")).toBeChecked();
      expect(within(menu).getByRole("radiogroup")).toHaveAttribute(
        "aria-busy",
        "false",
      );
    });
    click(getButtonByName(`Remove access for ${account.email}`, menu));
    await waitFor(() => {
      return expect(people()).not.toHaveTextContent(account.email);
    });
    expect(permission("Workspace")).toBeChecked();
    expect(within(menu).getByText("Owner")).toBeInTheDocument();
  },
);

test("ordinary file invitations stay behind the existing server switch", async () => {
  const { menu } = await openArtifact("thread", false);
  expect(permission("Only me")).toBeChecked();
  expect(within(menu).queryByRole("combobox")).not.toBeInTheDocument();
});

test("A catalog snapshot copies its immutable reference without offering permission edits", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const { label } = await previewArtifact("catalog", true, () => {
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        url: signed,
        downloadUrl: signed,
        expiresAt: "2099-01-01T00:00:00Z",
        filename: summary.title,
        contentType: "video/mp4",
        target: { kind: "file", id: fileId },
        sharedThreadSnapshot: true,
      });
    });
  });
  click(getButtonByName(label));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([
      new URL(canonical, "https://app.okou.ai").href,
    ]);
  });
  expect(
    screen.queryByRole("dialog", { name: "Share" }),
  ).not.toBeInTheDocument();
});

test("A catalog publication replacing its file shares the current resource", async () => {
  const replacementFileId = "00000000-0000-4000-8000-000000000724";
  let currentFileId = fileId;
  let title = summary.title;
  let audience: ArtifactVisibilityValue = "private";
  const status = (): ArtifactVisibilityResponse => {
    return {
      artifactId: summary.id,
      kind: "file",
      visibility: audience,
      ownerUrl: new URL(
        artifactReferencePath(currentFileId, title),
        "https://app.okou.ai",
      ).href,
      shareUrl: null,
      shortUrl: null,
      organization: { id: "org_test", name: "Acme" },
    };
  };
  const { menu } = await openArtifact("catalog", true, () => {
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(
        200,
        fileArtifactDetail(
          { ...summary, title },
          {
            filename: title,
            contentType: "video/mp4",
            fileId: currentFileId,
            url: canonical,
          },
        ),
      );
    });
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        url: signed,
        downloadUrl: signed,
        expiresAt: "2099-01-01T00:00:00Z",
        filename: title,
        contentType: "video/mp4",
        artifactId: summary.id,
        target: { kind: "file", id: currentFileId },
      });
    });
    context.mocks.api(
      artifactAccessContract.getVisibility,
      ({ params, respond }) => {
        return params.artifactId === summary.id
          ? respond(200, status())
          : respond(404, {
              error: {
                code: "NOT_FOUND",
                message: "Previous file is no longer owned",
              },
            });
      },
    );
    context.mocks.api(
      artifactAccessContract.updateVisibility,
      ({ params, body, respond }) => {
        if (
          params.artifactId !== summary.id ||
          currentFileId !== replacementFileId
        ) {
          return respond(403, {
            error: {
              code: "FORBIDDEN",
              message: "Previous file is no longer owned",
            },
          });
        }
        audience = body.visibility;
        return respond(200, status());
      },
    );
  });
  await userEvent.setup().keyboard("{Escape}");
  await waitFor(() => {
    expect(menu).not.toBeInTheDocument();
  });
  currentFileId = replacementFileId;
  title = "Updated field recording.mp4";
  await act(() => {
    context.mocks.ably.trigger("artifact:changed", { artifactId: summary.id });
  });
  await within(screen.getByTestId("artifact-sidebar")).findByText(title);
  await waitFor(() => {
    expect(getButtonByName("Share artifact")).toBeVisible();
  });
  click(getButtonByName("Share artifact"));
  const reopened = await screen.findByRole("dialog", { name: "Share" });
  click(permission("Anyone"));
  await screen.findByText("Access updated");
  expect(permission("Anyone")).toBeChecked();
  const clipboard = context.mocks.browser.clipboardWriteText();
  click(getButtonByName("Copy link", reopened));
  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([status().ownerUrl]);
  });
});

test("Closing a preview cancels its pending invitation and reopening reads the server outcome", async () => {
  const began = context.mocks.deferred<void>();
  const aborted = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const processed = context.mocks.deferred<void>();
  let shares: ArtifactUserShareEntry[] = [];
  const { menu } = await openArtifact("catalog", true, () => {
    context.mocks.api(artifactAccessContract.listShares, ({ respond }) => {
      return respond(200, { shares });
    });
    context.mocks.api(
      artifactAccessContract.addShare,
      async ({ request, respond }) => {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted.resolve();
          },
          { once: true },
        );
        began.resolve();
        await release.promise;
        shares = [
          { userId: account.userId, email: account.email, name: account.name },
        ];
        processed.resolve();
        return respond(200, { share: shares[0]! });
      },
    );
  });
  const invite = getButtonByName("Invite", menu);
  await fill(
    within(menu).getByRole("combobox", { name: "Share with people" }),
    "Taylor",
  );
  await screen.findByRole("option", { name: /Taylor Viewer/ });
  const user = userEvent.setup();
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => {
    expect(invite).toBeEnabled();
  });
  await user.click(invite);
  await began.promise;
  click(
    getButtonByName("Close artifact", screen.getByTestId("artifact-sidebar")),
  );
  await aborted.promise;
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
  await act(async () => {
    release.resolve();
    await processed.promise;
  });
  click(await findArtifactAction(summary.title));
  await waitFor(() => {
    expect(getButtonByName("Share artifact")).toBeVisible();
  });
  click(getButtonByName("Share artifact"));
  const reopened = await screen.findByRole("dialog", { name: "Share" });
  await within(reopened).findByText(account.email);
  expect(
    screen.queryByText("Sharing invitation processed"),
  ).not.toBeInTheDocument();
});

test("A failed file invitation releases dismissal and keeps the address available for retry", async () => {
  const began = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  const { menu } = await openArtifact("catalog", true, () => {
    context.mocks.api(artifactAccessContract.addShare, async ({ respond }) => {
      began.resolve();
      await release.promise;
      return respond(429, {
        error: {
          code: "RATE_LIMITED",
          message: "Invitation temporarily unavailable",
        },
      });
    });
  });
  const invite = getButtonByName("Invite", menu);
  const input = within(menu).getByRole("combobox", {
    name: "Share with people",
  });
  await fill(input, "Taylor");
  await screen.findByRole("option", { name: /Taylor Viewer/ });
  const user = userEvent.setup();
  await user.keyboard("{ArrowDown}{Enter}");
  await waitFor(() => {
    expect(invite).toBeEnabled();
  });
  await user.click(invite);
  await began.promise;
  await user.click(getButtonByName("Share artifact"));
  expect(menu).toBeInTheDocument();
  release.resolve();
  await screen.findByText("Invitation temporarily unavailable");
  await waitFor(() => {
    expect(invite).toBeEnabled();
  });
  expect(input).toHaveValue(account.email);
  await user.keyboard("{Escape}");
  await waitFor(() => {
    expect(menu).not.toBeInTheDocument();
  });
});

test.each(["file", "website"] as const)(
  "Closing %s Share cancels its people read and reopening shows the current list",
  async (kind) => {
    const began = context.mocks.deferred<void>();
    const aborted = context.mocks.deferred<void>();
    const released = context.mocks.deferred<void>();
    const responded = context.mocks.deferred<void>();
    let pending = true;
    const configure = () => {
      context.mocks.api(
        artifactAccessContract.listShares,
        async ({ request, respond }) => {
          if (pending) {
            request.signal.addEventListener(
              "abort",
              () => {
                aborted.resolve();
              },
              { once: true },
            );
            began.resolve();
            await released.promise;
            responded.resolve();
            return respond(403, {
              error: {
                code: "FORBIDDEN",
                message: "Closed preview people read failed",
              },
            });
          }
          return respond(200, {
            shares: [
              {
                userId: account.userId,
                email: account.email,
                name: account.name,
              },
            ],
          });
        },
      );
    };
    let menu: HTMLElement;
    if (kind === "file") {
      ({ menu } = await openArtifact("catalog", true, configure));
    } else {
      configure();
      ({ dialog: menu } = await openSharing(context, { emailSharing: true }));
    }
    await began.promise;
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => {
      expect(menu).not.toBeInTheDocument();
    });
    await aborted.promise;
    pending = false;
    await act(async () => {
      released.resolve();
      await responded.promise;
    });
    click(getButtonByName("Share artifact"));
    const reopened = await screen.findByRole("dialog", {
      name: kind === "file" ? "Share" : "Share artifact",
    });
    await expect(
      within(reopened).findByText(account.email),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Closed preview people read failed"),
    ).not.toBeInTheDocument();
  },
);

test.each(["invite", "remove"] as const)(
  "File Share keeps a pending %s visible until it completes",
  async (operation) => {
    const began = context.mocks.deferred<void>();
    const release = context.mocks.deferred<void>();
    let shares: ArtifactUserShareEntry[] =
      operation === "remove"
        ? [{ userId: account.userId, email: account.email, name: account.name }]
        : [];
    const { menu } = await openArtifact("catalog", true, () => {
      context.mocks.api(artifactAccessContract.listShares, ({ respond }) => {
        return respond(200, { shares });
      });
      context.mocks.api(
        artifactAccessContract.addShare,
        async ({ respond }) => {
          began.resolve();
          await release.promise;
          shares = [
            {
              userId: account.userId,
              email: account.email,
              name: account.name,
            },
          ];
          return respond(200, { share: shares[0]! });
        },
      );
      context.mocks.api(
        artifactAccessContract.removeShare,
        async ({ params, respond }) => {
          began.resolve();
          await release.promise;
          shares = [];
          return respond(200, { removed: params.userId });
        },
      );
    });
    const user = userEvent.setup();
    let action: HTMLElement;
    if (operation === "invite") {
      action = getButtonByName("Invite", menu);
      await fill(
        within(menu).getByRole("combobox", { name: "Share with people" }),
        account.email,
      );
      await screen.findByRole("option", { name: /Taylor Viewer/ });
      await user.keyboard("{ArrowDown}{Enter}");
    } else {
      await within(menu).findByText(account.email);
      action = getButtonByName(`Remove access for ${account.email}`, menu);
    }
    await waitFor(() => {
      expect(action).toBeEnabled();
    });
    await user.click(action);
    await began.promise;
    expect(action).toBeDisabled();
    await user.click(getButtonByName("Share artifact"));
    expect(menu).toBeInTheDocument();
    expect(action).toBeDisabled();
    release.resolve();
    await screen.findByText(
      operation === "invite"
        ? "Sharing invitation processed"
        : "Access removed",
    );
    await waitFor(() => {
      const list = within(menu).getByRole("list", {
        name: "People with access",
      });
      expect(within(list).queryByText(account.email)?.textContent ?? null).toBe(
        operation === "invite" ? account.email : null,
      );
    });
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(menu).not.toBeInTheDocument();
    });
  },
);
