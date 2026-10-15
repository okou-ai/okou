import indexHtml from "../shell/index.html";
import worker from "./index";
import { withPreviewBuildIdentity } from "./preview-response.js";

export default withPreviewBuildIdentity(worker, indexHtml);
