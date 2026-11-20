import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import {
  sharedThreadsContract,
  type SharedMessage,
} from "@okouai/api-contracts/contracts/shared-threads";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();
const host = "app.okou.ai";
function snapshot(extension: string, fragment = "") {
  return `https://${host}/artifacts/coastal023.${extension}${fragment}`;
}
function bytes(extension: string) {
  return `https://media.example.test/archive/coast.${extension}?grant=temporary`;
}
function conversation(messages: SharedMessage[]) {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, sharedThread({ title: "Coastal survey", messages }));
  });
}

test("shared-thread-private-artifacts-001 opens snapshot media while preserving the author's linked message", async () => {
  const mime = new Map([
    ["png", "image/png"],
    ["html", "text/html"],
    ["mp4", "video/mp4"],
    ["mp3", "audio/mpeg"],
    ["pdf", "application/pdf"],
  ]);
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      const [reference, extension = ""] = params.reference.split(".");
      const contentType = mime.get(extension);
      if (reference !== "coastal023" || !contentType) {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "Unknown format" },
        });
      }
      return respond(200, {
        url: bytes(extension),
        downloadUrl: bytes(extension) + "&attachment=1",
        filename: "coast." + extension,
        contentType,
        expiresAt: "2099-01-01T00:00:00Z",
        target: {
          kind: extension === "html" ? "html" : "file",
          id: "40000000-0000-4000-9000-000000000023",
        },
        sharedThreadSnapshot: true,
      });
    },
  );
  const content = [
    `![Tide line](${snapshot("png", "#detail")})`,
    `![Survey slides](${snapshot("html", "#slide-3")})`,
    `![Field video](${snapshot("mp4")})`,
    `![Field recording](${snapshot("mp3")})`,
    `![Survey report](${snapshot("pdf", "#page=2")})`,
    `[Download image](${snapshot("png", "#detail")})`,
  ].join("\n\n");
  conversation([{ role: "assistant", messageIndex: 0, content }]);
  const clipboard = context.mocks.browser.clipboardWriteText();
  await setupSharedThreadPage(context, { host });
  const image = await screen.findByAltText("Tide line");
  expect(image).toHaveAttribute("src", bytes("png") + "#detail");
  expect(image.closest("a")).toHaveAttribute(
    "href",
    snapshot("png", "#detail"),
  );
  const slides = await screen.findByTitle("Survey slides preview");
  expect(slides).toHaveAttribute("src", bytes("html") + "#slide-3");
  expect(slides.closest("a")).toHaveAttribute(
    "href",
    snapshot("html", "#slide-3"),
  );
  expect(getLinkByName("Download image")).toHaveAttribute(
    "href",
    snapshot("png", "#detail"),
  );
  const film = await screen.findByLabelText("Preview Field video");
  await waitFor(() => {
    expect(film.querySelector("video")).toHaveAttribute(
      "src",
      bytes("mp4") + "#t=0.001",
    );
  });
  for (const [label, ext, fragment, selector] of [
    ["Field recording", "mp3", "", "audio"],
    ["Survey report", "pdf", "#page=2", "iframe"],
  ] as const) {
    const cardTitle = screen.getByText(label);
    expect(cardTitle.closest("a")).toHaveAttribute(
      "href",
      snapshot(ext, fragment),
    );
    click(cardTitle);
    const dialog = await screen.findByRole("dialog", { name: label });
    await waitFor(() => {
      expect(dialog.querySelector(selector)).toHaveAttribute(
        "src",
        bytes(ext) + fragment,
      );
    });
    click(within(dialog).getByLabelText("Close"));
    await waitFor(() => {
      expect(dialog).not.toBeInTheDocument();
    });
  }
  click(screen.getByLabelText("Copy message"));
  await waitFor(() => {
    expect(clipboard.writes).toContain(content);
  });
});

test("shared-thread-private-artifacts-003 renders three denied resources without embedding their reference URLs", async () => {
  const html = snapshot("html", "#slide-3");
  const photo = snapshot("png", "#detail");
  const attachment = snapshot("jpeg");
  conversation([
    {
      role: "user",
      messageIndex: 0,
      content: "Survey evidence",
      attachments: [
        {
          filename: "survey-mark.jpeg",
          contentType: "image/jpeg",
          size: 1024,
          url: attachment,
        },
      ],
    },
    {
      role: "assistant",
      messageIndex: 1,
      content: `![Tide line](${photo})\n\n![Survey slides](${html})`,
    },
  ]);
  const denials = [photo, html, attachment].map((url) => {
    return {
      reference: new URL(url).pathname.split("/").pop(),
      response: context.mocks.deferred<void>(),
    };
  });
  context.mocks.api(
    artifactReferencesContract.resolve,
    async ({ params, respond }) => {
      const denial = denials.find(({ reference }) => {
        return reference === params.reference;
      });
      if (!denial) {
        throw new Error("Unexpected shared reference: " + params.reference);
      }
      await denial.response.promise;
      return respond(403, {
        error: { code: "FORBIDDEN", message: "Snapshot access denied" },
      });
    },
  );
  await setupSharedThreadPage(context, { host });
  for (const [index, denial] of denials.entries()) {
    denial.response.resolve();
    await waitFor(() => {
      const unavailable = screen.getAllByRole("status").filter((element) => {
        return (
          element.textContent?.trim() === "You can’t view this artifact" ||
          element.getAttribute("aria-label") === "You can’t view this artifact"
        );
      });
      expect(unavailable).toHaveLength(index + 1);
    });
  }
  expect(screen.queryByAltText("Tide line")).not.toBeInTheDocument();
  expect(screen.queryByAltText("survey-mark.jpeg")).not.toBeInTheDocument();
  expect(screen.queryByTitle("Survey slides preview")).not.toBeInTheDocument();
  expect(document.querySelector("iframe")).toBeNull();
  expect(getLinkByName("survey-mark.jpeg")).toHaveAttribute("href", attachment);
  expect(document.querySelector(`a[href="${html}"]`)).toBeInTheDocument();
  for (const stable of [photo, html, attachment]) {
    expect(document.querySelector(`[src="${stable}"]`)).toBeNull();
  }
});
