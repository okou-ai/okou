import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();
test("Home opens the current workspace composer", async () => {
  await setupPage({
    context,
    path: "/",
    auth: {
      user: { id: "test-user-123", fullName: "Test User" },
      organization: {
        activeOrg: { id: "org_current", name: "Current organization" },
        memberships: [{ id: "org_current" }, { id: "org_previous" }],
      },
    },
  });

  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(pathname()).toBe("/");
    expect(document.title).toBe("Chat | Okou");
  });
});

test("Home preserves a prompt handoff", async () => {
  await setupPage({
    context,
    path: "/?prompt=Draft%20a%20launch%20plan",
  });

  await screen.findByRole("textbox", { name: "Message" });
  await waitFor(() => {
    expect(pathname()).toBe("/");
    expect(screen.getByRole("textbox", { name: "Message" })).toHaveTextContent(
      "Draft a launch plan",
    );
  });
});
