import { connectorCatalogContract } from "@okouai/api-contracts/contracts/connector-catalog";
import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { builtinConnectorOauthStartContract } from "@okouai/api-contracts/contracts/connectors";
import { connectorAccountFixture } from "../../../mocks/handlers/connector-account-fixtures.ts";
import { googleDriveCatalogItem } from "./chat-navigation-artifact-test-helpers.ts";
import { artifactGoogleDriveContract } from "@okouai/api-contracts/contracts/artifact-google-drive";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { HttpResponse } from "msw";
import { screen, within, waitFor } from "@testing-library/react";
import { test, expect } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  artifactFile,
  ATTACHMENT_RUN_ID,
  ATTACHMENT_THREAD_ID,
  mockAttachmentChat,
  findNamedButton,
  findNamedMenuItem,
} from "./chat-attachment-test-helpers.ts";
import {
  promptEvent,
  assistantEvent,
  completedEvent,
} from "./chat-run-test-fixtures.ts";

const context = testContext();
const account = "7feb9e18-d255-4c2b-a6e8-6b16e8c86e35";
const artifact = "146fff03-5d26-4a88-be43-39d9c5163dec";
const path = "/chats/" + ATTACHMENT_THREAD_ID;

function installArtifactConversation(
  filename: string,
  sync: ReturnType<typeof artifactFile>["googleDriveSync"],
) {
  const file = artifactFile(filename, {
    artifactId: artifact,
    id: crypto.randomUUID(),
    ...(sync &&
    !(sync.status === "disconnected" && sync.recovery.action === "connect")
      ? { googleDriveConnectionId: account }
      : {}),
    googleDriveSync: sync,
  });
  const runId = ATTACHMENT_RUN_ID;
  mockAttachmentChat(context, {
    artifacts: [file],
    chatEvents: [
      promptEvent({ id: runId, runId, seqId: 1, text: "Inspect the delivery" }),
      assistantEvent({
        id: crypto.randomUUID(),
        runId,
        seqId: 2,
        text: "[Review the file](" + file.url + ")",
      }),
      completedEvent({ id: crypto.randomUUID(), runId, seqId: 3 }),
    ],
  });
  context.mocks.http.get(file.url, () => {
    return HttpResponse.text("Freight manifest");
  });
  return file;
}

async function preview() {
  await setupPage({
    context,
    path,
    host: "app.okou.ai",
    featureSwitches: {
      [FeatureSwitchKey.ArtifactSidebarPreview]: false,
      [FeatureSwitchKey.GoogleSlidesConversion]: true,
    },
  });
  const link = await screen.findByText("Review the file");
  click(link);
  return screen.findByRole("dialog");
}

async function options(dialog: HTMLElement) {
  click(await findNamedButton("Download options", dialog));
  return screen.findByRole("menu");
}
const slidesUrl = "https://docs.google.com/presentation/d/cargo-route/edit";
const docsUrl = "https://docs.google.com/document/d/cargo-note/edit";
const providerUrl = "https://accounts.example.test/authorize/cargo";
const noScope = {
  error: {
    code: "GOOGLE_DRIVE_SCOPE_REQUIRED",
    message: "Drive access expired. No file was uploaded.",
  },
  recovery: { action: "reconnect" as const, connectionId: account },
} as const;
const addAccount = {
  status: "disconnected" as const,
  recovery: { action: "connect" as const },
} as const;
const documentResult = {
  id: "cargo-note",
  name: "Cargo note",
  mimeType: "application/vnd.google-apps.document",
  webViewLink: docsUrl,
} as const;

function authorization(intent: "add" | "reconnect") {
  const attempt = crypto.randomUUID();
  const popup = Object.assign(context.mocks.browser.authWindow(), {
    location: { href: "about:blank" },
  });
  const browser = context.mocks.browser.open(popup);
  const completion = context.mocks.deferred<void>();
  const receipt = context.mocks.deferred<void>();
  const pendingReceipt = context.mocks.deferred<void>();
  const target = {
    kind: "builtin" as const,
    connectorSlug: "google-drive" as const,
  };
  context.mocks.api(connectorCatalogContract.get, ({ params, respond }) => {
    return params.connectorSlug === target.connectorSlug
      ? respond(200, { connector: googleDriveCatalogItem("not-connected") })
      : respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown connector" },
        });
  });
  context.mocks.api(
    builtinConnectorOauthStartContract.start,
    ({ body, params, respond }) => {
      return params.connectorSlug === target.connectorSlug &&
        body.account.intent === intent &&
        (body.account.intent !== "reconnect" ||
          body.account.connectionId === account)
        ? respond(200, {
            authorizationUrl: providerUrl,
            oauthAttemptId: attempt,
          })
        : respond(400, {
            error: {
              code: "BAD_REQUEST",
              message: "Incorrect Drive account intent",
            },
          });
    },
  );
  context.mocks.api(
    connectorAccountsContract.oauthCompletion,
    async ({ params, respond }) => {
      pendingReceipt.resolve();
      await completion.promise;
      receipt.resolve();
      return params.attemptId === attempt
        ? respond(200, { connectionId: account })
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Unknown authorization" },
          });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      return params.connectionId === account
        ? respond(200, connectorAccountFixture(target, { id: account }))
        : respond(404, {
            error: { code: "NOT_FOUND", message: "Unknown account" },
          });
    },
  );
  return {
    popup,
    complete: () => {
      return completion.resolve();
    },
    waitingForAuthorization: pendingReceipt.promise,
    receiptReturned: receipt.promise,
    browser,
  };
}

async function choose(dialog: HTMLElement, name: string) {
  const menu = await options(dialog);
  const item = await findNamedMenuItem(name, menu);
  await waitFor(() => {
    expect(item).not.toHaveAttribute("aria-disabled", "true");
  });
  click(item);
}

function googleNoteUpload() {
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ body, params, respond }) => {
      return params.artifactId === artifact &&
        body.chatThreadId === ATTACHMENT_THREAD_ID &&
        body.connectionId === account &&
        body.mode === "google"
        ? respond(200, documentResult)
        : respond(400, {
            error: { code: "BAD_REQUEST", message: "Incorrect Docs target" },
          });
    },
  );
}

test("chat-navigation-artifact-drive-003 syncing without an editor URL yields a plain confirmation", async () => {
  const file = installArtifactConversation("receipt.bin", {
    status: "not_synced",
  });
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ params, body, respond }) => {
      return params.artifactId === artifact &&
        body.chatThreadId === ATTACHMENT_THREAD_ID &&
        body.connectionId === account &&
        body.mode === "original"
        ? respond(200, {
            id: "remote-receipt",
            name: file.filename,
            webViewLink: null,
          })
        : respond(400, {
            error: {
              code: "BAD_REQUEST",
              message: "Wrong receipt destination",
            },
          });
    },
  );
  const menu = await options(await preview());
  click(await findNamedMenuItem("Upload to Google Drive", menu));
  const success = await screen.findByText("Synced to Google Drive");
  const toast = success.closest<HTMLElement>("[data-sonner-toast]")!;
  expect(toast).toBeInTheDocument();
  expect(within(toast).queryByText("View it")).toBeNull();
});

test("chat-navigation-artifact-drive-005 a file without Drive metadata still downloads", async () => {
  const file = installArtifactConversation("receipt.bin", undefined);
  const browser = context.mocks.browser.blobDownload();
  const menu = await options(await preview());
  const disabled = await findNamedMenuItem("Connect Google Drive", menu);
  expect(disabled).toHaveAttribute("aria-disabled", "true");
  click(await findNamedMenuItem("Download", menu));
  await waitFor(() => {
    expect(browser.downloads.at(-1)).toMatchObject({
      filename: file.filename,
      url: file.url,
    });
  });
});

test("chat-navigation-artifact-drive-008 scope recovery restores the explicit Docs action before conversion", async () => {
  installArtifactConversation("route-notes.txt", { status: "not_synced" });
  const auth = authorization("reconnect");
  let permitted = false;
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ body, respond }) => {
      return !permitted
        ? respond(403, noScope)
        : body.connectionId === account && body.mode === "google"
          ? respond(200, documentResult)
          : respond(400, {
              error: {
                code: "BAD_REQUEST",
                message: "Wrong conversion account",
              },
            });
    },
  );
  const dialog = await preview();
  await choose(dialog, "Upload to Google Docs");
  await screen.findByText(/No file was uploaded/);
  expect(
    auth.browser.calls.map((opened) => {
      return opened.url;
    }),
  ).toStrictEqual([]);
  await choose(dialog, "Reconnect Google Drive");
  await waitFor(() => {
    expect(auth.popup.location.href).toBe(providerUrl);
  });
  permitted = true;
  auth.complete();
  const menu = await options(dialog);
  const retry = await findNamedMenuItem("Upload to Google Docs", menu);
  await waitFor(() => {
    expect(retry).not.toHaveAttribute("aria-disabled", "true");
  });
  expect(within(menu).queryByText("Open in Google Docs")).toBeNull();
  expect(screen.queryByText("Synced to Google Drive")).toBeNull();
  click(retry);
  await screen.findByText("Synced to Google Drive");
  await expect(
    findNamedMenuItem("Open in Google Docs", await options(dialog)),
  ).resolves.toHaveAttribute("href", docsUrl);
});

test("chat-navigation-artifact-drive-009 recovering the original upload preserves the imported document", async () => {
  installArtifactConversation("original.txt", {
    status: "synced",
    ...documentResult,
  });
  const auth = authorization("reconnect");
  let granted = false;
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ body, respond }) => {
      return !granted
        ? respond(403, noScope)
        : body.connectionId === account && body.mode === "original"
          ? respond(200, {
              id: "source-note",
              name: "original.txt",
              webViewLink: null,
            })
          : respond(400, {
              error: { code: "BAD_REQUEST", message: "Wrong original upload" },
            });
    },
  );
  const dialog = await preview();
  const initial = await options(dialog);
  await expect(
    findNamedMenuItem("Open in Google Docs", initial),
  ).resolves.toHaveAttribute("href", docsUrl);
  click(await findNamedMenuItem("Upload to Google Drive", initial));
  await screen.findByText(/No file was uploaded/);
  const recovery = await options(dialog);
  await expect(
    findNamedMenuItem("Open in Google Docs", recovery),
  ).resolves.toHaveAttribute("href", docsUrl);
  const reconnect = await findNamedMenuItem("Reconnect Google Drive", recovery);
  expect(within(recovery).getAllByText("Reconnect Google Drive")).toHaveLength(
    1,
  );
  click(reconnect);
  await waitFor(() => {
    expect(auth.popup.location.href).toBe(providerUrl);
  });
  granted = true;
  auth.complete();
  const restored = await options(dialog);
  await expect(
    findNamedMenuItem("Open in Google Docs", restored),
  ).resolves.toHaveAttribute("href", docsUrl);
  click(await findNamedMenuItem("Upload to Google Drive", restored));
  await screen.findByText("Synced to Google Drive");
  await expect(
    findNamedMenuItem("Open in Google Docs", await options(dialog)),
  ).resolves.toHaveAttribute("href", docsUrl);
});

test("chat-navigation-artifact-drive-010 a dismissed recovery cannot finish the abandoned upload", async () => {
  installArtifactConversation("scope-note.txt", { status: "not_synced" });
  const auth = authorization("reconnect");
  let repaired = false;
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ respond }) => {
      return repaired ? respond(200, documentResult) : respond(403, noScope);
    },
  );
  const dialog = await preview();
  await choose(dialog, "Upload to Google Docs");
  await screen.findByText(/No file was uploaded/);
  await choose(dialog, "Reconnect Google Drive");
  await waitFor(() => {
    expect(auth.popup.location.href).toBe(providerUrl);
  });
  await auth.waitingForAuthorization;
  click(await findNamedButton("Close", dialog));
  await waitFor(() => {
    expect(auth.popup.closed).toBeTruthy();
  });
  repaired = true;
  auth.complete();
  await auth.receiptReturned;
  expect(screen.queryByRole("dialog")).toBeNull();
  click(await screen.findByText("Review the file"));
  const menu = await options(await screen.findByRole("dialog"));
  await expect(
    findNamedMenuItem("Reconnect Google Drive", menu),
  ).resolves.toBeInTheDocument();
  expect(within(menu).queryByText("Open in Google Docs")).toBeNull();
  expect(screen.queryByText("Synced to Google Drive")).toBeNull();
});

test("chat-navigation-artifact-drive-014 the authorized preview supports saving and downloading its original", async () => {
  const file = installArtifactConversation("package.bin", addAccount);
  const auth = authorization("add");
  const browser = context.mocks.browser.blobDownload();
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ body, respond }) => {
      return body.connectionId === account && body.mode === "original"
        ? respond(200, {
            id: "package",
            name: file.filename,
            webViewLink: null,
          })
        : respond(403, {
            error: {
              code: "FORBIDDEN",
              message: "Unexpected Drive destination",
            },
          });
    },
  );
  const dialog = await preview();
  await choose(dialog, "Connect Google Drive");
  await waitFor(() => {
    expect(auth.popup.location.href).toBe(providerUrl);
  });
  auth.complete();
  await screen.findByText("Synced to Google Drive");
  const menu = await options(dialog);
  await expect(
    findNamedMenuItem("Upload to Google Drive", menu),
  ).resolves.not.toHaveAttribute("aria-disabled", "true");
  click(await findNamedMenuItem("Download", menu));
  await waitFor(() => {
    expect(browser.downloads.at(-1)?.filename).toBe(file.filename);
  });
  expect(browser.downloads.at(-1)?.url).toBe(file.url);
});

test("chat-navigation-artifact-drive-016 a rejected original cannot replace the Slides editor", async () => {
  installArtifactConversation("routing.pptx", { status: "not_synced" });
  context.mocks.api(
    artifactGoogleDriveContract.uploadFromChat,
    ({ body, respond }) => {
      return body.mode === "google"
        ? respond(200, {
            id: "route-slides",
            name: "Routing slides",
            mimeType: "application/vnd.google-apps.presentation",
            webViewLink: slidesUrl,
          })
        : respond(403, {
            error: { code: "FORBIDDEN", message: "Original deck rejected" },
          });
    },
  );
  const dialog = await preview();
  await choose(dialog, "Upload to Google Slides");
  await screen.findByText("Synced to Google Drive");
  await choose(dialog, "Upload to Google Drive");
  await screen.findByText(/Original deck rejected/);
  const menu = await options(dialog);
  await expect(
    findNamedMenuItem("Open in Google Slides", menu),
  ).resolves.toHaveAttribute("href", slidesUrl);
  expect(within(menu).queryByText("Upload to Google Slides")).toBeNull();
});

test("chat-navigation-artifact-drive-021 authorizing conversion replaces the Docs upload with its editor", async () => {
  installArtifactConversation("routing.txt", addAccount);
  const auth = authorization("add");
  googleNoteUpload();
  const dialog = await preview();
  await choose(dialog, "Upload to Google Docs");
  await waitFor(() => {
    expect(auth.popup.location.href).toBe(providerUrl);
  });
  auth.complete();
  await screen.findByText("Synced to Google Drive");
  const menu = await options(dialog);
  await expect(
    findNamedMenuItem("Open in Google Docs", menu),
  ).resolves.toHaveAttribute("href", docsUrl);
  expect(within(menu).queryByText("Upload to Google Docs")).toBeNull();
});
