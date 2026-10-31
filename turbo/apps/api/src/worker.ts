import { createProductionApp } from "./production-bootstrap";
import { createWorkerHandler } from "./worker-runtime";

export default createWorkerHandler(createProductionApp);
