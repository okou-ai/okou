import { createAppWithRoutes } from "../app-factory-base";
import { createApiWorker } from "../worker-runtime";
import { DATA_ROUTES } from "./routes-data";

export default createApiWorker((signal) => {
  return createAppWithRoutes({
    signal,
    routes: DATA_ROUTES,
    initializeServices$: undefined,
  });
});
