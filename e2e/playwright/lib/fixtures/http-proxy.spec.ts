import { expect, test } from "../../fixtures";

test("browser and API requests use the configured proxy", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveText("proxied");
  const response = await request.get("/");
  expect(response.ok()).toBe(true);
  expect(await response.text()).toBe("proxied");
});

test("retain proxy failure diagnostics", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toHaveText("proxied");
  throw new Error("INTENTIONAL_PROXY_REPORT_FAILURE");
});
