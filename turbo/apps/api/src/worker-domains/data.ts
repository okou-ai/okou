import { createAppWithRoutes } from "../app-factory-base";
import { createApiWorker } from "../worker-runtime";
import { DATA_ROUTES } from "../signals/route-groups/data";

export default createApiWorker((signal) => {
  return createAppWithRoutes({
    signal,
    routes: DATA_ROUTES,
    initializeServices$: undefined,
  });
});
