import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  linksByName,
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();

test("An unavailable public conversation offers sign-in with a return to the same link", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Shared chat not found" },
    });
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "You can’t view this chat" }),
  ).resolves.toBeInTheDocument();
  const signInLinks = linksByName("Sign in");
  expect(signInLinks.length).toBeGreaterThan(0);
  for (const link of signInLinks) {
    const url = new URL(link.getAttribute("href") ?? "", window.location.href);
    expect(url.origin).toBe("https://app.okou.ai");
    expect(url.pathname).toBe("/sign-in");
    expect(url.searchParams.get("redirect_url")).toBe(window.location.href);
  }
  expect(getLinkByName("Okou")).toHaveAttribute("href", "https://app.okou.ai");
  expect(getLinkByName("Sign up")).toHaveAttribute(
    "href",
    expect.stringMatching(/^https:\/\/app\.okou\.ai\/sign-up\?/u),
  );
});

test("Anonymous readers see the public title, prompt and rendered Markdown", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(prefers-color-scheme: dark)";
  });
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          { messageIndex: 0, role: "user", content: "Review the launch plan." },
          {
            messageIndex: 1,
            role: "assistant",
            content:
              "# Primary\n\n## Secondary\n\nA **public preview** of the plan.",
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { level: 2, name: "Secondary" }),
  ).resolves.toBeInTheDocument();
  expect(
    screen.getByRole("heading", { level: 1, name: "Primary" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Public launch plan")).toBeInTheDocument();
  expect(screen.getByText("Review the launch plan.")).toBeInTheDocument();
  expect(
    screen.getByText("public preview", { selector: "strong" }),
  ).toBeInTheDocument();
  expect(screen.queryByTestId("rich-content-loading")).not.toBeInTheDocument();
  const brand = getLinkByName("Okou");
  expect(brand).toHaveAttribute("href", "https://app.okou.ai");
  expect(brand.querySelector("img")).toHaveAttribute(
    "src",
    expect.stringMatching(/light/u),
  );
});

test("A shared user's prompt keeps literal Markdown and opens links safely", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [
          {
            messageIndex: 0,
            role: "user",
            content:
              "Open https://example.com/report and leave **bold** literal.",
          },
        ],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByText(/and leave \*\*bold\*\* literal\./u),
  ).resolves.toBeVisible();
  expect(screen.getByText("Open")).toBeVisible();
  const report = getLinkByName("https://example.com/report");
  expect(report).toHaveAttribute("href", "https://example.com/report");
  expect(report).toHaveAttribute("target", "_blank");
  expect(report).toHaveAttribute("rel", "noopener noreferrer");
});
