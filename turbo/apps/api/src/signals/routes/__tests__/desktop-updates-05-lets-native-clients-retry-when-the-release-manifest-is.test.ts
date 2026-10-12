import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { testContext } from "../../../__tests__/test-context";

import { server } from "../../../mocks/server";
import { createDesktopUpdatePublicApi } from "./helpers/desktop-update-public";

const context = testContext();
const { appRequest, OKOU_DESKTOP_UPDATE_MANIFEST_URL } =
  createDesktopUpdatePublicApi(context);

// Default Vitest file isolation gives this scenario a fresh module cache.
describe("desktop update routes", () => {
  it("lets native clients retry when the release manifest is unavailable", async () => {
    server.use(
      http.get(OKOU_DESKTOP_UPDATE_MANIFEST_URL, () => {
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const response = await appRequest(
      "/api/desktop/updates/ai-okou-desktop/stable/darwin/arm64/appcast.xml",
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
