import { customConnectorsContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { click, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { findButton, queryButton } from "./chat-run-test-fixtures.ts";
import { customConnector } from "./connector-page-test-helpers.ts";
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
