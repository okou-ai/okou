import { artifactAccessContract } from "@okouai/api-contracts/contracts/artifact-access";
import { artifactReferencesContract } from "@okouai/api-contracts/contracts/artifact-references";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { mockedClerk } from "../../../__tests__/mock-auth.ts";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  findNamedButton,
  findNamedLink,
  findNamedMenuItem,
} from "../../okou-page/__tests__/chat-attachment-test-helpers.ts";

const context = testContext();
const fileId = "70000000-0000-4000-8000-000000000022";
const filename = "site-plan.png";
const path = "/artifacts/70000000000040008000000000000022.png";
const downloadUrl = "https://files.example.test/delivery/site-plan-attachment";
const imageUrl = "https://files.example.test/preview/site-plan.png";
function missingReference() {
  return { error: { code: "NOT_FOUND", message: "Missing reference" } };
}

function imageReference(reference = path.slice("/artifacts/".length)) {
  context.mocks.api(
    artifactReferencesContract.resolve,
    ({ params, respond }) => {
      if (params.reference !== reference) {
        return respond(404, missingReference());
      }
      return respond(200, {
        artifactId: fileId,
        target: { kind: "file", id: fileId },
        filename,
        contentType: "image/png",
        url: imageUrl,
        downloadUrl,
        expiresAt: "2099-01-01T00:00:00Z",
      });
    },
  );
}

function unavailableReference() {
  context.mocks.api(artifactReferencesContract.resolve, ({ respond }) => {
    return respond(404, missingReference());
  });
  context.mocks.api(artifactReferencesContract.publicUrl, ({ respond }) => {
    return respond(404, missingReference());
  });
}

test("shared-artifact-page-001 zooms and resets the image at its shared address", async () => {
  imageReference();
  const navigation = context.mocks.browser.locationReplace();
  await setupPage({ context, path, host: "app.okou.ai" });
  const main = within(screen.getByRole("main"));
  await expect(
    main.findByRole("img", { name: filename }),
  ).resolves.toHaveAttribute("src", imageUrl);
  expect(screen.getByRole("heading", { name: filename })).toBeInTheDocument();
  expect(document.title).toBe(`${filename} | Okou`);
  click(main.getByLabelText("Zoom in"));
  await waitFor(() => {
    expect(
      Number.parseInt(main.getByText(/^\d+%$/u).textContent ?? "", 10),
    ).toBeGreaterThan(100);
  });
  click(main.getByLabelText("Reset zoom"));
  await expect(main.findByText("100%")).resolves.toBeInTheDocument();
  expect(location.href).toBe(`https://app.okou.ai${path}`);
  expect(navigation.calls).toStrictEqual([]);
});

test("shared-artifact-page-003 saves the named attachment from a legacy address", async () => {
  imageReference(fileId.replaceAll("-", ""));
  const browser = context.mocks.browser.blobDownload();
  await setupPage({
    context,
    path: `/share/artifacts/${fileId}?from=catalog#image`,
  });
  click(await findNamedButton("Download options"));
  click(await findNamedMenuItem("Download"));
  await waitFor(() => {
    expect(browser.downloads).toContainEqual({
      filename,
      url: downloadUrl,
      blob: null,
    });
  });
});

test("shared-artifact-page-007 gives the signed-in reader recovery choices for a missing reference", async () => {
  unavailableReference();
  context.mocks.data.userPreferences({
    theme: "dark",
    colorTheme: "blue-horizon",
  });
  const email = "reader@example.test";
  await setupPage({
    context,
    path,
    auth: { user: { id: "reader", fullName: "Site reader", email } },
  });
  await expect(
    screen.findByText(`Signed in as ${email}`),
  ).resolves.toBeInTheDocument();
  const main = within(screen.getByRole("main"));
  expect(
    main.getByRole("heading", { name: "You can’t view this artifact" }),
  ).toBeInTheDocument();
  expect(
    main.getByText(
      /It may not exist, or it may be shared with a different account or organization\./u,
    ),
  ).toBeInTheDocument();
  expect(
    main.queryByText(/private or no longer available/u),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Artifacts" }),
  ).toBeInTheDocument();
  await expect(findNamedButton("Switch account")).resolves.toBeEnabled();
  await expect(findNamedLink("Back to Okou")).resolves.toHaveAttribute(
    "href",
    "/",
  );
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute(
      "data-color-theme",
      "blue-horizon",
    );
  });
  expect(document.documentElement).toHaveAttribute("data-theme", "dark");
  expect(main.queryByRole("img")).not.toBeInTheDocument();
  expect(document.querySelector("main iframe")).not.toBeInTheDocument();
  expect(screen.queryByText(filename)).not.toBeInTheDocument();
});

test("shared-artifact-page-008 carries the reader's return address into the account chooser", async () => {
  unavailableReference();
  const address = `${path}?source=mail#sheet-2`;
  await setupPage({ context, path: address });
  const handoff = context.mocks.deferred<void>();
  mockedClerk.openSignIn.mockReturnValueOnce(handoff.promise);
  const changeAccount = await findNamedButton("Switch account");
  click(changeAccount);
  const returnTo = new URL(address, location.origin).href;
  await waitFor(() => {
    expect(mockedClerk.openSignIn).toHaveBeenCalledWith(
      expect.objectContaining({
        fallbackRedirectUrl: returnTo,
        forceRedirectUrl: returnTo,
      }),
    );
  });
  expect(changeAccount).toBeDisabled();
  handoff.resolve();
  await waitFor(() => {
    expect(changeAccount).toBeEnabled();
  });
  expect(mockedClerk.signOut).not.toHaveBeenCalled();
});

test("shared-artifact-page-010 displays the public audience alongside the image type", async () => {
  imageReference();
  context.mocks.api(artifactAccessContract.getVisibility, ({ respond }) => {
    return respond(200, {
      artifactId: fileId,
      kind: "file",
      visibility: "public",
      ownerUrl: `http://localhost${path}`,
      shareUrl: "https://files.example.test/public/site-plan",
      shortUrl: "https://files.example.test/public/site-plan",
      organization: { id: "org_default", name: "Default Org" },
    });
  });
  await setupPage({ context, path });
  await expect(
    screen.findByText("Image · Public access"),
  ).resolves.toBeInTheDocument();
});
