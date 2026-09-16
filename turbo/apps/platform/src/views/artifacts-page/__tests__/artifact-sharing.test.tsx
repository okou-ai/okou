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
    ownerUrl: new URL(canonical, location.origin).href,
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
  await screen.findByRole("radio", { name: /Only me/ });
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
    screen.getAllByRole("radio").map((element) => {
      return element.textContent;
    }),
  ).toStrictEqual([
    "Only meOnly you can view this artifact",
    "OrganizationAnyone in Acme with the link",
    "Public accessAnyone with the link can view",
  ]);
  expect(screen.getByRole("radio", { name: /Only me/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([]);
  for (const [audience, name] of [
    ["organization", /Organization/],
    ["public", /Public access/],
    ["private", /Only me/],
  ] as const) {
    click(screen.getByRole("radio", { name }));
    await waitFor(() => {
      return expect(screen.getByRole("radio", { name })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
    await waitFor(() => {
      return expect(screen.getByRole("radio", { name })).toHaveAttribute(
        "aria-busy",
        "false",
      );
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

test("copying Only me does not create a share", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, sharingStatus());
  });
  await openArtifact();
  await openShareMenu();
  click(action("button", "Copy link"));
  await waitFor(() => {
    return expect(clipboard.writes).toStrictEqual([
      new URL(canonical, location.origin).href,
    ]);
  });
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

test("an owner clipboard failure shows an error without changing access or claiming success", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(
    new DOMException("Clipboard denied", "NotAllowedError"),
  );
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, sharingStatus("organization"));
  });
  await openArtifact();
  await openShareMenu();
  click(action("button", "Copy link"));
  await expect(
    screen.findByText("Failed to copy link"),
  ).resolves.toBeInTheDocument();
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  expect(screen.queryByText("Access updated")).not.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Organization/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("failed permission saves retain the current audience and can be retried", async () => {
  let status = sharingStatus("organization");
  let fail = true;
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(artifactSharesContract.update, ({ body, respond }) => {
    if (fail) {
      return respond(500, {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: "Unable to save sharing",
        },
      });
    }
    status = sharingStatus(body.audience);
    return respond(200, status);
  });
  await openArtifact();
  await openShareMenu();
  click(screen.getByRole("radio", { name: /Only me/ }));
  await screen.findByText("Unable to save sharing");
  expect(screen.queryByText("Access updated")).not.toBeInTheDocument();
  await waitFor(() => {
    return expect(
      screen.getByRole("radio", { name: /Organization/ }),
    ).not.toBeDisabled();
  });
  expect(screen.getByRole("radio", { name: /Organization/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  fail = false;
  click(screen.getByRole("radio", { name: /Only me/ }));
  await waitFor(() => {
    return expect(
      screen.getByRole("radio", { name: /Only me/ }),
    ).toHaveAttribute("aria-checked", "true");
  });
});

test("permissions prefetch on lightbox open and pending reads use an in-menu skeleton", async () => {
  const initial = context.mocks.deferred<ArtifactShareStatus>();
  let reads = 0;
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, async ({ respond }) => {
    reads++;
    return respond(200, await initial.promise);
  });
  await openArtifact();
  await waitFor(() => {
    return expect(reads).toBe(1);
  });
  expect(
    screen.queryByRole("status", { name: "Loading permissions" }),
  ).not.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([]);
  click(action("button", "Share"));
  await expect(
    screen.findByRole("status", { name: "Loading permissions" }),
  ).resolves.toBeInTheDocument();
  expect(action("button", "Share")).not.toBeDisabled();
  expect(action("button", "Share")).not.toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  initial.resolve(sharingStatus());
  await screen.findByRole("radio", { name: /Only me/ });
  expect(reads).toBe(1);
  expect(
    screen.queryByRole("status", { name: "Loading permissions" }),
  ).not.toBeInTheDocument();
  click(action("button", "Copy link"));
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
});

test("closing a pending share cancels copying and reopening reuses the prefetched permissions", async () => {
  const initial = context.mocks.deferred<void>();
  let reads = 0;
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, async ({ respond }) => {
    reads++;
    await initial.promise;
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Artifact not found" },
    });
  });
  await openArtifact();
  click(action("button", "Share"));
  await screen.findByRole("status", { name: "Loading permissions" });
  const menu = screen.getByRole("dialog", { name: "Share" });
  const close = queryAllByRoleFast("button", menu).find((button) => {
    return button.getAttribute("aria-label") === "Close";
  });
  if (!close) {
    throw new Error("Missing menu close action");
  }
  click(close);
  await waitFor(() => {
    return expect(
      screen.queryByRole("dialog", { name: "Share" }),
    ).not.toBeInTheDocument();
  });
  initial.resolve();
  // Opening again explicitly copies; the cancelled click must not also copy.
  click(action("button", "Share"));
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([
    new URL(canonical, location.origin).href,
  ]);
  expect(reads).toBe(1);
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
});

test("saving marks only the selected choice and reports success after the write", async () => {
  const saved = context.mocks.deferred<ArtifactShareStatus>();
  let status = sharingStatus();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(artifactSharesContract.update, async ({ respond }) => {
    status = await saved.promise;
    return respond(200, status);
  });
  await openArtifact();
  await openShareMenu();
  click(screen.getByRole("radio", { name: /Public access/ }));
  await waitFor(() => {
    return expect(
      screen.getByRole("radio", { name: /Public access/ }),
    ).toHaveAttribute("aria-busy", "true");
  });
  expect(screen.getByRole("radio", { name: /Public access/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  for (const choice of screen.getAllByRole("radio")) {
    expect(choice).not.toBeDisabled();
  }
  expect(action("button", "Copy link")).not.toBeDisabled();
  for (const close of queryAllByRoleFast("button").filter((button) => {
    return button.getAttribute("aria-label") === "Close";
  })) {
    expect(close).not.toBeDisabled();
  }
  expect(screen.queryByText("Access updated")).not.toBeInTheDocument();
  expect(screen.queryByText("Link copied")).not.toBeInTheDocument();
  saved.resolve(sharingStatus("public"));
  await expect(
    screen.findByText("Access updated"),
  ).resolves.toBeInTheDocument();
  expect(screen.getByRole("radio", { name: /Public access/ })).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("rapid permission changes serialize writes and preserve the latest selection", async () => {
  const first = context.mocks.deferred<void>();
  const second = context.mocks.deferred<void>();
  let status = sharingStatus();
  const writes: string[] = [];
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return respond(200, status);
  });
  context.mocks.api(
    artifactSharesContract.update,
    async ({ body, respond }) => {
      writes.push(body.audience);
      await (writes.length === 1 ? first.promise : second.promise);
      status = sharingStatus(body.audience);
      return respond(200, status);
    },
  );
  await openArtifact();
  await openShareMenu();
  click(screen.getByRole("radio", { name: /Public access/ }));
  await waitFor(() => {
    return expect(writes).toStrictEqual(["public"]);
  });
  click(screen.getByRole("radio", { name: /Organization/ }));
  click(screen.getByRole("radio", { name: /Only me/ }));
  await waitFor(() => {
    return expect(
      screen.getByRole("radio", { name: /Only me/ }),
    ).toHaveAttribute("aria-busy", "true");
  });
  expect(writes).toStrictEqual(["public"]);
  first.resolve();
  await waitFor(() => {
    return expect(writes).toStrictEqual(["public", "private"]);
  });
  expect(screen.getByRole("radio", { name: /Only me/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(screen.queryByText("Access updated")).not.toBeInTheDocument();
  second.resolve();
  await expect(
    screen.findByText("Access updated"),
  ).resolves.toBeInTheDocument();
  expect(status.audience).toBe("private");
  expect(screen.getByRole("radio", { name: /Only me/ })).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("status errors do not treat an owner as a recipient, and the action can be retried", async () => {
  let fail = true;
  const clipboard = context.mocks.browser.clipboardWriteText();
  context.mocks.api(artifactSharesContract.status, ({ respond }) => {
    return fail
      ? respond(500, {
          error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Permissions unavailable",
          },
        })
      : respond(200, sharingStatus());
  });
  await openArtifact();
  click(action("button", "Share"));
  await screen.findByText("Unable to load permissions");
  await waitFor(() => {
    return expect(action("button", "Share")).not.toBeDisabled();
  });
  expect(clipboard.writes).toStrictEqual([]);
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  fail = false;
  click(action("button", "Retry"));
  await expect(
    screen.findByRole("radio", { name: /Only me/ }),
  ).resolves.toBeInTheDocument();
});

test("the shared rollout switch keeps the private share menu hidden", async () => {
  await openArtifact(false);
  expect(queryAction("button", "Share")).toBeUndefined();
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
      featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: false },
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
    screen.getByRole("heading", { name: "You can’t view this artifact" }),
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

test("public canonical links open without login and retain their fragment", async () => {
  const redirect = vi
    .spyOn(window.location, "replace")
    .mockImplementation(() => {});
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(200, { url: publicUrl });
  });
  await startPage({
    context,
    path: `${canonical}#slide-2`,
    host: "app.okou.ai",
    auth: null,
  });
  await waitFor(() => {
    return expect(redirect).toHaveBeenCalledWith(`${publicUrl}#slide-2`);
  });
});
