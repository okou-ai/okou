import { hostContract } from "@okouai/api-contracts/contracts/host";
import {
  artifactReferencePath,
  artifactReferencesContract,
} from "@okouai/api-contracts/contracts/artifact-references";
import { chatArtifactCatalogChangedEvent } from "@okouai/api-contracts/contracts/artifact-catalog";
import { act, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactRun,
  artifactSummary,
  buttonNamed,
  mockArtifactConversation,
  NAVIGATION_ARTIFACT_RUN_ID,
  NAVIGATION_ARTIFACT_THREAD_ID,
  openResourceArtifact,
  roleItemNamed,
} from "./chat-navigation-artifact-test-helpers.ts";

const context = testContext();
const ARTIFACT_ID = "e0000000-0000-4000-a000-000000000950";
const SITE_ID = "e0000000-0000-4000-a000-000000000951";
const FILE_ID = "e0000000-0000-4000-a000-000000000952";
const TITLE = "Release report";
const FILENAME = "release-report.html";
const TOPIC = chatArtifactCatalogChangedEvent(NAVIGATION_ARTIFACT_THREAD_ID);

function previewUrl(version: number) {
  return `https://pv-release-v${version}.okou.app/`;
}

async function setupPublication(
  source: "site" | "reference" | "snapshot" | "deployment",
  resolveUrl: (version: number) => string | Promise<string> = previewUrl,
) {
  let version = 1;
  const canonicalUrl =
    source === "site"
      ? "https://release-report.okou.app/"
      : source === "deployment"
        ? `https://dpl-${FILE_ID}.okou.app/`
        : artifactReferencePath(FILE_ID, FILENAME);
  const summary = artifactSummary(ARTIFACT_ID, "hosted-site", TITLE);
  context.mocks.browser.matchMedia(true);
  mockArtifactConversation(context, {
    catalog: [summary],
    getDetail: () => {
      if (source === "reference" || source === "snapshot") {
        return {
          ...summary,
          kind: "file",
          file: {
            id: FILE_ID,
            filename: FILENAME,
            contentType: "text/html",
            size: 128,
            url: canonicalUrl,
            previewImageUrl: null,
          },
        };
      }
      return {
        ...summary,
        kind: "hosted-site",
        site: {
          id: SITE_ID,
          slug: "release-report",
          publicSlug: "release-report",
          url: canonicalUrl,
          deploymentVersion: version,
          entrypoint: "index.html",
          spaFallback: false,
        },
      };
    },
    artifactRuns: () => {
      return [
        artifactRun({
          artifactId: ARTIFACT_ID,
          filename: FILENAME,
          fileId: FILE_ID,
          contentType: "text/html",
          url: canonicalUrl,
        }),
      ];
    },
    chatEvents: [
      {
        id: "release-report-message",
        createdAt: "2026-09-01T12:00:00.000Z",
        role: "assistant",
        content: `![${FILENAME}](${canonicalUrl})`,
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        seqId: 1,
      },
      {
        id: "release-report-completed",
        createdAt: "2026-09-01T12:00:01.000Z",
        role: "assistant",
        content: null,
        runId: NAVIGATION_ARTIFACT_RUN_ID,
        runLifecycleEvent: "completed",
        seqId: 2,
      },
    ],
  });
  context.mocks.api(hostContract.sitePreview, async ({ params, respond }) => {
    const resolvedVersion = params.publicSlug.startsWith("dpl-") ? 1 : version;
    return respond(200, {
      url: await resolveUrl(resolvedVersion),
      expiresAt: "2099-01-01T00:00:00.000Z",
    });
  });
  context.mocks.api(artifactReferencesContract.resolve, async ({ respond }) => {
    const url = await resolveUrl(source === "snapshot" ? 1 : version);
    return respond(200, {
      url,
      downloadUrl: new URL("?download=1", url).href,
      expiresAt: "2099-01-01T00:00:00.000Z",
      filename: FILENAME,
      contentType: "text/html",
      target: { kind: "file", id: FILE_ID },
      ...(source === "snapshot" ? { sharedThreadSnapshot: true as const } : {}),
    });
  });
  await setupPage({
    context,
    path: `/chats/${NAVIGATION_ARTIFACT_THREAD_ID}`,
    host: "app.okou.ai",
  });
  await waitFor(() => {
    expect(context.mocks.ably.hasSubscription(TOPIC)).toBeTruthy();
  });
  return {
    publish: async (
      nextVersion: number,
      delivery: "catalog" | "artifact" = "catalog",
    ) => {
      version = nextVersion;
      await act(() => {
        context.mocks.ably.trigger(
          delivery === "catalog" ? TOPIC : "artifact:changed",
          { artifactId: ARTIFACT_ID },
        );
      });
    },
  };
}

async function openPreview(entry: "message" | "catalog") {
  if (entry === "catalog") {
    await openResourceArtifact(TITLE);
  } else {
    click(await screen.findByLabelText(`Open html preview for ${FILENAME}`));
  }
  return await screen.findByTestId("artifact-sidebar");
}

async function expectVersion(expected: number) {
  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
      "src",
      previewUrl(expected),
    );
  });
}

async function closePreview(entry: "message" | "catalog") {
  const sidebar = screen.getByTestId("artifact-sidebar");
  if (entry === "catalog") {
    click(buttonNamed("More artifact actions", sidebar));
    const menu = await screen.findByRole("menu");
    click(roleItemNamed("menuitem", "Close preview menu", menu));
  } else {
    click(buttonNamed("Close artifact", sidebar));
  }
  await waitFor(() => {
    expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
  });
}

test.each([
  { entry: "message", source: "site", delivery: "catalog" },
  { entry: "catalog", source: "site", delivery: "catalog" },
  { entry: "message", source: "reference", delivery: "catalog" },
  { entry: "message", source: "reference", delivery: "artifact" },
  { entry: "catalog", source: "site", delivery: "artifact" },
] as const)(
  "The $entry sidebar follows $source updates from $delivery notifications while open and after reopening",
  async ({ entry, source, delivery }) => {
    const publication = await setupPublication(source);
    await openPreview(entry);
    await expectVersion(1);
    await closePreview(entry);
    await openPreview(entry);
    await expectVersion(1);

    await publication.publish(2, delivery);
    await expectVersion(2);
    await closePreview(entry);
    await openPreview(entry);
    await expectVersion(2);

    await closePreview(entry);
    await publication.publish(3, delivery);
    await openPreview(entry);
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        previewUrl(3),
      );
    });
  },
);

test.each(["snapshot", "deployment"] as const)(
  "A published update preserves the version of an immutable %s link",
  async (source) => {
    const publication = await setupPublication(source);
    await openPreview("message");
    await expectVersion(1);
    await publication.publish(2);
    await closePreview("message");
    await openPreview("message");
    await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
        "src",
        previewUrl(1),
      );
    });
  },
);

test("A late v1 preview response preserves the published v2 sidebar", async () => {
  const started = context.mocks.deferred<void>();
  const release = context.mocks.deferred<string>();
  const returned = context.mocks.deferred<void>();
  const publication = await setupPublication("site", async (version) => {
    if (version !== 1) {
      return previewUrl(version);
    }
    started.resolve();
    const url = await release.promise;
    returned.resolve();
    return url;
  });
  await openPreview("message");
  await started.promise;
  await publication.publish(2);
  await expectVersion(2);
  await act(async () => {
    release.resolve(previewUrl(1));
    await returned.promise;
  });
  await closePreview("message");
  await openPreview("message");
  await waitFor(() => {
    expect(screen.getByTestId("artifact-sidebar-body-html")).toHaveAttribute(
      "src",
      previewUrl(2),
    );
  });
});
