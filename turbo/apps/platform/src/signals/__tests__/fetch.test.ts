import { screen } from "@testing-library/react";
import {
  CLIENT_FORCE_UPGRADE_STATUS,
  CLIENT_REQUEST_ID_HEADER,
  CLIENT_SESSION_ID_HEADER,
  CLIENT_TYPE_HEADER,
  CLIENT_VERSION_HEADER,
} from "@okouai/api-contracts/contracts/client-headers";
import { userBuiltinConnectorsContract } from "@okouai/api-contracts/contracts/user-connectors";
import { expect, test, vi } from "vitest";

import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../__tests__/page-helper.ts";
import { accept } from "../../lib/accept.ts";
import { apiClient$ } from "../api-client.ts";
import { testContext } from "./test-helpers.ts";

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const APP_VERSION = "platform-gwt-version";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface ObservedClientHeaders {
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly type: string | null;
  readonly version: string | null;
}

const context = testContext();

function observedClientHeaders(request: Request): ObservedClientHeaders {
  return {
    requestId: request.headers.get(CLIENT_REQUEST_ID_HEADER),
    sessionId: request.headers.get(CLIENT_SESSION_ID_HEADER),
    type: request.headers.get(CLIENT_TYPE_HEADER),
    version: request.headers.get(CLIENT_VERSION_HEADER),
  };
}

async function waitForReadyPage(): Promise<void> {
  await screen.findByText("Oops! Something went sideways");
}

function client() {
  return context.store.get(apiClient$)(userBuiltinConnectorsContract);
}

test("Service requests carry stable client context and a unique trace", async () => {
  const observedHeaders: ObservedClientHeaders[] = [];
  context.mocks.api(
    userBuiltinConnectorsContract.get,
    ({ request, respond }) => {
      observedHeaders.push(observedClientHeaders(request));
      return respond(200, { enabledConnectorSlugs: [] });
    },
  );

  await setupPage({
    appVersion: APP_VERSION,
    context,
    path: "/_/error",
  });

  await waitForReadyPage();

  await client().get({
    params: { id: AGENT_ID },
    extraHeaders: {
      [CLIENT_REQUEST_ID_HEADER]: "caller-request-id",
      [CLIENT_SESSION_ID_HEADER]: "caller-session-id",
      [CLIENT_TYPE_HEADER]: "caller-type",
      [CLIENT_VERSION_HEADER]: "caller-version",
    },
  });
  await client().get({ params: { id: AGENT_ID } });

  expect(observedHeaders).toHaveLength(2);
  const [contractRequest, secondRequest] = observedHeaders;
  expect(contractRequest).toStrictEqual(
    expect.objectContaining({
      requestId: expect.stringMatching(UUID_PATTERN),
      sessionId: expect.stringMatching(UUID_PATTERN),
      type: "App",
      version: APP_VERSION,
    }),
  );
  expect(secondRequest).toStrictEqual(
    expect.objectContaining({
      requestId: expect.stringMatching(UUID_PATTERN),
      sessionId: contractRequest?.sessionId,
      type: "App",
      version: APP_VERSION,
    }),
  );
  expect(secondRequest?.requestId).not.toBe(contractRequest?.requestId);
});

test("An empty service error still gives the user a useful status", async () => {
  context.mocks.api(userBuiltinConnectorsContract.get, ({ respond }) => {
    return respond(403, {
      error: { code: "FORBIDDEN", message: "" },
    });
  });

  await setupPage({ context, path: "/_/error" });

  await waitForReadyPage();

  await expect(
    accept(client().get({ params: { id: AGENT_ID } }), [200]),
  ).rejects.toThrow("HTTP 403");

  await screen.findByText("HTTP 403");
});

test("The update dialog appears only when an update is required", async () => {
  const reload = vi
    .spyOn(window.location, "reload")
    .mockImplementation(() => {});
  context.mocks.http.get("*/api/agents/:id/user-connectors", () => {
    return Response.json(
      { error: "Client update required" },
      { status: CLIENT_FORCE_UPGRADE_STATUS },
    );
  });

  await setupPage({ context, path: "/_/error" });

  await waitForReadyPage();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await client().get({ params: { id: AGENT_ID } });

  const dialog = await screen.findByRole("dialog", {
    name: "Update required",
  });
  expect(dialog).toHaveTextContent(
    "This version of Okou is no longer supported. Refresh to load the latest version.",
  );
  const refresh = queryAllByRoleFast("button", dialog).find((button) => {
    return button.textContent?.trim() === "Refresh";
  });
  if (!refresh) {
    throw new Error("Refresh button not found");
  }

  click(refresh);

  expect(reload).toHaveBeenCalledOnce();
});

test("A required Platform upgrade opens the update dialog", async () => {
  let requestCount = 0;
  context.mocks.http.get("*/api/agents/:id/user-connectors", () => {
    requestCount += 1;
    if (requestCount === 1) {
      return Response.json({ enabledConnectorSlugs: [] });
    }
    return Response.json(
      { error: "Client update required" },
      { status: CLIENT_FORCE_UPGRADE_STATUS },
    );
  });

  await setupPage({ context, path: "/_/error" });

  await waitForReadyPage();

  await client().get({ params: { id: AGENT_ID } });

  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await client().get({ params: { id: AGENT_ID } });

  await screen.findByRole("dialog", { name: "Update required" });
});
