import germanCopy from "../../../i18n/locales/de-DE/common.json";
import germanUrl from "../../../i18n/locales/de-DE/common.json?url";
import { HttpResponse } from "msw";
import { expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  marketingHandoffsContract,
  type MarketingHandoffManifest,
} from "@okouai/api-contracts/contracts/marketing-handoffs";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-threads";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findAction,
  getAction,
  queryAction,
} from "../../okou-page/__tests__/connector-integrations-test-helpers.ts";
const context = testContext();
const hash = "a".repeat(64);
const task = "Keep this draft. ";
async function openEditor(text: string) {
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    path: "/onboarding?" + new URLSearchParams({ prompt: text }),
  });
  return screen.findByLabelText("Onboarding prompt");
}
test("onboarding-pasted-text-005 the full pasted document travels through the handoff into the first sent message", async () => {
  const text = "abcde".repeat(5000);
  const original = "Reply with only the number 5.";
  let manifest: MarketingHandoffManifest | undefined;
  const user = userEvent.setup();
  const sent = context.mocks.deferred<{
    threadId: string;
    prompt: unknown;
    parts: unknown;
  }>();
  const uploaded = context.mocks.deferred<string>();
  const saved = context.mocks.deferred<MarketingHandoffManifest>();
  context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
    if (!uploaded.settled()) {
      uploaded.resolve(atob(body.data));
    }
    return respond(200, {
      hash,
      filename: body.filename,
      contentType: body.contentType,
      size: text.length,
    });
  });
  context.mocks.api(marketingHandoffsContract.create, ({ body, respond }) => {
    manifest = body;
    if (!saved.settled()) {
      saved.resolve(body);
    }
    return respond(200, { hash, shortHash: hash.slice(0, 12) });
  });
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    if (!manifest) {
      throw new Error("No stored handoff");
    }
    return respond(200, manifest);
  });
  context.mocks.api(marketingHandoffsContract.import, ({ respond }) => {
    if (!manifest) {
      throw new Error("No stored file");
    }
    return respond(200, {
      files: manifest.files.map((f) => {
        return {
          ...f,
          id: "f0000000-0000-4000-a000-000000000001",
          url: "https://cdn.okou.io/artifacts/onboarding/pasted.txt",
        };
      }),
    });
  });
  context.mocks.api(chatEventsContract.send, ({ body, respond }) => {
    if (!body.threadId) {
      throw new Error("Missing chat destination");
    }
    if (!sent.settled()) {
      sent.resolve({
        threadId: body.threadId,
        prompt: body.prompt,
        parts: body.userMessage?.parts,
      });
    }
    return respond(201, {
      threadId: body.threadId,
      createdAt: "2026-11-01T00:00:00Z",
    });
  });
  const editor = await openEditor(original);
  await user.click(editor);
  await user.paste(text);
  await expect(uploaded.promise).resolves.toBe(text);
  const file = await screen.findByText(/pasted.text-1\.txt/i);
  const filename = file.textContent;
  if (!filename) {
    throw new Error("Missing uploaded filename");
  }
  await waitFor(() => {
    return expect(getAction("button", "Next")).toBeEnabled();
  });
  click(getAction("button", "Next"));
  await expect(saved.promise).resolves.toMatchObject({
    prompt: original,
    files: [{ hash, filename, contentType: "text/plain", size: 25_000 }],
  });
  const submitted = await sent.promise;
  expect(submitted.prompt).toBe(original);
  expect(submitted.parts).toContainEqual(
    expect.objectContaining({
      type: "file",
      filenameSnapshot: filename,
      fileId: "f0000000-0000-4000-a000-000000000001",
    }),
  );
  await expect(screen.findByText(original)).resolves.toBeVisible();
  await expect(screen.findByText(filename)).resolves.toBeVisible();
  expect(location.pathname).toBe("/chats/" + submitted.threadId);
  expect(new URL(location.href).searchParams.has("handoff")).toBeFalsy();
});
test("onboarding-pasted-text-007 retries exactly the retained text and removes either a successful or a failed paste", async () => {
  const user = userEvent.setup();
  const text = "unsubmitted data ".repeat(900);
  let available = false;
  const retry = context.mocks.deferred<string>();
  context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
    if (!available) {
      return respond(503, {
        error: { code: "PROVIDER_UNAVAILABLE", message: "Upload unavailable" },
      });
    }
    if (!retry.settled()) {
      retry.resolve(atob(body.data));
    }
    return respond(200, {
      filename: body.filename,
      hash,
      size: text.length,
      contentType: body.contentType,
    });
  });
  const editor = await openEditor("Review the workbook.");
  await user.click(editor);
  await user.paste(text);
  await screen.findByText(/Could not upload/);
  expect(getAction("button", "Next")).toBeDisabled();
  available = true;
  click(await findAction("button", "Retry"));
  await expect(retry.promise).resolves.toBe(text);
  await waitFor(() => {
    return expect(getAction("button", "Next")).toBeEnabled();
  });
  click(getAction("button", "Remove Pasted text-1.txt"));
  expect(
    queryAction("button", "Remove Pasted text-1.txt"),
  ).not.toBeInTheDocument();
  expect(editor).toHaveValue("Review the workbook.");
  expect(getAction("button", "Next")).toBeEnabled();
  available = false;
  await user.click(editor);
  await user.paste(text);
  await screen.findByText(/Could not upload/);
  click(getAction("button", "Remove Pasted text-2.txt"));
  expect(screen.queryByText(/Could not upload/)).not.toBeInTheDocument();
  expect(
    queryAction("button", "Remove Pasted text-2.txt"),
  ).not.toBeInTheDocument();
  expect(editor).toHaveValue("Review the workbook.");
  expect(getAction("button", "Next")).toBeEnabled();
});
test("onboarding-pasted-text-008 mixed image and text clipboard keeps the oversized text inline", async () => {
  const user = userEvent.setup();
  const editor = await openEditor(task);
  await user.click(editor);
  const data = new DataTransfer();
  const content = "b".repeat(10_001);
  data.setData("text/plain", content);
  data.items.add(new File(["local pixels"], "scan.png", { type: "image/png" }));
  await user.paste(data);
  expect(editor).toHaveValue(task + content);
  expect(getAction("button", "Next")).toBeEnabled();
  expect(
    screen.queryByRole("list", { name: "Attachments" }),
  ).not.toBeInTheDocument();
});

test("onboarding-pasted-text-009 a reserved final attachment slot leaves the next paste in the editor", async () => {
  const user = userEvent.setup();
  const files = Array.from({ length: 9 }, (_, index) => {
    return {
      filename: "Reference-" + String(index) + ".txt",
      hash: index.toString(16).padStart(64, "0"),
      contentType: "text/plain",
      size: 20,
    };
  });
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    return respond(200, { version: 1, prompt: task, options: {}, files });
  });
  const held = context.mocks.deferred<void>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    marketingHandoffsContract.upload,
    async ({ body, respond }) => {
      if (!held.settled()) {
        held.resolve();
      }
      await release.promise;
      return respond(200, {
        hash,
        filename: body.filename,
        contentType: body.contentType,
        size: 10_001,
      });
    },
  );
  await setupPage({ context, path: "/onboarding?handoff=" + hash });
  const editor = await screen.findByLabelText("Onboarding prompt");
  const fallback = "Q".repeat(10_001);
  try {
    await user.click(editor);
    await user.keyboard("{End}");
    await user.paste("K".repeat(10_001));
    await held.promise;
    const remove = await findAction("button", "Remove Pasted text-1.txt");
    await user.click(editor);
    await user.keyboard("{End}");
    await user.paste(fallback);
    await expect(
      screen.findByText(/up to 10 files.*remains in the prompt/i),
    ).resolves.toBeVisible();
    expect(editor).toHaveValue(task + fallback);
    expect(getAction("button", "Next")).toBeDisabled();
    click(remove);
    await waitFor(() => {
      return expect(getAction("button", "Next")).toBeEnabled();
    });
    expect(screen.queryByText(/Pasted text-\d+\.txt/i)).not.toBeInTheDocument();
    for (const file of files) {
      expect(screen.getByText(file.filename)).toBeVisible();
    }
  } finally {
    release.resolve();
  }
});
test("onboarding-pasted-text-010 a ten-megabyte UTF-8 document uploads intact at the inclusive limit", async () => {
  const bytes = 10 * 1024 * 1024;
  const text = "é".repeat((bytes - 2) / 2) + "\nZ";
  const received = context.mocks.deferred<{
    data: string;
    contentType: string;
  }>();
  context.mocks.api(marketingHandoffsContract.upload, ({ body, respond }) => {
    if (!received.settled()) {
      received.resolve(body);
    }
    return respond(200, {
      hash,
      filename: body.filename,
      contentType: body.contentType,
      size: bytes,
    });
  });
  const user = userEvent.setup();
  const editor = await openEditor(task);
  await user.click(editor);
  await user.paste(text);
  const payload = await received.promise;
  expect(payload.contentType).toBe("text/plain");
  const content = Buffer.from(payload.data, "base64");
  expect(content.byteLength).toBe(bytes);
  expect(content.toString("utf8") === text).toBeTruthy();
  await expect(screen.findByText("Pasted text-1.txt")).resolves.toBeVisible();
  expect(editor).toHaveValue(task);
  await waitFor(() => {
    return expect(getAction("button", "Next")).toBeEnabled();
  });
});
test("onboarding-pasted-text-011 a paste one byte above the upload limit replaces the selected draft inline", async () => {
  const user = userEvent.setup();
  const editor = await openEditor(task);
  const text = "X".repeat(10 * 1024 * 1024 + 1);
  await user.click(editor);
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(text);
  await expect(
    screen.findByText(/exceeds the 10 MB limit.*remains in the prompt/i),
  ).resolves.toBeVisible();
  expect(
    editor instanceof HTMLTextAreaElement && editor.value === text,
  ).toBeTruthy();
  expect(getAction("button", "Next")).toBeDisabled();
  expect(
    screen.queryByRole("list", { name: "Attachments" }),
  ).not.toBeInTheDocument();
});
test("onboarding-pasted-text-015 preview Skip cancels the ongoing text upload and opens the composer", async () => {
  const user = userEvent.setup();
  const ingress = context.mocks.deferred<Request>();
  const release = context.mocks.deferred<void>();
  context.mocks.api(
    marketingHandoffsContract.upload,
    async ({ request, body, respond }) => {
      if (!ingress.settled()) {
        ingress.resolve(request);
      }
      await release.promise;
      return respond(200, {
        hash,
        contentType: body.contentType,
        filename: body.filename,
        size: 12_500,
      });
    },
  );
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  await setupPage({
    context,
    host: "pr-40584-app-okou-app-preview.vm0.workers.dev",
    path: "/onboarding?prompt=Prepare+a+brief",
  });
  const editor = await screen.findByLabelText("Onboarding prompt");
  await user.click(editor);
  try {
    await user.paste("W".repeat(12_500));
    const req = await ingress.promise;
    expect(req.signal.aborted).toBeFalsy();
    click(await findAction("button", "Skip"));
    await expect(
      screen.findByRole("textbox", { name: "Message" }),
    ).resolves.toBeVisible();
    await waitFor(() => {
      return expect(req.signal.aborted).toBeTruthy();
    });
    expect(
      screen.queryByLabelText("Onboarding prompt"),
    ).not.toBeInTheDocument();
    expect(location.pathname).toBe("/");
  } finally {
    release.resolve();
  }
});
test("onboarding-pasted-text-014 the German Document instruction counts against the same submitted task limit", async () => {
  const english =
    "Create a complete document with the results in the requested file format (Markdown by default). Upload it as an artifact and include the working artifact link in your final response.";
  const german =
    "Erstelle ein vollständiges Dokument mit den Ergebnissen im gewünschten Dateiformat (standardmäßig Markdown). Lade es als Artefakt hoch und füge deiner abschließenden Antwort einen funktionierenden Link zum Artefakt hinzu.";
  const initial = "x".repeat(20_000 - 2 - english.length);
  context.mocks.http.get(germanUrl, () => {
    return HttpResponse.json(germanCopy);
  });
  context.mocks.data.onboardingStatus({
    needsOnboarding: true,
    onboardingComplete: false,
  });
  context.mocks.api(marketingHandoffsContract.resolve, ({ respond }) => {
    return respond(200, {
      version: 1,
      prompt: initial,
      options: {},
      files: [],
    });
  });
  await setupPage({ context, path: "/onboarding?handoff=" + hash });
  const editor = await screen.findByLabelText("Onboarding prompt");
  await expect(
    screen.findByText(
      "20000 / 20000 characters (including output instructions)",
    ),
  ).resolves.toBeVisible();
  expect(editor).toHaveValue(initial);
  expect(getAction("button", "Document")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  click(await findAction("button", "Test User"));
  click(await screen.findByText("Settings", { exact: true }));
  click(await screen.findByRole("combobox", { name: "Language" }));
  click(await screen.findByRole("option", { name: /Deutsch/ }));
  await waitFor(() => {
    return expect(document.documentElement.lang).toBe("de-DE");
  });
  const user = userEvent.setup();
  await user.keyboard("{Escape}");
  await expect(
    screen.findByText(
      String(initial.length + 2 + german.length) +
        " / 20000 Zeichen (einschließlich Ausgabeanweisungen)",
    ),
  ).resolves.toBeVisible();
  expect(editor).toHaveValue(initial);
  expect(getAction("button", "Dokument")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await user.click(editor);
  await user.keyboard(
    "{Control>}{End}{/Control}{Backspace>" +
      String(german.length - english.length) +
      "/}",
  );
  const edited = initial.slice(0, 20_000 - 2 - german.length);
  expect(editor).toHaveValue(edited);
  expect(
    screen.getByText(
      "20000 / 20000 Zeichen (einschließlich Ausgabeanweisungen)",
    ),
  ).toBeVisible();
  const saved = context.mocks.deferred<string>();
  context.mocks.api(marketingHandoffsContract.create, ({ body, respond }) => {
    if (!saved.settled()) {
      saved.resolve(body.prompt);
    }
    const savedHash = "b".repeat(64);
    return respond(200, { hash: savedHash, shortHash: savedHash.slice(0, 12) });
  });
  click(await findAction("button", "Nächste"));
  await expect(saved.promise).resolves.toBe(edited + "\n\n" + german);
});
