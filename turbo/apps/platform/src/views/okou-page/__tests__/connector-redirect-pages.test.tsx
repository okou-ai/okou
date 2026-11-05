import { screen } from "@testing-library/react";
import { expect, test } from "vitest";

import { setupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

test("An unsafe route icon is not loaded", async () => {
  await setupPage({
    context,
    path: "/connectors/server-only/redirecting?label=Server+Only&iconUrl=http%3A%2F%2Ficons.example.test%2Fserver-only.svg&iconInvertInDarkMode=true",
    auth: null,
  });

  await expect(
    screen.findByRole("heading", { name: "Redirecting to Server Only…" }),
  ).resolves.toBeInTheDocument();
  expect(
    document.querySelector(
      'img[src="http://icons.example.test/server-only.svg"]',
    ),
  ).toBeNull();
});
