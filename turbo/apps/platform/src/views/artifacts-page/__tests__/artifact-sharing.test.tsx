import {
  artifactReferencesContract,
  artifactReferencePath,
} from "@okouai/api-contracts/contracts/artifact-references";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  artifactSharesContract,
  type ArtifactShareStatus,
} from "@okouai/api-contracts/contracts/artifact-shares";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import {
  click,
  setupPage,
  startPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();
function queryAction(role: "button" | "menuitem", name: string) {
  return queryAllByRoleFast(role).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
}
function action(role: "button" | "menuitem", name: string): HTMLElement {
  const element = queryAction(role, name);
  if (!element) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return element;
}

const deploymentId = "00000000-0000-4000-8000-000000000009";
const shareId = "00000000-0000-4000-8000-000000000010";
const canonical = artifactReferencePath(deploymentId, "index.html");
const organizationUrl = `https://app.okou.ai${artifactReferencePath(shareId, "index.html")}`;
const publicUrl = `https://${"b".repeat(24)}.okou.app/`;

async function openArtifact(enabled = true) {
  const resolutions: string[] = [];
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
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      resolutions.push(params.reference);
      return respond(200, {
        url: `https://pv-${"a".repeat(48)}.okou.app/`,
        expiresAt: "2099-01-01T00:00:00Z",
        filename: "index.html",
        contentType: "text/html",
        target: { kind: "html", id: deploymentId },
      });
    },
  );
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: enabled },
  });
  click(await findArtifactAction("Private report"));
  await screen.findByTestId("artifact-dialog-site-frame");
  return resolutions;
}

async function openShareMenu() {
  await waitFor(() => {
    return expect(queryAction("button", "Share")).toBeDefined();
  });
  click(action("button", "Share"));
  await waitFor(() => {
    return expect(
      action("menuitem", "Share to organization"),
    ).not.toHaveAttribute("aria-disabled", "true");
  });
}

test("the two share actions create and copy links, then only copy the existing audience", async () => {
  let status: ArtifactShareStatus = {
    shareId: null,
    audience: "private",
    organization: { id: "original-org", name: "Original organization" },
    selectedTarget: null,
    selectedVersion: null,
    candidateVersion: 2,
    url: null,
  };
  const changes: string[] = [];
  let reads = 0;
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    reads++;
    return respond(200, status);
  });
  context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
    expect(body.target).toStrictEqual({ kind: "html", id: deploymentId });
    changes.push(body.audience);
    status = {
      ...status,
      shareId,
      audience: body.audience,
      selectedTarget: body.target,
      selectedVersion: 2,
      url:
        body.audience === "organization"
          ? organizationUrl
          : body.audience === "public"
            ? publicUrl
            : null,
    };
    return respond(200, status);
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  const resolutions = await openArtifact();
  expect(reads).toBe(0);
  await openShareMenu();
  expect(changes).toStrictEqual([]);
  expect(clipboard.writes).toStrictEqual([]);
  expect(
    queryAllByRoleFast("menuitem").map((element) => {
      return element.textContent?.trim();
    }),
  ).toStrictEqual(["Share to organization", "Share to Public"]);
  expect(screen.queryByText("Original organization")).not.toBeInTheDocument();
  click(action("menuitem", "Share to organization"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([organizationUrl]);
  });
  expect(changes).toStrictEqual(["organization"]);
  await openShareMenu();
  const beforeCopy = resolutions.length;
  click(action("menuitem", "Share to organization"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([
      organizationUrl,
      organizationUrl,
    ]);
  });
  expect(changes).toStrictEqual(["organization"]);
  expect(resolutions).toHaveLength(beforeCopy);
  await openShareMenu();
  click(action("menuitem", "Share to Public"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([
      organizationUrl,
      organizationUrl,
      publicUrl,
    ]);
  });
  expect(changes).toStrictEqual(["organization", "public"]);
  await openShareMenu();
  click(action("menuitem", "Share to Public"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([
      organizationUrl,
      organizationUrl,
      publicUrl,
      publicUrl,
    ]);
  });
  expect(changes).toStrictEqual(["organization", "public"]);
});

test("sharing a newer HTML version publishes that version before copying its link", async () => {
  const publications: string[] = [];
  const status: ArtifactShareStatus = {
    shareId,
    audience: "public",
    organization: { id: "original-org", name: "Original organization" },
    selectedTarget: {
      kind: "html",
      id: "00000000-0000-4000-8000-000000000011",
    },
    selectedVersion: 1,
    candidateVersion: 2,
    url: publicUrl,
  };
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
    expect(body).toStrictEqual({
      target: { kind: "html", id: deploymentId },
      audience: "public",
    });
    publications.push(body.target.id);
    return respond(200, {
      ...status,
      selectedTarget: body.target,
      selectedVersion: 2,
    });
  });
  const clipboard = context.mocks.browser.clipboardWriteText();
  await openArtifact();
  await openShareMenu();
  click(action("menuitem", "Share to Public"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([publicUrl]);
  });
  expect(publications).toStrictEqual([deploymentId]);
});

test("the shared rollout switch keeps the private share menu hidden", async () => {
  await openArtifact(false);
  expect(queryAction("button", "Share")).toBeUndefined();
  expect(queryAction("menuitem", "Share to Public")).toBeUndefined();
});

test.each([
  artifactReferencePath(shareId, "index.html"),
  `/share/artifacts/${shareId}`,
])(
  "an authorized link preserves its fragment and navigates straight to isolated content: %s",
  async (path) => {
    const redirect = vi
      .spyOn(window.location, "replace")
      .mockImplementation(() => {});
    const temporary = `https://ps-${"c".repeat(48)}.okou.app/`;
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(200, {
        url: temporary,
        expiresAt: "2099-01-01T00:00:00Z",
        filename: "index.html",
        contentType: "text/html",
        target: { kind: "html", id: deploymentId },
      });
    });
    await startPage({
      context,
      path: `${path}#slide-2`,
      host: "app.okou.ai",
    });
    await waitFor(() => {
      return expect(redirect).toHaveBeenCalledWith(`${temporary}#slide-2`);
    });
    // The background identity bridge can exist without loading a document.
    // Artifact handoff must navigate instead of embedding any content.
    expect(document.querySelector("iframe[src], iframe[srcdoc]")).toBeNull();
  },
);

test("denied links display no artifact metadata or content", async () => {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  await setupPage({
    context,
    path: artifactReferencePath(shareId, "index.html"),
    host: "app.okou.ai",
  });
  expect(
    screen.getByText("This artifact is unavailable or you do not have access."),
  ).toBeInTheDocument();
  expect(document.querySelector("iframe[src], iframe[srcdoc]")).toBeNull();
});

test("logged-out recipients use the existing login with a same-origin artifact return URL", async () => {
  const redirect = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  let resolves = 0;
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    resolves++;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
  await startPage({
    context,
    path: `${artifactReferencePath(shareId, "index.html")}?redirect_url=https://attacker.example#slide-2`,
    host: "app.okou.ai",
    auth: null,
  });
  await waitFor(() => {
    return expect(redirect).toHaveBeenCalledWith(expect.any(String));
  });
  const destination = String(redirect.mock.calls[0]?.[0]);
  expect(destination).toContain("sign-in");
  expect(decodeURIComponent(destination)).toContain(
    `${artifactReferencePath(shareId, "index.html")}#slide-2`,
  );
  expect(destination).not.toContain("attacker.example");
  expect(resolves).toBe(0);
});
