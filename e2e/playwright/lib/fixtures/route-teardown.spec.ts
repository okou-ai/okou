import { expect, test as base } from "../../fixtures";

let routeCompleted = false;
let releaseRequest: Promise<void> = Promise.resolve();

const test = base.extend({
  context: async ({ context }, use, testInfo) => {
    routeCompleted = false;
    try {
      await use(context);
      // Context teardown must not start while a successful route is unfinished.
      if (testInfo.title !== "route-failure") {
        expect(routeCompleted, "ROUTE_NOT_DRAINED").toBe(true);
      }
    } finally {
      await releaseRequest;
    }
  },
  page: async ({ page }, use) => {
    try {
      await use(page);
    } finally {
      // Start releasing only as fixture teardown begins. The context fixture
      // owns this promise so we do not drain the tested page fixture ourselves.
      releaseRequest = page.request.post("/release").then((response) => {
        expect(response.ok()).toBe(true);
      });
    }
  },
});

for (const scenario of ["success", "body-failure", "route-failure"]) {
  test(scenario, async ({ page, request }) => {
    page.on("close", () => console.log("PAGE_CLOSED"));
    await page.route("**/api/user-preferences", async (route) => {
      const response = await route.fetch();
      const preferences: unknown = await response.json();
      expect(preferences).toEqual({ theme: "light" });
      if (scenario === "route-failure") {
        throw new Error("INTENTIONAL_ROUTE_FAILURE");
      }
      await route.fulfill({ response, json: { theme: "system" } });
      routeCompleted = true;
      console.log("ROUTE_COMPLETED");
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Load preferences" }).click();
    // This responds only once the real upstream request is held in flight.
    const started = await request.get("/started");
    expect(started.ok()).toBe(true);
    console.log("BODY_FINISHED");
    expect(scenario, "INTENTIONAL_BODY_FAILURE").not.toBe("body-failure");
  });
}
