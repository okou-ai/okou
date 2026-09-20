import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { hostContract } from "@okouai/api-contracts/contracts/host";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { screen, waitFor, within } from "@testing-library/react";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";

import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifact,
  findArtifactAction,
  getButtonByName,
  setupArtifactCatalogPage,
} from "./artifact-catalog-test-helpers.ts";

const context = testContext();

test("An avatar card and reopened viewer share one private video URL", async () => {
  const fileId = "f0000000-0000-4000-a000-000000000004";
  const canonicalUrl = artifactReferencePath(fileId, "avatar-video.mp4");
  const firstUrl = "https://private.example/avatar-video.mp4?signature=first";
  const nextUrl = "https://private.example/avatar-video.mp4?signature=next";
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          kind: "avatar",
          title: "avatar-video.mp4",
          videoSourceUrl: canonicalUrl,
        }),
      ],
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({
        kind: "avatar",
        title: "avatar-video.mp4",
        videoSourceUrl: canonicalUrl,
      }),
      kind: "avatar",
      file: {
        id: fileId,
        filename: "avatar-video.mp4",
        contentType: "video/mp4",
        size: 4096,
        url: canonicalUrl,
        previewImageUrl: null,
      },
      model: "joggai-talking-avatar",
      durationSeconds: 12,
    });
  });
  let resolveCount = 0;
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    const url = resolveCount === 0 ? firstUrl : nextUrl;
    resolveCount += 1;
    return respond(200, {
      url,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: "avatar-video.mp4",
      contentType: "video/mp4",
      target: { kind: "file", id: fileId },
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=avatar" });

  const avatar = await findArtifactAction("avatar-video.mp4");
  await expect(
    within(avatar).findByTestId("artifact-catalog-video-source"),
  ).resolves.toHaveAttribute("src", `${firstUrl}#t=0.001`);
  click(avatar);
  await expect(
    screen.findByLabelText("Video preview for avatar-video.mp4"),
  ).resolves.toHaveAttribute("src", firstUrl);

  click(getButtonByName("Close"));
  await waitFor(() => {
    expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
  });
  click(avatar);
  await expect(
    screen.findByLabelText("Video preview for avatar-video.mp4"),
  ).resolves.toHaveAttribute("src", firstUrl);
});

test("A stale catalog open cannot replace a newer preview", async () => {
  const firstArtifactId = "a0000000-0000-4000-a000-000000000021";
  const firstFileId = "f0000000-0000-4000-a000-000000000021";
  const secondArtifactId = "a0000000-0000-4000-a000-000000000022";
  const secondFileId = "f0000000-0000-4000-a000-000000000022";
  const firstCanonicalUrl = artifactReferencePath(
    firstFileId,
    "first-private.png",
  );
  const secondCanonicalUrl = artifactReferencePath(
    secondFileId,
    "second-private.png",
  );
  const secondPreviewUrl =
    "https://private.example/second-private.png?signature=latest";
  const firstRequestStarted = context.mocks.deferred<void>();
  const releaseFirstRequest = context.mocks.deferred<void>();
  const firstResponseReturned = context.mocks.deferred<void>();

  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [
        artifact({
          id: firstArtifactId,
          kind: "image",
          title: "first-private.png",
        }),
        artifact({
          id: secondArtifactId,
          kind: "image",
          title: "second-private.png",
        }),
      ],
      nextCursor: null,
    });
  });
  context.mocks.api(
    artifactCatalogContract.get,
    async ({ params, respond }) => {
      const first = params.artifactId === firstArtifactId;
      if (first) {
        firstRequestStarted.resolve();
        await releaseFirstRequest.promise;
        firstResponseReturned.resolve();
      }
      return respond(200, {
        ...artifact({
          id: params.artifactId,
          kind: "image",
          title: first ? "first-private.png" : "second-private.png",
        }),
        kind: "image",
        file: {
          id: first ? firstFileId : secondFileId,
          filename: first ? "first-private.png" : "second-private.png",
          contentType: "image/png",
          size: 4096,
          url: first ? firstCanonicalUrl : secondCanonicalUrl,
          previewImageUrl: null,
        },
        model: "gpt-image-2",
        provider: "built-in",
      });
    },
  );
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const second = secondCanonicalUrl.endsWith(params.reference);
      return respond(200, {
        url: second
          ? secondPreviewUrl
          : "https://private.example/first-private.png?signature=stale",
        expiresAt: "2099-01-01T00:00:00.000Z",
        filename: second ? "second-private.png" : "first-private.png",
        contentType: "image/png",
        target: {
          kind: "file",
          id: second ? secondFileId : firstFileId,
        },
      });
    },
  );

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=image" });

  click(await findArtifactAction("first-private.png"));
  await firstRequestStarted.promise;
  click(await findArtifactAction("second-private.png"));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", secondPreviewUrl);

  releaseFirstRequest.resolve();
  await firstResponseReturned.promise;
  await waitFor(() => {
    expect(screen.getByTestId("attachment-lightbox-image")).toHaveAttribute(
      "src",
      secondPreviewUrl,
    );
  });
});

test("Catalog previews remain stable after opening another artifact", async () => {
  const artifacts = [
    {
      artifactId: "a0000000-0000-4000-a000-000000000011",
      fileId: "f0000000-0000-4000-a000-000000000011",
      filename: "first-private.png",
      firstUrl: "https://private.example/first-private.png?signature=first",
      nextUrl: "https://private.example/first-private.png?signature=next",
    },
    {
      artifactId: "a0000000-0000-4000-a000-000000000012",
      fileId: "f0000000-0000-4000-a000-000000000012",
      filename: "second-private.png",
      firstUrl: "https://private.example/second-private.png?signature=first",
      nextUrl: "https://private.example/second-private.png?signature=next",
    },
  ].map((entry) => {
    return {
      ...entry,
      canonicalUrl: artifactReferencePath(entry.fileId, entry.filename),
    };
  });
  const resolveCounts = new Map<string, number>();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: artifacts.map((entry) => {
        return artifact({
          id: entry.artifactId,
          kind: "image",
          title: entry.filename,
        });
      }),
      nextCursor: null,
    });
  });
  context.mocks.api(artifactCatalogContract.get, ({ params, respond }) => {
    const entry = artifacts.find((candidate) => {
      return candidate.artifactId === params.artifactId;
    });
    if (!entry) {
      throw new Error("Unexpected catalog artifact");
    }
    return respond(200, {
      ...artifact({
        id: entry.artifactId,
        kind: "image",
        title: entry.filename,
      }),
      kind: "image",
      file: {
        id: entry.fileId,
        filename: entry.filename,
        contentType: "image/png",
        size: 4096,
        url: entry.canonicalUrl,
        previewImageUrl: null,
      },
      model: "gpt-image-2",
      provider: "built-in",
    });
  });
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const entry = artifacts.find((candidate) => {
        return candidate.canonicalUrl.endsWith(params.reference);
      });
      if (!entry) {
        throw new Error("Unexpected artifact reference");
      }
      const count = resolveCounts.get(entry.fileId) ?? 0;
      resolveCounts.set(entry.fileId, count + 1);
      return respond(200, {
        url: count === 0 ? entry.firstUrl : entry.nextUrl,
        expiresAt: "2099-01-01T00:00:00.000Z",
        filename: entry.filename,
        contentType: "image/png",
        target: { kind: "file", id: entry.fileId },
      });
    },
  );

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=image" });

  for (const entry of artifacts) {
    click(await findArtifactAction(entry.filename));
    await expect(
      screen.findByTestId("attachment-lightbox-image"),
    ).resolves.toHaveAttribute("src", entry.firstUrl);
    click(getButtonByName("Close"));
    await waitFor(() => {
      expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
    });
  }

  click(await findArtifactAction(artifacts[0]!.filename));
  await expect(
    screen.findByTestId("attachment-lightbox-image"),
  ).resolves.toHaveAttribute("src", artifacts[0]!.firstUrl);
});

test("Opening an unpreviewable binary downloads it with the correct filename", async () => {
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ title: "release-bundle.zip" })],
      nextCursor: null,
    });
  });
  context.mocks.http.get(
    "https://artifacts.example.com/release-bundle.zip",
    () => {
      return HttpResponse.text("archive bytes", {
        headers: { "Content-Type": "application/zip" },
      });
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({ title: "release-bundle.zip" }),
      kind: "file",
      file: {
        id: "f0000000-0000-4000-a000-000000000002",
        filename: "release-bundle.zip",
        contentType: "application/zip",
        size: 2048,
        url: "https://artifacts.example.com/release-bundle.zip",
        previewImageUrl: null,
      },
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  const archive = await findArtifactAction("release-bundle.zip");
  click(archive);

  await waitFor(() => {
    expect(browser.downloads).toHaveLength(1);
  });
  expect(browser.downloads[0]).toMatchObject({
    filename: "release-bundle.zip",
    url: "https://artifacts.example.com/release-bundle.zip",
  });
});

test("Opening a text artifact shows its content on demand", async () => {
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, {
      artifacts: [artifact({ title: "launch-plan.txt" })],
      nextCursor: null,
    });
  });
  context.mocks.http.get(
    "https://artifacts.example.com/launch-plan.txt",
    () => {
      return HttpResponse.text("launch plan");
    },
  );
  context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
    return respond(200, {
      ...artifact({ title: "launch-plan.txt" }),
      kind: "file",
      file: {
        id: "f0000000-0000-4000-a000-000000000001",
        filename: "launch-plan.txt",
        contentType: "text/plain",
        size: 1024,
        url: "https://artifacts.example.com/launch-plan.txt",
        previewImageUrl: null,
      },
    });
  });

  await setupArtifactCatalogPage(context, { path: "/artifacts?tab=file" });

  const textArtifact = await findArtifactAction("launch-plan.txt");
  expect(screen.queryByText("launch plan")).not.toBeInTheDocument();
  click(textArtifact);

  await expect(screen.findByText("launch plan")).resolves.toBeInTheDocument();
});

test.each(["hosted-site", "presentation"] as const)(
  "Opening a private %s uses an authorized isolated origin",
  async (kind) => {
    const canonical =
      "http://localhost/api/host/private-deployments/00000000-0000-4000-8000-000000000009/view";
    const preview = `https://pv-${"a".repeat(48)}.sites.vm7.io/`;
    const renewedPreview = `https://pv-${"b".repeat(48)}.sites.vm7.io/`;
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, {
        artifacts: [artifact({ kind, title: "Private report" })],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        ...artifact({ kind, title: "Private report" }),
        kind,
        site: {
          id: "00000000-0000-4000-8000-000000000008",
          slug: "private-report",
          publicSlug: "private-report",
          url: canonical,
          deploymentVersion: 1,
          entrypoint: "/index.html",
          spaFallback: false,
        },
      });
    });
    let resolveCount = 0;
    context.mocks.api(hostContract.privatePreview, ({ respond }) => {
      const url = resolveCount === 0 ? preview : renewedPreview;
      resolveCount += 1;
      return respond(200, {
        url,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    });
    await setupArtifactCatalogPage(context);
    const artifactCard = await findArtifactAction("Private report");
    click(artifactCard);
    await waitFor(() => {
      const view = screen.getByTestId("artifact-dialog-site-frame");
      const frame =
        view instanceof HTMLIFrameElement ? view : view.querySelector("iframe");
      expect(frame).toHaveAttribute("src", preview);
    });

    click(getButtonByName("Close"));
    await waitFor(() => {
      expect(screen.queryByTestId("attachment-lightbox")).toBeNull();
    });
    click(artifactCard);
    await waitFor(() => {
      const view = screen.getByTestId("artifact-dialog-site-frame");
      const frame =
        view instanceof HTMLIFrameElement ? view : view.querySelector("iframe");
      expect(frame).toHaveAttribute("src", preview);
    });
  },
);
