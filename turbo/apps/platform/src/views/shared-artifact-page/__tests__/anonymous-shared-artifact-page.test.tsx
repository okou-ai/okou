import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findNamedButton,
  findNamedMenuItem,
} from "../../okou-page/__tests__/chat-attachment-test-helpers.ts";

const context = testContext();
const path = "/artifacts/shore023ab.png?source=mail#detail";
const host = "app.okou.ai";
const address = `https://${host}${path}`;

test("anonymous-shared-artifact-page-001 shares the page address and saves the public image", async () => {
  const filename = "shoreline.png";
  const url = "https://media.example.test/maps/shoreline.png";
  const downloadUrl =
    "https://media.example.test/files/shoreline?disposition=attachment";
  context.mocks.api(
    artifactReferencesContract.publicUrl,
    ({ params, respond }) => {
      if (params.reference !== "shore023ab.png") {
        return respond(404, {
          error: { code: "NOT_FOUND", message: "No such reference" },
        });
      }
      return respond(200, {
        url,
        downloadUrl,
        preview: { filename, contentType: "image/png" },
      });
    },
  );
  const clipboard = context.mocks.browser.clipboardWriteText();
  const browser = context.mocks.browser.blobDownload();
  await setupPage({ context, host, path, auth: null });
  await expect(
    screen.findByRole("img", { name: filename }),
  ).resolves.toHaveAttribute("src", url + "#detail");
  expect(screen.getByRole("heading", { name: filename })).toBeInTheDocument();
  expect(document.title).toBe(filename + " | Okou");
  click(await findNamedButton("Share"));
  await waitFor(() => {
    expect(clipboard.writes).toContain(address);
  });
  click(await findNamedButton("Download options"));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    expect(browser.downloads).toContainEqual({
      url: downloadUrl,
      filename,
      blob: null,
    });
  });
  expect(location.href).toBe(address);
  expect(screen.queryByTestId("app-sign-in")).not.toBeInTheDocument();
});

test("anonymous-shared-artifact-page-003 offers sign-in only after the unavailable page explains access", async () => {
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "No public reference" },
    });
  });
  const navigation = context.mocks.browser.locationAssign();
  await setupPage({ context, host, path, auth: null });
  await expect(
    screen.findByRole("heading", { name: "You can’t view this artifact" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Artifacts" }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/It may be private or no longer available/u),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(/shared with a different account/u),
  ).not.toBeInTheDocument();
  expect(screen.queryByTestId("artifact-dialog-stage")).not.toBeInTheDocument();
  expect(location.href).toBe(address);
  expect(screen.queryByTestId("app-sign-in")).not.toBeInTheDocument();
  expect(navigation.calls).toStrictEqual([]);
  click(await findNamedButton("Sign in"));
  await waitFor(() => {
    const target = new URL(navigation.calls[0] ?? "", address);
    expect(target.origin).toBe(location.origin);
    expect(target.pathname).toBe("/sign-in");
    expect(
      new URLSearchParams(target.hash.split("?")[1]).get("redirect_url"),
    ).toBe(address);
  });
});
