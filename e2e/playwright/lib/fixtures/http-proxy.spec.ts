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
