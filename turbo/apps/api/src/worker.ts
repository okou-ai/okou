import { createProductionApp } from "./production-bootstrap";
import { createApiWorker } from "./worker-runtime";

export default createApiWorker(createProductionApp);
