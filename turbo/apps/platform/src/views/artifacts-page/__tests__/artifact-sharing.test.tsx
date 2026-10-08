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
import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
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
beforeEach(() => {
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact unavailable" },
    });
  });
});
function queryAction(role: "button" | "menuitem" | "radio", name: string) {
  return queryAllByRoleFast(role).find((element) => {
    return (
      element.getAttribute("aria-label") === name ||
      element.textContent?.trim() === name
    );
  });
}
function action(
  role: "button" | "menuitem" | "radio",
  name: string,
): HTMLElement {
  const element = queryAction(role, name);
  if (!element) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return element;
}

function permission(label: "Only me" | "Organization" | "Public access") {
  // Each row now states its audience in one line, so the label the row carries
  // is no longer the audience's short name.
  const rows = {
    "Only me": "Only me",
    Organization: "Anyone at Acme",
    "Public access": "Anyone with the link",
  };
  return action("radio", rows[label]);
}

const deploymentId = "00000000-0000-4000-8000-000000000009";
const shareId = "00000000-0000-4000-8000-000000000010";
const canonical = artifactReferencePath(deploymentId, "index.html");
const organizationUrl = `https://app.okou.ai${artifactReferencePath(shareId, "index.html")}`;
const publicUrl = `https://${"b".repeat(24)}.okou.app/`;

async function openArtifact({ enabled = true }: { enabled?: boolean } = {}) {
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
    return respond(200, {
      url: `https://pv-${"a".repeat(48)}.okou.app/`,
      expiresAt: "2099-01-01T00:00:00Z",
      filename: "index.html",
      contentType: "text/html",
      target: { kind: "html", id: deploymentId },
    });
  });
  await setupPage({
    context,
    path: "/artifacts",
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: enabled },
  });
  click(await findArtifactAction("Private report"));
  await screen.findByTestId("artifact-dialog-site-frame");
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
        ? publicUrl
        : audience === "organization"
          ? organizationUrl
          : null,
  };
}
async function openShareMenu() {
  await waitFor(() => {
    return expect(queryAction("button", "Share")).toBeDefined();
  });
  click(action("button", "Share"));
  await waitFor(() => {
    expect(permission("Only me")).toBeInTheDocument();
  });
}

test("owners can change three access levels separately from copying the stable app link", async () => {
  let status = sharingStatus();
  const changes: string[] = [];
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
    changes.push(body.audience);
    status = sharingStatus(body.audience);
    return respond(200, status);
  });
  await openArtifact();
  await openShareMenu();
  expect(
    queryAllByRoleFast("radio").map((element) => {
      return element.textContent;
    }),
  ).toStrictEqual(["Only me", "Anyone at Acme", "Anyone with the link"]);
  expect(permission("Only me")).toHaveAttribute("aria-checked", "true");
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([]);
  for (const [audience, name] of [
    ["organization", "Organization"],
    ["public", "Public access"],
    ["private", "Only me"],
  ] as const) {
    click(permission(name));
    await waitFor(() => {
      return expect(permission(name)).toHaveAttribute("aria-checked", "true");
    });
    await waitFor(() => {
      return expect(permission(name)).toHaveAttribute("aria-busy", "false");
    });
    expect(clipboard.writes).toHaveLength(changes.length - 1);
    await waitFor(() => {
      return expect(action("button", "Copy link")).not.toBeDisabled();
    });
    click(action("button", "Copy link"));
    await waitFor(() => {
      return expect(clipboard.writes).toHaveLength(changes.length);
    });
    expect(changes.at(-1)).toBe(audience);
  }
  expect(clipboard.writes).toStrictEqual(
    Array.from({ length: 3 }, () => {
      return new URL(canonical, location.origin).href;
    }),
  );
  expect(changes).toStrictEqual(["organization", "public", "private"]);
});

test("a recipient's share button copies directly without a permissions menu or mutation", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
  await openArtifact();
  click(action("button", "Share"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([
      new URL(canonical, location.origin).href,
    ]);
  });
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  expect(screen.queryByText("Copy link")).not.toBeInTheDocument();
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
});

test("owner copying uses the canonical version reference returned by the API", async () => {
  const ownerUrl = "https://app.okou.ai/artifacts/a1b2c3d4e5.html";
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, {
      ...sharingStatus("organization"),
      ownerUrl,
      shortUrl: organizationUrl,
    });
  });
  await openArtifact();
  await openShareMenu();
  click(action("button", "Copy link"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([ownerUrl]);
  });
});

test("failed permission saves retain the current audience", async () => {
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, sharingStatus("organization"));
  });
  context.mocks.api(artifactSharesContract.update, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to save sharing",
      },
    });
  });
  await openArtifact();
  await openShareMenu();
  click(permission("Only me"));
  await screen.findByText("Unable to save sharing");
  expect(screen.queryByText("Access updated")).not.toBeInTheDocument();
  await waitFor(() => {
    return expect(permission("Organization")).not.toBeDisabled();
  });
  expect(permission("Organization")).toHaveAttribute("aria-checked", "true");
});

test("status errors do not treat an owner as a recipient", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(500, {
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Permissions unavailable",
      },
    });
  });
  await openArtifact();
  click(action("button", "Share"));
  await screen.findByText("Unable to load permissions");
  await waitFor(() => {
    return expect(action("button", "Share")).not.toBeDisabled();
  });
  expect(clipboard.writes).toStrictEqual([]);
  // The audience is unknown, not absent. The choices stay on screen so the
  // menu keeps its shape and shows what Retry will restore, but none of them
  // may claim to be the current one.
  const choices = screen.getByRole("radiogroup");
  const options = queryAllByRoleFast("radio", choices);
  expect(options).toHaveLength(3);
  for (const option of options) {
    expect(option).toBeDisabled();
    expect(option).toHaveAttribute("aria-checked", "false");
  }
  // The organization is named by the permission read that just failed, so the
  // row falls back to wording that does not invent one.
  expect(
    within(choices).getByText("Anyone in your organization"),
  ).toBeInTheDocument();
  expect(within(choices).queryByText(/Acme/u)).not.toBeInTheDocument();
});

test("the shared rollout switch keeps the private share menu hidden", async () => {
  await openArtifact({ enabled: false });
  expect(queryAction("button", "Share")).toBeUndefined();
});

test("an authorized link preserves its fragment and navigates straight to isolated content", async () => {
  const path = artifactReferencePath(shareId, "index.html");
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
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: false },
  });
  await waitFor(() => {
    return expect(redirect).toHaveBeenCalledWith(`${temporary}#slide-2`);
  });
  // The background identity bridge can exist without loading a document.
  // Artifact handoff must navigate instead of embedding any content.
  expect(document.querySelector("iframe[src], iframe[srcdoc]")).toBeNull();
});

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
    screen.getByRole("heading", { name: "You can’t view this artifact" }),
  ).toBeInTheDocument();
  expect(document.querySelector("iframe[src], iframe[srcdoc]")).toBeNull();
});

test("sign-in treats an artifact query as part of the same-origin return URL", async () => {
  const redirect = vi
    .spyOn(window.location, "assign")
    .mockImplementation(() => {});
  const path = `${artifactReferencePath(shareId, "index.html")}?redirect_url=https://attacker.example#slide-2`;
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    auth: null,
  });
  expect(
    screen.getByRole("heading", { name: "You can’t view this artifact" }),
  ).toBeInTheDocument();
  expect(redirect).not.toHaveBeenCalled();
  click(action("button", "Sign in"));
  await waitFor(() => {
    return expect(redirect).toHaveBeenCalledWith(expect.any(String));
  });
  const destination = new URL(String(redirect.mock.calls[0]?.[0]));
  expect(destination.pathname).toBe("/sign-in");
  expect(destination.origin).toBe("https://app.okou.ai");
  expect(
    new URLSearchParams(destination.hash.slice("#/?".length)).get(
      "redirect_url",
    ),
  ).toBe(`https://app.okou.ai${path}`);
});
