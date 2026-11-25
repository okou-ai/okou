import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage, fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";
import {
  customConnector,
  mockCustomConnectorStory,
  mockPublicConnectorStatus,
  publicStatusItem,
  chooseConnectorAuthentication,
  getConnectorCard,
} from "./connector-page-test-helpers.ts";
const context = testContext();
async function selectScope(label: string) {
  const radio = await screen.findByText(label, { selector: '[role="radio"]' });
  click(radio);
}
function reports() {
  const connector = customConnector({ displayName: "Acme Reports" });
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(200, { connectors: [connector] });
  });
}
test("connectors-directory-custom-004 a member can inspect the empty Custom scope", async () => {
  context.mocks.data.org({ role: "member" });
  await setupPage({ context, path: "/connectors" });
  await findButton("Connect GitHub");
  await selectScope("Custom");
  await screen.findByText(
    "Your org hasn't registered any custom connectors yet.",
  );
  expect(screen.getByRole("heading", { name: "Custom" })).toBeInTheDocument();
  expect(new URL(window.location.href).searchParams.get("scope")).toBe(
    "custom",
  );
  expect(screen.queryByText("GitHub")).not.toBeInTheDocument();
  expect(queryButton("New custom connector")).toBeNull();
});

test("connectors-directory-custom-007 Back from the custom catalog returns to the remote directory", async () => {
  reports();
  await setupPage({ context, path: "/connectors" });
  await findButton("Connect GitHub");
  await selectScope("Remote control");
  await findButton("Add connection");
  await selectScope("Custom");
  await screen.findByText("Acme Reports");
  expect(window.location.search).toBe("?scope=custom");
  window.history.back();
  await waitFor(() => {
    return expect(new URL(window.location.href).searchParams.get("scope")).toBe(
      "remote-control",
    );
  });
  await findButton("Add connection");
  expect(screen.queryByText("Acme Reports")).not.toBeInTheDocument();
});

test("connectors-directory-custom-008 failed custom search reports its service failure", async () => {
  context.mocks.api(customConnectorsContract.list, ({ respond }) => {
    return respond(500, {
      error: { code: "UNAVAILABLE", message: "Catalog unavailable" },
    });
  });
  await setupPage({ context, path: "/connectors?keywords=recovered" });
  await screen.findByText("Couldn't load custom connectors.");
  expect(
    screen.queryByText('No connectors matching "recovered"'),
  ).not.toBeInTheDocument();
});

test("connectors-directory-custom-002 searching Acme groups both connectors by source", async () => {
  reports();
  mockPublicConnectorStatus(context, [
    publicStatusItem({ connectorSlug: "github", label: "Acme Reports" }),
  ]);
  await setupPage({ context, path: "/connectors" });
  const field = await screen.findByPlaceholderText("Find connectors");
  await fill(field, "acme");
  const built = await screen.findByText("Built-in connectors", {
    selector: "h2,h3",
  });
  const custom = await screen.findByText("Custom", { selector: "h2,h3" });
  for (const heading of [built, custom]) {
    const section = heading.closest("section")!;
    await within(section).findByText("Acme Reports");
  }
  expect(screen.queryByText(/No connectors matching/)).not.toBeInTheDocument();
});
test("connectors-directory-custom-009 Remote control keeps the custom directory off both surfaces", async () => {
  reports();
  await setupPage({ context, path: "/connectors" });
  await findButton("Connect GitHub");
  const customHeading = () => {
    return screen.queryByRole("heading", { name: "Custom" });
  };
  expect(customHeading()).not.toBeInTheDocument();
  expect(queryButton("New custom connector")).toBeNull();
  await selectScope("Remote control");
  await findButton("Add connection");
  expect(new URL(location.href).searchParams.get("scope")).toBe(
    "remote-control",
  );
  expect(customHeading()).not.toBeInTheDocument();
  expect(queryButton("New custom connector")).toBeNull();
});
test("connectors-directory-custom-010 cancelling keeps the search and creating reveals the new service", async () => {
  mockCustomConnectorStory(context);
  await setupPage({
    context,
    path: "/connectors?scope=custom&keywords=missing",
  });
  const search = await screen.findByPlaceholderText("Find custom connectors");
  click(await findButton("New custom connector"));
  const cancelled = await screen.findByRole("dialog");
  click(await findButton("Cancel"));
  await waitFor(() => {
    return expect(cancelled).not.toBeInTheDocument();
  });
  expect(search).toHaveValue("missing");
  expect(new URL(location.href).searchParams.get("keywords")).toBe("missing");
  click(await findButton("New custom connector"));
  const form = await screen.findByRole("dialog");
  await fill(within(form).getByPlaceholderText("Acme API"), "Created Service");
  await fill(
    within(form).getByPlaceholderText("https://api.acme.com/v1/"),
    "https://created.example.test/",
  );
  await chooseConnectorAuthentication(form, "API authentication");
  click(await findButton("Create"));
  await screen.findByText("Created Service");
  expect(getConnectorCard("Created Service")).toHaveTextContent("No accounts");
  expect(new URL(location.href).searchParams.get("scope")).toBe("custom");
});
