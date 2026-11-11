import { PutObjectCommand } from "@aws-sdk/client-s3";
import { randomBytes } from "node:crypto";
import { describe, expect, it, onTestFinished, test } from "vitest";
import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import type { GenerationTemplateRequest } from "@okouai/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import { readTemplateGuidanceBundle } from "@okouai/core/template-guidance-bundle";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import { userTemplatesRoutes } from "../user-templates";
import { presentationTemplatesRoutes } from "../presentation-templates";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import { createRouteMocks } from "./helpers/route-test";
import { createChatEventsFixture } from "./helpers/chat-events-fixture";
import { publicChatActor } from "./helpers/public-chat-actor";
import { updateFeatureSwitchesForUser } from "./helpers/feature-switches";
import {
  installS3Fixture,
  tarGz,
  uploadTemplateFile,
  type Fixture,
} from "./helpers/template-publish-fixture";

const context = testContext();
const bdd = createBddApi(context);
const mocks = createRouteMocks(context);
const chat = createChatEventsFixture(context);
type RunnerClaim = Awaited<ReturnType<typeof chat.claimChatRun>>["claim"];
const sourceType =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ownerKinds = ["user-template", "presentation-template"] as const;
type OwnerKind = (typeof ownerKinds)[number];

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function userClient() {
  return setupApp({ context, routes: userTemplatesRoutes })(
    userTemplatesContract,
  );
}

function presentationClient() {
  return setupApp({ context, routes: presentationTemplatesRoutes })(
    presentationTemplatesContract,
  );
}

function guidance(revision: string) {
  return [
    { path: "SKILL.md", content: `# Template ${revision}\n` },
    { path: "design-system.md", content: `Design ${revision}\n` },
  ];
}

async function uploadInputs(
  actor: ApiTestUser,
  fixture: Fixture,
  archive: Buffer,
) {
  const sourceFileId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename: "source.pptx", contentType: sourceType },
    Buffer.from("PK source"),
  );
  const pageId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename: "page-001.png", contentType: "image/png" },
    Buffer.from("source preview"),
  );
  const packageFileId = await uploadTemplateFile(
    context,
    actor,
    fixture,
    { filename: "package.tar.gz", contentType: "application/gzip" },
    archive,
  );
  return { sourceFileId, pageFileIds: [pageId], packageFileId };
}

async function publish(
  kind: OwnerKind,
  inputs: Awaited<ReturnType<typeof uploadInputs>>,
  status: 200 | 500 = 200,
) {
  return kind === "user-template"
    ? await accept(
        userClient().publish({
          headers: authHeaders(),
          body: {
            title: "Immutable guidance",
            kind: "presentation",
            ...inputs,
          },
        }),
        [status],
      )
    : await accept(
        presentationClient().publish({
          headers: authHeaders(),
          body: { title: "Immutable guidance", ...inputs },
        }),
        [status],
      );
}

function selection(kind: OwnerKind, id: string): GenerationTemplateRequest {
  return kind === "user-template"
    ? { type: "custom", selection: { userTemplateId: id } }
    : {
        type: "presentation",
        selection: { templateId: formatUserPresentationTemplateId(id) },
      };
}

async function remove(kind: OwnerKind, id: string) {
  const args = {
    headers: authHeaders(),
    params: { templateId: id },
    body: undefined,
  };
  return kind === "user-template"
    ? await accept(userClient().delete(args), [204])
    : await accept(presentationClient().delete(args), [204]);
}

function claimedFiles(
  fixture: Fixture,
  claim: RunnerClaim,
  kind: OwnerKind,
  id: string,
) {
  expect(claim.contentBundles.templates).toHaveLength(1);
  const bundle = claim.contentBundles.templates?.[0];
  if (!bundle) {
    throw new Error("Expected captured template guidance");
  }
  expect(bundle).toMatchObject({ ownerKind: kind, templateId: id });
  return readTemplateGuidanceBundle(
    fixture.readSignedObject(bundle.downloadUrl),
    {
      sha256: bundle.sha256,
      archiveBytes: bundle.archiveBytes,
    },
  ).map((file) => {
    return { path: file.path, content: file.content.toString("utf8") };
  });
}

describe.each(ownerKinds)("%s bundle publication", (kind) => {
  it.each([
    { framework: "claude-code", model: "claude-fable-5-1" },
    { framework: "codex", model: "gpt-6-luna" },
    { framework: "pi", model: "gpt-6-luna" },
  ] as const)(
    "uses current $framework guidance at Claim and rejects a deleted selected template",
    async ({ framework, model }) => {
      const owner = await publicChatActor(context);
      owner.ownsFeatureSwitches();
      await owner.run(async () => {
        await chat.configureSubscriptionPiModel(owner.actor);
        if (!owner.actor.orgId) {
          throw new Error("Expected a workspace owner");
        }
        await updateFeatureSwitchesForUser(
          context,
          { ...owner.actor, orgId: owner.actor.orgId },
          { [FeatureSwitchKey.CodexExecution]: framework === "codex" },
        );
      });
      const fixture = await owner.run(() => {
        return Promise.resolve(installS3Fixture(context));
      });
      const oldFiles = [
        ...guidance("A"),
        { path: "retired.txt", content: "Old only\n" },
      ];
      const published = await owner.run(async () => {
        return await publish(
          kind,
          await uploadInputs(owner.actor, fixture, tarGz(oldFiles)),
        );
      });
      if (published.status !== 200) {
        throw new Error("Expected a published template");
      }
      const id = published.body.id;
      const firstRun = await owner.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        model,
        prompt: "Use this template",
        template: selection(kind, id),
      });
      if (kind === "user-template") {
        await owner.run(async () => {
          const packageFileId = await uploadTemplateFile(
            context,
            owner.actor,
            fixture,
            {
              filename: "replacement.tar.gz",
              contentType: "application/gzip",
            },
            tarGz(guidance("B")),
          );
          await accept(
            userClient().replacePackage({
              headers: authHeaders(),
              params: { templateId: id },
              body: { packageFileId },
            }),
            [200],
          );
        });
      }
      const nextRun = await owner.sendChatRun(owner.actor, {
        agentId: owner.agentId,
        model,
        prompt: "Use the current template",
        template: selection(kind, id),
      });
      const first = await owner.claimChatRun(owner.runnerGroup, firstRun.runId);
      expect(first.claim.cliAgentType).toBe(framework);
      await owner.run(() => {
        return remove(kind, id);
      });
      // The already-claimed Run retains the package it received, even after deletion.
      expect(claimedFiles(fixture, first.claim, kind, id)).toStrictEqual(
        kind === "user-template" ? guidance("B") : oldFiles,
      );
      await owner.run(async () => {
        await chat.api.requestClaimRunnerJob(true, nextRun.runId, [404]);
        await expect(
          chat.api.readRun(owner.actor, nextRun.runId),
        ).resolves.toMatchObject({
          status: "pending",
        });
        await chat.api.requestCancelRun(owner.actor, nextRun.runId, [200]);
      });
    },
  );

  it("keeps an uncertain object publication out of the catalog and safely reuses its immutable bytes", async () => {
    const actor = bdd.user();
    mocks.clerk.session(actor.userId, actor.orgId);
    const fixture = installS3Fixture(context);
    const inputs = await uploadInputs(actor, fixture, tarGz(guidance("retry")));
    const send = context.mocks.s3.send.getMockImplementation()!;
    let lostResponse = false;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const result = await send(command);
      if (
        !lostResponse &&
        command instanceof PutObjectCommand &&
        command.input.Key?.startsWith("bundles/v1/")
      ) {
        lostResponse = true;
        throw new Error(
          "The object was stored but the provider response was lost",
        );
      }
      return result;
    });
    await publish(kind, inputs, 500);
    const listed =
      kind === "user-template"
        ? await accept(userClient().list({ headers: authHeaders() }), [200])
        : await accept(
            presentationClient().list({ headers: authHeaders() }),
            [200],
          );
    expect(listed.body).toStrictEqual([]);
    const retried = await publish(kind, inputs);
    expect(retried.status).toBe(200);
    const ready =
      kind === "user-template"
        ? await accept(userClient().list({ headers: authHeaders() }), [200])
        : await accept(
            presentationClient().list({ headers: authHeaders() }),
            [200],
          );
    expect(ready.body).toHaveLength(1);
  });
});

test("mounts both template owner kinds once when selections repeat", async () => {
  const owner = await publicChatActor(context);
  const fixture = await owner.run(() => {
    return Promise.resolve(installS3Fixture(context));
  });
  const selections: GenerationTemplateRequest[] = [];
  const expected = [];
  for (const kind of ownerKinds) {
    const files = guidance(kind);
    const published = await owner.run(async () => {
      return await publish(
        kind,
        await uploadInputs(owner.actor, fixture, tarGz(files)),
      );
    });
    if (published.status !== 200) {
      throw new Error("Expected a published template");
    }
    selections.push(selection(kind, published.body.id));
    expected.push({ ownerKind: kind, templateId: published.body.id, files });
  }
  const run = await owner.sendChatRun(owner.actor, {
    agentId: owner.agentId,
    model: "claude-fable-5-1",
    prompt: "Use both attached templates",
    userMessage: {
      version: 1,
      parts: [
        { type: "text", text: "Use both attached templates" },
        ...[...selections, ...selections].map((template) => {
          return {
            type: "template" as const,
            titleSnapshot: "Selected template",
            template,
          };
        }),
      ],
    },
  });
  const { claim } = await owner.claimChatRun(owner.runnerGroup, run.runId);
  expect(claim.contentBundles.templates).toHaveLength(expected.length);
  for (const item of expected) {
    const bundle = claim.contentBundles.templates?.find((candidate) => {
      return (
        candidate.ownerKind === item.ownerKind &&
        candidate.templateId === item.templateId
      );
    });
    if (!bundle) {
      throw new Error("Expected each selected template in the claim");
    }
    expect(
      readTemplateGuidanceBundle(fixture.readSignedObject(bundle.downloadUrl), {
        sha256: bundle.sha256,
        archiveBytes: bundle.archiveBytes,
      }).map((file) => {
        return { path: file.path, content: file.content.toString("utf8") };
      }),
    ).toStrictEqual(item.files);
  }
});

test("allows package replacement and retry after a completed metadata edit", async () => {
  const owner = await publicChatActor(context);
  const fixture = await owner.run(() => {
    return Promise.resolve(installS3Fixture(context));
  });
  const published = await owner.run(async () => {
    return await publish(
      "user-template",
      await uploadInputs(owner.actor, fixture, tarGz(guidance("A"))),
    );
  });
  if (published.status !== 200) {
    throw new Error("Expected a published template");
  }
  const id = published.body.id;
  await owner.run(async () => {
    const renamed = await accept(
      userClient().update({
        headers: authHeaders(),
        params: { templateId: id },
        body: {
          title: "Renamed before replacement",
          visibility: "organization",
        },
      }),
      [200],
    );
    const packageFileId = await uploadTemplateFile(
      context,
      owner.actor,
      fixture,
      { filename: "replacement.tar.gz", contentType: "application/gzip" },
      tarGz(guidance("B")),
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      const replaced = await accept(
        userClient().replacePackage({
          headers: authHeaders(),
          params: { templateId: id },
          body: { packageFileId },
        }),
        [200],
      );
      expect(replaced.body).toMatchObject({
        id,
        title: renamed.body.title,
        visibility: renamed.body.visibility,
      });
    }
    const retained = await accept(
      userClient().get({ headers: authHeaders(), params: { templateId: id } }),
      [200],
    );
    expect(retained.body).toMatchObject({
      title: "Renamed before replacement",
      visibility: "organization",
    });
  });
  const run = await owner.sendChatRun(owner.actor, {
    agentId: owner.agentId,
    model: "claude-fable-5-1",
    prompt: "Read the replacement after renaming",
    template: selection("user-template", id),
  });
  const claimed = await owner.claimChatRun(owner.runnerGroup, run.runId);
  expect(
    claimedFiles(fixture, claimed.claim, "user-template", id),
  ).toStrictEqual(guidance("B"));
});

test.each(["replacement", "metadata edit"] as const)(
  "does not overwrite a concurrent %s that published first",
  async (change) => {
    const owner = await publicChatActor(context);
    const fixture = await owner.run(() => {
      return Promise.resolve(installS3Fixture(context));
    });
    const published = await owner.run(async () => {
      return await publish(
        "user-template",
        await uploadInputs(owner.actor, fixture, tarGz(guidance("A"))),
      );
    });
    if (published.status !== 200) {
      throw new Error("Expected a published template");
    }
    const id = published.body.id;
    const replacements = await owner.run(async () => {
      const ids = [];
      for (const revision of ["stale", "winner"]) {
        ids.push(
          await uploadTemplateFile(
            context,
            owner.actor,
            fixture,
            { filename: `${revision}.tar.gz`, contentType: "application/gzip" },
            tarGz(guidance(revision)),
          ),
        );
      }
      return ids;
    });
    const entered = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const send = context.mocks.s3.send.getMockImplementation()!;
    let held = false;
    const pending = settleIncludingAbort(
      owner.run(() => {
        context.mocks.s3.send.mockImplementation(async (command: unknown) => {
          const result = await send(command);
          if (
            !held &&
            command instanceof PutObjectCommand &&
            command.input.Key?.startsWith("bundles/v1/")
          ) {
            held = true;
            entered.resolve();
            await release.promise;
          }
          return result;
        });
        return userClient().replacePackage({
          headers: authHeaders(),
          params: { templateId: id },
          body: { packageFileId: replacements[0]! },
        });
      }),
    );
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve();
      }
      await pending;
    });
    await entered.promise;
    const winner = await settleIncludingAbort(
      owner.run(async () => {
        mockNow(new Date(Date.parse(published.body.updatedAt) + 1000));
        if (change === "replacement") {
          await accept(
            userClient().replacePackage({
              headers: authHeaders(),
              params: { templateId: id },
              body: { packageFileId: replacements[1]! },
            }),
            [200],
          );
        } else {
          const renamed = await accept(
            userClient().update({
              headers: authHeaders(),
              params: { templateId: id },
              body: { title: "Renamed while publishing" },
            }),
            [200],
          );
          expect(renamed.body.title).toBe("Renamed while publishing");
        }
      }),
    );
    if (!release.settled()) {
      release.resolve();
    }
    if (!winner.ok) {
      throw winner.error;
    }
    const stale = await pending;
    if (!stale.ok) {
      throw stale.error;
    }
    expect(stale.value.status).toBe(409);
    const run = await owner.sendChatRun(owner.actor, {
      agentId: owner.agentId,
      model: "claude-fable-5-1",
      prompt: "Read the winning template",
      template: selection("user-template", id),
    });
    const claimed = await owner.claimChatRun(owner.runnerGroup, run.runId);
    expect(
      claimedFiles(fixture, claimed.claim, "user-template", id),
    ).toStrictEqual(guidance(change === "replacement" ? "winner" : "A"));
  },
);

test("delivers a valid template archive larger than the Skill bundle ceiling", async () => {
  const owner = await publicChatActor(context);
  const fixture = await owner.run(() => {
    return Promise.resolve(installS3Fixture(context));
  });
  const binary = randomBytes(17 * 1024 * 1024);
  const files = [
    ...guidance("large"),
    { path: "assets/first.bin", content: binary },
    { path: "assets/second.bin", content: randomBytes(binary.length) },
  ];
  const published = await owner.run(async () => {
    return await publish(
      "user-template",
      await uploadInputs(owner.actor, fixture, tarGz(files)),
    );
  });
  if (published.status !== 200) {
    throw new Error("Expected a published template");
  }
  const run = await owner.sendChatRun(owner.actor, {
    agentId: owner.agentId,
    model: "claude-fable-5-1",
    prompt: "Read the large template",
    template: selection("user-template", published.body.id),
  });
  const claimed = await owner.claimChatRun(owner.runnerGroup, run.runId);
  const bundle = claimed.claim.contentBundles.templates?.[0];
  if (!bundle) {
    throw new Error("Expected large template guidance");
  }
  expect(bundle.archiveBytes).toBeGreaterThan(32 * 1024 * 1024);
  const decoded = readTemplateGuidanceBundle(
    fixture.readSignedObject(bundle.downloadUrl),
    { sha256: bundle.sha256, archiveBytes: bundle.archiveBytes },
  );
  expect(
    decoded
      .find((file) => {
        return file.path === "assets/first.bin";
      })
      ?.content.equals(binary),
  ).toBeTruthy();
});

test("rejects conflicting file and directory names before publication", async () => {
  const actor = bdd.user();
  mocks.clerk.session(actor.userId, actor.orgId);
  const fixture = installS3Fixture(context);
  const inputs = await uploadInputs(
    actor,
    fixture,
    tarGz([
      ...guidance("invalid"),
      { path: "assets", content: "file" },
      { path: "assets/logo.png", content: "image" },
    ]),
  );
  const response = await accept(
    userClient().publish({
      headers: authHeaders(),
      body: { title: "Conflicting guidance", kind: "presentation", ...inputs },
    }),
    [400],
  );
  expect(response.body.error.message).toBe("Invalid template guidance package");
});
