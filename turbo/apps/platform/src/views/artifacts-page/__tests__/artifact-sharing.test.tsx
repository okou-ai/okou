import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
const deploymentId = "00000000-0000-4000-8000-000000000009";
const shareId = "00000000-0000-4000-8000-000000000010";
const canonical = artifactReferencePath(deploymentId, "index.html");

function queryAction(role: "button" | "radio", name: string) {
  return queryAllByRoleFast(role, document.body).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
}

function action(role: "button" | "radio", name: string): HTMLElement {
  const element = queryAction(role, name);
  if (!element) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return element;
}

function sharingStatus(
  audience: ArtifactShareStatus["audience"] = "private",
): ArtifactShareStatus {
  return {
    ownerUrl: new URL(canonical, "http://localhost").href,
    shortUrl: null,
    shareId: audience === "private" ? null : shareId,
    audience,
    organization: { id: "org_test", name: "Acme" },
    selectedTarget:
      audience === "private" ? null : { kind: "html", id: deploymentId },
    selectedVersion: audience === "private" ? null : 2,
    candidateVersion: 2,
    url:
      audience === "public"
        ? `https://${"b".repeat(24)}.okou.app/`
        : audience === "organization"
          ? `https://app.okou.ai${artifactReferencePath(shareId, "index.html")}`
          : null,
  };
}

async function openShareMenu(selected = "Only me") {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ kind: "hosted-site", title: "Private report" })],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({ kind: "hosted-site", title: "Private report" }),
      kind: "hosted-site",
      site: {
        id: "00000000-0000-4000-8000-000000000008",
        slug: "private-report",
        publicSlug: "private-report",
        url: canonical,
        deploymentVersion: 2,
        entrypoint: "/index.html",
        spaFallback: true,
      },
    });
  });
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    const url = `https://pv-${"a".repeat(48)}.okou.app/`;
    return respond(200, {
      downloadUrl: new URL("?download=1", url).href,
      url,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "index.html",
      contentType: "text/html",
      target: { kind: "html", id: deploymentId },
    });
  });
  await setupPage({ context, path: "/artifacts" });
  click(await findArtifactAction("Private report"));
  await screen.findByTestId("artifact-dialog-site-frame");
  await waitFor(() => {
    expect(action("button", "Share")).toBeEnabled();
  });
  click(action("button", "Share"));
  await waitFor(() => {
    expect(action("radio", selected)).toHaveAttribute("aria-checked", "true");
  });
}

test("The owner's share menu describes each audience for a private artifact", async () => {
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, sharingStatus());
  });

  await openShareMenu();

  expect(
    queryAllByRoleFast("radio", document.body).map((element) => {
      return [
        element.getAttribute("aria-label"),
        element.getAttribute("aria-description"),
      ];
    }),
  ).toStrictEqual([
    ["Only me", "Only you can open it"],
    ["Anyone at Acme", "Teammates can view"],
    ["Anyone with the link", "No sign-in needed"],
  ]);
  expect(action("button", "Copy link")).toBeEnabled();
});

test("The owner changes three access levels and copies the same app link after each", async () => {
  let statusReads = 0;
  const changes: string[] = [];
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    statusReads += 1;
    return respond(200, sharingStatus());
  });
  context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
    changes.push(body.audience);
    return respond(200, sharingStatus(body.audience));
  });

  await openShareMenu();
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();

  for (const name of ["Anyone at Acme", "Anyone with the link", "Only me"]) {
    click(action("radio", name));
    await waitFor(() => {
      expect(action("radio", name)).toHaveAttribute("aria-checked", "true");
    });
    await waitFor(() => {
      expect(action("button", "Copy link")).toBeEnabled();
    });
    click(action("button", "Copy link"));
    await waitFor(() => {
      expect(clipboard.writes).toHaveLength(changes.length);
    });
  }

  expect(changes).toStrictEqual(["organization", "public", "private"]);
  const appLink = new URL(canonical, window.location.origin).href;
  expect(clipboard.writes).toStrictEqual([appLink, appLink, appLink]);
  expect(statusReads).toBe(1);
});

test("The owner copies the canonical link returned by the API instead of its short link", async () => {
  const ownerUrl = "https://app.okou.ai/artifacts/a1b2c3d4e5.html";
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, {
      ...sharingStatus("organization"),
      ownerUrl,
      shortUrl: `https://app.okou.ai${artifactReferencePath(shareId, "index.html")}`,
    });
  });

  await openShareMenu("Anyone at Acme");
  click(action("button", "Copy link"));

  await waitFor(() => {
    expect(clipboard.writes).toStrictEqual([ownerUrl]);
  });
});

test("Sign-in keeps an artifact's redirect query as part of its same-origin return URL", async () => {
  const navigation = context.mocks.browser.locationAssign();
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  const path = `${artifactReferencePath(shareId, "index.html")}?redirect_url=https://attacker.example#slide-2`;

  await setupPage({ context, path, host: "app.okou.ai", auth: null });

  await expect(
    screen.findByRole("heading", { name: "You can’t view this artifact" }),
  ).resolves.toBeInTheDocument();
  expect(navigation.calls).toHaveLength(0);
  click(action("button", "Sign in"));
  await waitFor(() => {
    expect(navigation.calls).toHaveLength(1);
  });
  const destination = new URL(navigation.calls[0] ?? "", window.location.href);
  expect(destination.origin).toBe("https://app.okou.ai");
  expect(destination.pathname).toBe("/sign-in");
  expect(
    new URLSearchParams(destination.hash.slice("#/?".length)).get(
      "redirect_url",
    ),
  ).toBe(`https://app.okou.ai${path}`);
});
