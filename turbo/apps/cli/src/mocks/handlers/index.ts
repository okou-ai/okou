import { http, HttpResponse } from "msw";
import { apiHandlers } from "./api-handlers";
import { modelCatalogHandlers } from "./model-catalog";

export const handlers = [
  ...apiHandlers,
  ...modelCatalogHandlers,
  http.get("*/api/feature-switches", () => {
    return HttpResponse.json({
      effectiveSwitches: { singleAgent: false },
      switches: {},
    });
  }),
];
