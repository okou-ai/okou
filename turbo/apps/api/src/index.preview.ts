import { createVercelEntrypoint } from "./index";
import { createPreviewRunnerDispatchPool } from "./runner-dispatch-pool.node";

export default createVercelEntrypoint(createPreviewRunnerDispatchPool);
