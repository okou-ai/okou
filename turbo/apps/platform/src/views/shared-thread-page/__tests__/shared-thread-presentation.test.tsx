import { sharedThreadsContract } from "@okouai/api-contracts/contracts/shared-threads";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { expect, test } from "vitest";

import { queryAllByRoleFast } from "../../../__tests__/page-helper.ts";
import { platformOkouWordmarkLightImg } from "../../../lib/static-assets.ts";
import {
  testContext,
  warmMermaidParser,
} from "../../../signals/__tests__/test-helpers.ts";
import {
  getLinkByName,
  setupSharedThreadPage,
  sharedThread,
} from "./shared-thread-test-helpers.ts";

const context = testContext();

warmMermaidParser();

test("A missing public conversation uses the Okou presentation", async () => {
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(404, {
      error: { code: "NOT_FOUND", message: "Not found" },
    });
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", {
      name: "Shared conversation not found",
    }),
  ).resolves.toBeInTheDocument();
  const brandLink = getLinkByName("Okou");
  expect(brandLink).toHaveAttribute("href", "https://app.okou.ai");
  expect(getLinkByName("Sign up")).toHaveAttribute(
    "href",
    expect.stringContaining("https://app.okou.ai/sign-up"),
  );
});

test("A public conversation hides owner and agent identity", async () => {
  context.mocks.browser.matchMedia((query) => {
    return query === "(prefers-color-scheme: dark)";
  });
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(200, {
      ...sharedThread(),
      title: "Public launch plan",
      messages: [
        {
          messageIndex: 0,
          role: "user",
          content: "What should we launch?",
          runIndex: 0,
        },
        {
          messageIndex: 1,
          role: "assistant",
          content: "The plain status is ready.",
          runIndex: 0,
        },
        {
          messageIndex: 2,
          role: "assistant",
          content: "Primary\n=\n\nLaunch the **public preview**.",
          runIndex: 0,
        },
        {
          messageIndex: 3,
          role: "assistant",
          content: "Secondary\n--",
          runIndex: 0,
        },
      ],
    });
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  await expect(
    screen.findByRole("heading", { name: "Public launch plan" }),
  ).resolves.toBeInTheDocument();
  expect(screen.getByText("What should we launch?")).toBeInTheDocument();
  expect(screen.getByText("The plain status is ready.")).toBeInTheDocument();
  await expect(
    screen.findByRole("heading", { name: "Primary" }),
  ).resolves.toHaveProperty("tagName", "H1");
  expect(screen.getByRole("heading", { name: "Secondary" })).toHaveProperty(
    "tagName",
    "H2",
  );
  expect(screen.getByText("public preview")).toHaveProperty(
    "tagName",
    "STRONG",
  );
  expect(screen.queryByTestId("rich-content-loading")).not.toBeInTheDocument();
  const brandLink = getLinkByName("Okou");
  expect(brandLink).toHaveAttribute("href", "https://app.okou.ai");
  expect(within(brandLink).getByRole("img", { name: "Okou" })).toHaveAttribute(
    "src",
    platformOkouWordmarkLightImg,
  );
  expect(screen.queryByText("Owner")).not.toBeInTheDocument();
  expect(screen.queryByText("Agent")).not.toBeInTheDocument();
});

test("A link inside a public prompt is clickable for a signed-out visitor", async () => {
  const content =
    "Compare https://example.com/report and keep **bold** as is, please.";
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [{ messageIndex: 0, role: "user", content, runIndex: 0 }],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  // A share link has no workspace to resolve a switch against, so the released
  // default is what a visitor reads.
  const link = await waitFor(() => {
    const found = queryAllByRoleFast("link").find((candidate) => {
      return candidate.getAttribute("href") === "https://example.com/report";
    });
    if (!found) {
      throw new Error("Prompt link not found");
    }
    return found;
  });
  expect(link).toHaveTextContent("https://example.com/report");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noopener noreferrer");
  // The prompt is not Markdown, so `**bold**` has to survive linking.
  expect(screen.getByText("Compare")).toBeInTheDocument();
  expect(
    screen.getByText("and keep **bold** as is, please."),
  ).toBeInTheDocument();
});

test("A public conversation renders embedded media and diagrams", async () => {
  const content = [
    "![Launch map](https://media.example.com/launch.png)",
    "",
    "```mermaid",
    "flowchart TD",
    "  Plan --> Launch",
    "```",
  ].join("\n");
  context.mocks.api(sharedThreadsContract.get, ({ respond }) => {
    return respond(
      200,
      sharedThread({
        messages: [{ messageIndex: 0, role: "assistant", content }],
      }),
    );
  });

  await setupSharedThreadPage(context, { host: "app.okou.ai" });

  const image = await screen.findByRole("img", { name: "Launch map" });
  fireEvent.load(image);
  expect(image).toBeVisible();
  expect(image).toHaveAttribute("src", "https://media.example.com/launch.png");
  await expect(
    screen.findByRole("img", { name: "Diagram" }),
  ).resolves.toBeVisible();
  const expandDiagram = queryAllByRoleFast("button").find((button) => {
    return button.getAttribute("aria-label") === "Expand diagram";
  });
  expect(expandDiagram).toBeEnabled();
});
