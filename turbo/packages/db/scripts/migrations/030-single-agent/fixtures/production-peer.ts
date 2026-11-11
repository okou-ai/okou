import { readFileSync } from "node:fs";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { number, object, string } from "zod";
import { BRANCH, PROJECT, STAFF_ORG, WORKFLOW } from "../production-model";

// External protocol fixtures are preloaded only by the CLI integration test.
const fixture = object({
  minimumCu: number(),
  sourceCommit: string(),
  planRunId: string(),
}).parse(JSON.parse(readFileSync(process.argv.at(-1)!, "utf8")));
process.argv.splice(-2);
const base = `https://console.neon.tech/api/v2/projects/${PROJECT}`;
const server = setupServer(
  http.get(`${base}/branches/${BRANCH}`, () => {
    return HttpResponse.json({
      branch: {
        id: BRANCH,
        default: true,
        protected: true,
        current_state: "ready",
      },
    });
  }),
  http.get(`${base}/endpoints`, () => {
    return HttpResponse.json({
      endpoints: [
        {
          id: "ep-production-fixture",
          branch_id: BRANCH,
          type: "read_write",
          host: "fixture.neon.tech",
          autoscaling_limit_min_cu: fixture.minimumCu,
          autoscaling_limit_max_cu: 8,
        },
      ],
    });
  }),
  http.get("https://api.github.com/repos/okou-ai/okou/actions/runs/:id", () => {
    return HttpResponse.json({
      id: Number(fixture.planRunId),
      head_sha: fixture.sourceCommit,
      head_branch: "main",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
      run_attempt: 1,
      path: WORKFLOW,
      display_title: `plan single-agent ${STAFF_ORG} by @operator`,
    });
  }),
  http.get(
    "https://api.github.com/repos/okou-ai/okou/compare/:comparison",
    () => {
      return HttpResponse.json({
        status: "ahead",
        merge_base_commit: { sha: fixture.sourceCommit },
      });
    },
  ),
);
server.listen({ onUnhandledRequest: "error" });
