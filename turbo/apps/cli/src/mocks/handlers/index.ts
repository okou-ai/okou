import { apiHandlers } from "./api-handlers";
import { modelCatalogHandlers } from "./model-catalog";

export const handlers = [...apiHandlers, ...modelCatalogHandlers];
