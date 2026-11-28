import { randomUUID } from "node:crypto";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
} from "@okouai/api-contracts/contracts/workflows";
import { expect, test } from "vitest";
import { setupApp } from "../../../__tests__/test-helpers";
import { accept, testContext } from "../../../__tests__/test-context";
import { createDeferredPromise } from "../../utils";
import { workflowsRoutes } from "../workflows";
import { createRouteMocks } from "./helpers/route-test";
import { installWorkflowVolumeS3Fixture } from "./helpers/workflow-volume-s3";

const context = testContext();
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
const app = setupApp({ context, routes: workflowsRoutes });
const rethrowingApp = setupApp({
  context,
  routes: workflowsRoutes,
  rethrowErrors: true,
});
const files = Object.freeze([{ path: "reference.md", content: "附件" }]);

function signIn() {
  createRouteMocks(context).clerk.session(
    `user_${randomUUID()}`,
    `org_${randomUUID()}`,
  );
}

function workflowName() {
  return `flow-${randomUUID().slice(0, 8)}`;
}

function create(
  name: string,
  body: { files: { path: string; content: string }[] },
) {
  return app(workflowsCollectionContract).create({
    headers,
    body: { name, instruction: "Read the attached reference", ...body },
  });
}

async function readWorkflow(workflowId: string) {
  return await accept(
    app(workflowsDetailContract).get({ headers, params: { workflowId } }),
    [200],
  );
}

test("workflows-creation-005 does not reserve a name when attachment files conflict with a directory", async () => {
  signIn();
  const storage = installWorkflowVolumeS3Fixture(context);
  const name = workflowName();

  await expect(
    rethrowingApp(workflowsCollectionContract).create({
      headers,
      body: {
        name,
        files: [
          { path: "reference", content: "file" },
          { path: "reference/nested.md", content: "nested" },
        ],
      },
    }),
  ).rejects.toThrow("Workflow attachment file conflicts with a directory");
  expect(storage.writes).toHaveLength(0);

  await accept(create(name, { files: [...files] }), [201]);
});

test("workflows-creation-001 keeps a Workflow unlisted until its attachment is stored", async () => {
  signIn();
  const storage = installWorkflowVolumeS3Fixture(context);
  const name = workflowName();
  const writing = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  storage.beforeNextArchiveWrite(async () => {
    writing.resolve();
    await release.promise;
  });

  const creating = create(name, { files: [...files] });
  await writing.promise;
  const listed = await accept(
    app(workflowsCollectionContract).list({ headers, query: {} }),
    [200],
  );
  release.resolve();
  const created = await accept(creating, [201]);
  const read = await readWorkflow(created.body.id);

  expect(
    listed.body.map((workflow) => {
      return workflow.name;
    }),
  ).not.toContain(name);
  expect(read.body.instruction).toBe("Read the attached reference");
  expect(read.body.fileContents).toStrictEqual(files);
});

test("workflows-creation-002 publishes one readable Workflow for duplicate creates", async () => {
  signIn();
  const storage = installWorkflowVolumeS3Fixture(context);
  const name = workflowName();
  const writing = createDeferredPromise<void>(context.signal);
  const release = createDeferredPromise<void>(context.signal);
  storage.beforeNextArchiveWrite(async () => {
    writing.resolve();
    await release.promise;
  });

  const first = create(name, { files: [...files] });
  await writing.promise;
  const second = await accept(create(name, { files: [...files] }), [201]);
  release.resolve();
  await accept(first, [409]);
  const read = await readWorkflow(second.body.id);

  expect(read.body.fileContents).toStrictEqual(files);
});
