import { screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";

import {
  queryAllByRoleFast,
  setupPage,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { createMarkdownChatFixture } from "./markdown-page-test-helpers.ts";

const context = testContext();
const CONNECT_URL =
  "https://login.link.com/auth?key=pk_test_fixture&client_id=fixture&redirect_uri=https%3A%2F%2Fapp.okou.ai%2Fconnectors%2Flink%2Fcallback&response_type=code&scope=payment_methods.agentic&state=exact%2Bstate&code_challenge=challenge&code_challenge_method=S256";
const APPROVAL_URL =
  "https://app.link.com/activity/approve/lsrq_fixture?key=exact%2Fkey&token=one+two&token=three#review";

function actionLinks() {
  return queryAllByRoleFast("link").filter((link) => {
    return [
      "Authorize Link wallet",
      "Review purchase",
      "Continue in Link",
    ].includes(link.getAttribute("aria-label") ?? "");
  });
}

async function openChat(content: string) {
  const chat = createMarkdownChatFixture(context);
  chat.install({
    rows: () => {
      return [
        chat.outputMessage(content, { seqId: 1 }),
        chat.runCompleted({ seqId: 2 }),
      ];
    },
  });
  await setupPage({ context, path: chat.path, host: "app.okou.ai" });
}

test("wallet authorization and purchase links show cards with the exact provider destinations", async () => {
  await openChat(
    `Authorize your wallet\n\n[Reconnect Link](${CONNECT_URL})\n\nReview before buying\n\n${APPROVAL_URL}\n\nWaiting for your review`,
  );

  await screen.findByText("Authorize Link wallet");
  const links = actionLinks();
  expect(links).toHaveLength(2);
  expect(links[0]).toHaveAttribute("href", CONNECT_URL);
  expect(links[0]).toHaveTextContent("Authorize");
  expect(links[1]).toHaveAttribute("href", APPROVAL_URL);
  expect(links[1]).toHaveTextContent("Review");
  for (const link of links) {
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  expect(screen.getByText("login.link.com")).toBeVisible();
  expect(screen.getByText("app.link.com")).toBeVisible();
  expect(screen.getByText("Review before buying")).toBeVisible();
  expect(screen.getByText("Waiting for your review")).toBeVisible();
});

test("wallet follow-up actions keep provider URLs without inferring payment or approval state", async () => {
  const urls = [
    "https://app.link.com/verify?session=exact%2Fverification",
    "https://app.link.com/finish_setup?verify=3ds",
    "https://app.link.com/add_payment_method",
    "https://app.link.com/update_payment_method",
    "https://app.link.com/select_payment_method",
    "https://app.link.com/identity_verification?session=fixture",
    "https://hooks.stripe.com/redirect/authenticate?client=fixture%2Fexact&return_url=https%3A%2F%2Fapp.link.com%2Factivity",
    "https://hooks.stripe.com/redirect/authenticate/src_fixture?client_secret=fixture%2Fexact",
    "https://hooks.stripe.com/3d_secure_2/hosted?session=fixture%2Fexact",
  ];
  await openChat(urls.join("\n\n"));

  await screen.findAllByText("hooks.stripe.com");
  const links = actionLinks();
  expect(
    links.map((link) => {
      return link.getAttribute("href");
    }),
  ).toStrictEqual(urls);
  for (const link of links) {
    expect(link).toHaveAccessibleName("Continue in Link");
    expect(link).toHaveTextContent("Continue");
  }
  expect(
    screen.queryByText(/payment approved|payment completed|paid successfully/i),
  ).not.toBeInTheDocument();
});

test("both purchase approval URL formats render review actions", async () => {
  const urls = [
    "https://app.link.com/approve/lsrq_fixture",
    "https://app.link.com/approve?request=fixture%2Fapproval&key=exact",
  ];
  await openChat(
    urls
      .map((url) => {
        return `[Review purchase](${url})`;
      })
      .join("\n\n"),
  );

  await waitFor(() => {
    expect(actionLinks()).toHaveLength(2);
  });
  expect(
    actionLinks().map((link) => {
      return link.getAttribute("href");
    }),
  ).toStrictEqual(urls);
  for (const link of actionLinks()) {
    expect(link).toHaveAccessibleName("Review purchase");
  }
});

test("ordinary provider links and untrusted wallet lookalikes stay ordinary links", async () => {
  const urls = [
    "https://link.com",
    "https://support.link.com/questions/link-agent-wallet-faq",
    "https://login.link.com/auth?scope=profile",
    "https://hooks.stripe.com/other-page",
    "https://hooks.stripe.com/redirect/authenticate-other",
    "https://app.link.com.evil.example/activity/approve/fixture",
    "https://app.link.com@evil.example/activity/approve/fixture",
    "https://name:password@app.link.com/activity/approve/fixture",
    "https://app.link.com:8443/activity/approve/fixture",
    "http://app.link.com/activity/approve/fixture",
  ];
  await openChat(
    urls
      .map((url, index) => {
        return `[Reference ${index}](${url})`;
      })
      .join("\n\n"),
  );

  await screen.findByText("Reference 9");
  expect(actionLinks()).toHaveLength(0);
  for (const [index, url] of urls.entries()) {
    expect(screen.getByText(`Reference ${index}`)).toHaveAttribute("href", url);
  }
});

test("wallet URLs in code and user messages do not become action cards", async () => {
  const chat = createMarkdownChatFixture(context);
  chat.install({
    rows: () => {
      return [
        chat.inputPrompt(APPROVAL_URL, { seqId: 1 }),
        chat.outputMessage(
          `Inline: \`${CONNECT_URL}\`\n\n\`\`\`text\n${APPROVAL_URL}\n\`\`\`\n\nThese are code examples`,
          { seqId: 2 },
        ),
        chat.runCompleted({ seqId: 3 }),
      ];
    },
  });
  await setupPage({ context, path: chat.path, host: "app.okou.ai" });

  await screen.findByText("These are code examples");
  expect(actionLinks()).toHaveLength(0);
  expect(document.querySelector("code.language-text")).toHaveTextContent(
    APPROVAL_URL,
  );
});
