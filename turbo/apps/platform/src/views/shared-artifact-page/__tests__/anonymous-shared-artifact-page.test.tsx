import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { screen, waitFor } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test, vi } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();
const artifactId = "00000000-0000-4000-8000-000000000011";
const imagePath = artifactReferencePath(artifactId, "launch.png");
const publicImageUrl = "https://public.okou.app/launch-preview.png";
const filename = "Launch overview.png";

function action(role: "button" | "link" | "menuitem", name: string) {
  const element = queryAllByRoleFast(role).find((candidate) => {
    return (
      candidate.getAttribute("aria-label") === name ||
      candidate.textContent?.trim() === name
    );
  });
  if (!element) {
    throw new Error(`Missing ${role}: ${name}`);
  }
  return element;
}

function publicImage() {
  context.mocks.api(
    artifactReferencesContract.publicUrl,
    ({ request, respond }) => {
      expect(request.headers.get("authorization")).toBeNull();
      return respond(200, {
        url: publicImageUrl,
        preview: { filename, contentType: "image/png" },
      });
    },
  );
}

test("a signed-out recipient can preview, copy, and download a public image inside the app", async () => {
  const clipboard = context.mocks.browser.clipboardWriteText();
  const browser = context.mocks.browser.blobDownload();
  const assign = context.mocks.browser.locationAssign();
  const replace = context.mocks.browser.locationReplace();
  const path = `${imagePath}?source=shared#detail`;
  publicImage();
  context.mocks.http.get(publicImageUrl, () => {
    return HttpResponse.text("public image bytes", {
      headers: { "Content-Type": "image/png" },
    });
  });
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    auth: null,
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: true },
  });

  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", `${publicImageUrl}#detail`);
  expect(screen.getByRole("heading", { name: filename })).toBeInTheDocument();
  expect(document.title).toBe(`${filename} | Okou`);
  expect(window.location.href).toBe(`https://app.okou.ai${path}`);
  expect(assign.calls).toStrictEqual([]);
  expect(replace.calls).toStrictEqual([]);
  expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();

  click(action("button", "Share"));
  await expect(screen.findByText("Link copied")).resolves.toBeInTheDocument();
  expect(clipboard.writes).toStrictEqual([`https://app.okou.ai${path}`]);
  expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();

  click(action("button", "Download options"));
  await waitFor(() => {
    expect(action("menuitem", "Download")).toBeInTheDocument();
  });
  click(action("menuitem", "Download"));
  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]?.filename).toBe(filename);
  await expect(browser.downloads[0]?.blob?.text()).resolves.toBe(
    "public image bytes",
  );
  expect(window.location.href).toBe(`https://app.okou.ai${path}`);
  expect(assign.calls).toStrictEqual([]);
  expect(replace.calls).toStrictEqual([]);
});

test("a signed-out legacy HTML link previews its requested slide on the isolated public origin", async () => {
  const publicUrl = "https://launch-plan.okou.app/";
  const path = `/share/artifacts/${artifactId}?source=legacy#slide-2`;
  const replace = context.mocks.browser.locationReplace();
  context.mocks.api(
    artifactReferencesContract.publicUrl,
    ({ params, request, respond }) => {
      expect(params.reference).toBe(
        artifactReferencePath(artifactId).slice("/artifacts/".length),
      );
      expect(request.headers.get("authorization")).toBeNull();
      return respond(200, {
        url: publicUrl,
        preview: { filename: "index.html", contentType: "text/html" },
      });
    },
  );
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    auth: null,
    featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: true },
  });

  const frame = await screen.findByTitle("index.html preview");
  expect(frame).toHaveAttribute("src", `${publicUrl}#slide-2`);
  expect(frame).toHaveAttribute("sandbox", "allow-same-origin allow-scripts");
  expect(frame).toHaveAttribute("referrerpolicy", "origin");
  expect(window.location.href).toBe(`https://app.okou.ai${path}`);
  expect(replace.calls).toStrictEqual([]);
});

test.each([imagePath, `/share/artifacts/${artifactId}`])(
  "an unavailable anonymous artifact stays in the viewer and signs in only on request: %s",
  async (referencePath) => {
    const path = `${referencePath}?source=shared#detail`;
    const artifactUrl = `https://app.okou.ai${path}`;
    const assign = context.mocks.browser.locationAssign();
    const replace = context.mocks.browser.locationReplace();
    const reload = vi
      .spyOn(window.location, "reload")
      .mockImplementation(() => {});
    context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
      return respond(404, {
        error: { code: "NOT_FOUND", message: "Artifact unavailable" },
      });
    });
    await setupPage({ context, path, host: "app.okou.ai", auth: null });

    expect(
      screen.getByRole("heading", { name: "You can’t view this artifact" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Artifacts" }),
    ).toBeInTheDocument();
    expect(document.title).toBe("Artifacts | Okou");
    expect(screen.queryByText(filename)).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("attachment-lightbox-image"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("main").querySelector("iframe")).toBeNull();
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
    expect(action("button", "Sign in")).toBeEnabled();
    expect(action("button", "Try again")).toBeEnabled();
    expect(action("link", "Back to Okou")).toHaveAttribute("href", "/");
    expect(window.location.href).toBe(artifactUrl);
    expect(assign.calls).toStrictEqual([]);
    expect(replace.calls).toStrictEqual([]);

    click(action("button", "Try again"));
    expect(reload).toHaveBeenCalledExactlyOnceWith();
    expect(window.location.href).toBe(artifactUrl);

    click(action("button", "Sign in"));
    await waitFor(() => {
      expect(assign.calls).toHaveLength(1);
    });
    const signInUrl = new URL(assign.calls[0] ?? "");
    expect(signInUrl.origin).toBe("https://app.okou.ai");
    expect(signInUrl.pathname).toBe("/sign-in");
    expect(
      new URLSearchParams(signInUrl.hash.slice("#/?".length)).get(
        "redirect_url",
      ),
    ).toBe(artifactUrl);
  },
);

test.each([401, 403, 404] as const)(
  "an authenticated recipient with resolution status %s can preview a public artifact inside the app",
  async (status) => {
    const assign = context.mocks.browser.locationAssign();
    const replace = context.mocks.browser.locationReplace();
    publicImage();
    context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
      return respond(status, {
        error: { code: "NOT_FOUND", message: "Artifact unavailable" },
      });
    });
    await setupPage({
      context,
      path: imagePath,
      host: "app.okou.ai",
      featureSwitches: { [FeatureSwitchKey.PrivateArtifacts]: true },
    });

    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute("src", publicImageUrl);
    expect(screen.getByRole("heading", { name: filename })).toBeInTheDocument();
    expect(screen.queryByTestId("clerk-sign-in")).not.toBeInTheDocument();
    expect(window.location.href).toBe(`https://app.okou.ai${imagePath}`);
    expect(assign.calls).toStrictEqual([]);
    expect(replace.calls).toStrictEqual([]);
  },
);
