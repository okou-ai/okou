import { waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { pathname } from "../../../signals/location.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  createSidebarHelpers,
  createThread,
  EXISTING_THREAD_ID,
  INCIDENT_THREAD_ID,
  setupSidebarPage,
  threadLinkByTitle,
} from "./sidebar-test-helpers.tsx";

const context = testContext();
const { mockSidebarThreadStory, prepareAgents } = createSidebarHelpers(context);

test("Alt-click still opens a thread in the sidebar pane", async () => {
  const user = userEvent.setup({ delay: null });
  prepareAgents();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Main conversation"),
    createThread(INCIDENT_THREAD_ID, "Side conversation"),
  ]);
  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });
  const sideLink = await waitFor(() => {
    return threadLinkByTitle("Side conversation");
  });

  await user.keyboard("{Alt>}");
  await user.click(sideLink);
  await user.keyboard("{/Alt}");

  await waitFor(() => {
    expect(new URLSearchParams(location.search).get("sidebar")).toBe(
      INCIDENT_THREAD_ID,
    );
    expect(pathname()).toBe(`/chats/${EXISTING_THREAD_ID}`);
    expect(
      document.querySelector(
        `[data-chat-thread-container-id="${INCIDENT_THREAD_ID}"]`,
      ),
    ).toBeInTheDocument();
  });
});
