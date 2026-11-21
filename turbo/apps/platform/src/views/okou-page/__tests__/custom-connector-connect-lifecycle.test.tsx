import { connectorAccountsContract } from "@okouai/api-contracts/contracts/connector-accounts";
import { customConnectorValuesContract } from "@okouai/api-contracts/contracts/custom-connectors";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";

import { click, fill, setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  customConnector,
  customConnectorAccount,
  getConnectorAction,
  mockCustomConnectorStory,
} from "./connector-page-test-helpers.ts";

const context = testContext();
const CONNECTION_ID = "e0000000-0000-4000-a000-000000000e51";

async function openConnect(): Promise<HTMLElement> {
  const connect = await waitFor(() => {
    return getConnectorAction("button", "Connect Acme Search");
  });
  click(connect);
  return await screen.findByRole("dialog", { name: "Connect Acme Search" });
}

test("Cancel a pending custom connection and connect another account", async () => {
  const connector = customConnector();
  mockCustomConnectorStory(context, [{ connector }]);
  const first = {
    started: context.mocks.deferred<void>(),
    aborted: context.mocks.deferred<void>(),
    release: context.mocks.deferred<void>(),
    answered: context.mocks.deferred<void>(),
  };
  context.mocks.api(
    customConnectorValuesContract.set,
    async ({ body, request, respond }) => {
      const secret = body.values.find((value) => {
        return value.key === "secret";
      })?.value;
      if (secret === "first-secret") {
        request.signal.addEventListener(
          "abort",
          () => {
            first.aborted.resolve();
          },
          { once: true },
        );
        first.started.resolve();
        await first.release.promise;
        first.answered.resolve();
        return respond(200, {
          ...connector,
          connectionId: "e0000000-0000-4000-a000-000000000e52",
        });
      }
      return respond(200, { ...connector, connectionId: CONNECTION_ID });
    },
  );
  context.mocks.api(
    connectorAccountsContract.connection,
    ({ params, respond }) => {
      return respond(
        200,
        customConnectorAccount(connector.id, { id: params.connectionId }),
      );
    },
  );
  await setupPage({ context, path: "/connectors?scope=custom" });
  const firstDialog = await openConnect();
  await fill(within(firstDialog).getByLabelText("Secret"), "first-secret");
  click(getConnectorAction("button", "Save", firstDialog));
  await first.started.promise;

  await userEvent.keyboard("{Escape}");

  await waitFor(() => {
    expect(firstDialog).not.toBeInTheDocument();
  });
  await first.aborted.promise;

  const secondDialog = await openConnect();
  const secret = within(secondDialog).getByLabelText("Secret");
  expect(secret).toHaveValue("");
  await fill(secret, "second-secret");
  first.release.resolve();
  await first.answered.promise;
  expect(within(secondDialog).getByLabelText("Secret")).toHaveValue(
    "second-secret",
  );

  click(getConnectorAction("button", "Save", secondDialog));

  await expect(
    screen.findByRole("dialog", { name: "Name your Acme Search account" }),
  ).resolves.toBeInTheDocument();
  expect(secondDialog).not.toBeInTheDocument();
});
