import { randomUUID } from "node:crypto";
import { chatEventsContract } from "@okouai/api-contracts/contracts/chat-event-send";
import type { UserMessageInputDocument } from "@okouai/api-contracts/contracts/chat-threads";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { personalModelProvidersMainContract } from "@okouai/api-contracts/contracts/personal-model-providers";
import { presentationTemplatesContract } from "@okouai/api-contracts/contracts/presentation-templates";
import { userTemplatesContract } from "@okouai/api-contracts/contracts/user-templates";
import { formatUserPresentationTemplateId } from "@okouai/core/presentation-template-selection";
import { readTemplateGuidanceBundle } from "@okouai/core/template-guidance-bundle";
import { beforeAll, describe, expect, it, onTestFinished } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import {
  TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
  TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE,
} from "../../../__tests__/test-timeouts";
import { mockEnv, mockOptionalEnv, optionalEnv } from "../../../lib/env";
import { flushWaitUntilForTest } from "../../context/wait-until";
import { settleIncludingAbort } from "../../utils";
import { chatEventsRoutes } from "../chat-events";
import { featureSwitchesRoutes } from "../feature-switches";
import { meModelProvidersUpsertRoutes } from "../me-model-providers-upsert";
import { presentationTemplatesRoutes } from "../presentation-templates";
import { userTemplatesRoutes } from "../user-templates";
import { createBddApi, type ApiTestUser } from "./helpers/api-bdd";
import {
  makeCodexAuthJson,
  mockClaudeCodeTokenEndpoint,
} from "./helpers/api-bdd-auth-device";
import { createChatFilesBddApi } from "./helpers/api-bdd-chat-files";
import { createRunsApi } from "./helpers/api-bdd-runs";
import { createWebhookCallbackApi } from "./helpers/api-bdd-webhooks";
import { mockClerkUsers } from "./helpers/clerk-users";
import { createRouteMocks } from "./helpers/route-test";
import {
  installS3Fixture,
  tarGz,
  uploadTemplateFile,
  type Fixture,
} from "./helpers/template-publish-fixture";

const context = testContext();
const bdd = createBddApi(context);
const runs = createRunsApi(context);
const chat = createChatFilesBddApi(context);
const webhooks = createWebhookCallbackApi(context);

const PPTX =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const DOCX =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PNG = "image/png";
const GZIP = "application/gzip";
const SESSION_HEADERS = Object.freeze({
  authorization: "Bearer clerk-session",
});

const CLAUDE_MODEL = "claude-fable-5-1";

type PackageFileEntry = {
  readonly path: string;
  readonly content: string | Buffer;
};

interface TrackedRun {
  readonly actor: ApiTestUser;
  readonly runId: string;
  readonly sandboxToken: string;
  done: boolean;
}

describe("POST /api/user-templates", () => {
  it("template-guidance-publication-027 rejects conflicting file and directory names before publication", async () => {
    const fixture = installS3Fixture(context);
    const member = bdd.user();

    const sourceFileId = await uploadTemplateFile(
      context,
      member,
      fixture,
      { filename: "deck.pptx", contentType: PPTX },
      Buffer.from("deck"),
    );
    const pageFileId = await uploadTemplateFile(
      context,
      member,
      fixture,
      { filename: "page-1.png", contentType: PNG },
      Buffer.from("png-1"),
    );
    const packageFileId = await uploadTemplateFile(
      context,
      member,
      fixture,
      { filename: "package.tar.gz", contentType: GZIP },
      tarGz([
        { path: "SKILL.md", content: "# Deck guidance" },
        { path: "design-system.md", content: "Use the brand palette." },
        { path: "assets", content: "conflicting file" },
        { path: "assets/logo.png", content: Buffer.from("png-logo") },
      ]),
    );

    createRouteMocks(context).clerk.session(
      member.userId,
      member.orgId,
      member.orgRole,
    );
    const response = await accept(
      setupApp({ context, routes: userTemplatesRoutes })(
        userTemplatesContract,
      ).publish({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          kind: "presentation",
          title: "Conflicting package",
          sourceFileId,
          pageFileIds: [pageFileId],
          packageFileId,
        },
      }),
      [400],
    );

    expect(response.body.error.message).toBe(
      "Invalid template guidance package",
    );
  });
});

describe("template guidance publication in Runs", () => {
  beforeAll(async () => {
    await settleIncludingAbort(async () => {
      const warmupUser = createBddApi(context).user();
      await runs.grantProEntitlement(warmupUser);
      await runs.configureRunnerGroup();
    });
  });

  function signIn(actor: ApiTestUser) {
    createRouteMocks(context).clerk.session(
      actor.userId,
      actor.orgId,
      actor.orgRole,
    );
    const emailId = `email_${actor.userId}`;
    mockClerkUsers(context, [
      {
        id: actor.userId,
        emailAddresses: [{ id: emailId, emailAddress: actor.email }],
        primaryEmailAddressId: emailId,
        firstName: "Template",
        lastName: "Owner",
      },
    ]);
    const memberships = actor.orgId
      ? [
          {
            id: `membership-${actor.userId}-${actor.orgId}`,
            createdAt: Date.parse("2020-01-01T00:00:00.000Z"),
            role: actor.orgRole ?? "org:admin",
            organization: { id: actor.orgId },
            publicUserData: { userId: actor.userId },
          },
        ]
      : [];
    context.mocks.clerk.users.getOrganizationMembershipList.mockResolvedValue({
      data: memberships,
    });
    context.mocks.clerk.organizations.getOrganizationMembershipList.mockResolvedValue(
      { data: memberships },
    );
    return SESSION_HEADERS;
  }

  function userTemplatesApi() {
    return setupApp({ context, routes: userTemplatesRoutes })(
      userTemplatesContract,
    );
  }

  function presentationTemplatesApi() {
    return setupApp({ context, routes: presentationTemplatesRoutes })(
      presentationTemplatesContract,
    );
  }

  function featureSwitchesApi() {
    return setupApp({ context, routes: featureSwitchesRoutes })(
      featureSwitchesContract,
    );
  }

  function personalProvidersApi() {
    return setupApp({ context, routes: meModelProvidersUpsertRoutes })(
      personalModelProvidersMainContract,
    );
  }

  function chatEventsApi() {
    return setupApp({ context, routes: chatEventsRoutes })(chatEventsContract);
  }

  function createRunTracker() {
    const tracked: TrackedRun[] = [];
    const previousCap = optionalEnv("CONCURRENT_RUN_LIMIT_CAP");

    onTestFinished(async () => {
      context.mocks.ably.publish.mockResolvedValue(undefined);
      runs.acceptTelemetryIngest();
      const errors: unknown[] = [];
      const initialFlush = await settleIncludingAbort(flushWaitUntilForTest);
      if (!initialFlush.ok) {
        errors.push(initialFlush.error);
      }
      for (const entry of tracked) {
        if (entry.done) {
          continue;
        }
        const cleaned = await settleIncludingAbort(async () => {
          await runs.requestCancelRun(entry.actor, entry.runId, [200, 400]);
          await webhooks.requestAgentComplete(
            { runId: entry.runId, exitCode: 1, error: "Run cancelled" },
            { authorization: `Bearer ${entry.sandboxToken}` },
            [200, 400],
          );
          entry.done = true;
        });
        if (!cleaned.ok) {
          errors.push(cleaned.error);
        }
      }
      const finalFlush = await settleIncludingAbort(flushWaitUntilForTest);
      if (!finalFlush.ok) {
        errors.push(finalFlush.error);
      }
      mockOptionalEnv("CONCURRENT_RUN_LIMIT_CAP", previousCap);
      if (errors.length === 1) {
        throw errors[0];
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Template guidance Run cleanup failed",
        );
      }
    });

    return {
      track(
        actor: ApiTestUser,
        runId: string,
        sandboxToken: string,
      ): TrackedRun {
        const entry: TrackedRun = { actor, runId, sandboxToken, done: false };
        tracked.push(entry);
        return entry;
      },
      async finishRun(entry: TrackedRun): Promise<void> {
        if (entry.done) {
          return;
        }
        await runs.requestCancelRun(entry.actor, entry.runId, [200, 400]);
        await webhooks.requestAgentComplete(
          { runId: entry.runId, exitCode: 1, error: "Run cancelled" },
          { authorization: `Bearer ${entry.sandboxToken}` },
          [200, 400],
        );
        entry.done = true;
        await flushWaitUntilForTest();
      },
    };
  }

  function readTemplateFiles(
    fixture: Fixture,
    bundle: {
      readonly sha256: string;
      readonly archiveBytes: number;
      readonly downloadUrl: string;
    },
  ): Record<string, string> {
    const archive = fixture.readSignedObject(bundle.downloadUrl);
    const decoded = readTemplateGuidanceBundle(archive, {
      sha256: bundle.sha256,
      archiveBytes: bundle.archiveBytes,
    });
    return Object.fromEntries(
      decoded.map((file) => {
        return [file.path, file.content.toString("utf8")];
      }),
    );
  }

  async function publishUserPresentationTemplate(
    actor: ApiTestUser,
    fixture: Fixture,
    title: string,
    files: readonly PackageFileEntry[],
  ) {
    const sourceFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "deck.pptx", contentType: PPTX },
      Buffer.from("deck-bytes"),
    );
    const pageFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "page-1.png", contentType: PNG },
      Buffer.from("png-1"),
    );
    const packageFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: GZIP },
      tarGz(files),
    );
    const published = await accept(
      userTemplatesApi().publish({
        headers: signIn(actor),
        body: {
          kind: "presentation",
          title,
          sourceFileId,
          pageFileIds: [pageFileId],
          packageFileId,
        },
      }),
      [200],
    );
    return published.body;
  }

  async function publishPresentationTemplate(
    actor: ApiTestUser,
    fixture: Fixture,
    title: string,
    files: readonly PackageFileEntry[],
  ) {
    const sourceFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "deck.pptx", contentType: PPTX },
      Buffer.from("deck-bytes"),
    );
    const pageFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "page-1.png", contentType: PNG },
      Buffer.from("png-1"),
    );
    const packageFileId = await uploadTemplateFile(
      context,
      actor,
      fixture,
      { filename: "package.tar.gz", contentType: GZIP },
      tarGz(files),
    );
    const published = await accept(
      presentationTemplatesApi().publish({
        headers: signIn(actor),
        body: {
          title,
          sourceFileId,
          pageFileIds: [pageFileId],
          packageFileId,
        },
      }),
      [200],
    );
    return published.body;
  }

  async function setupMember(
    options: {
      readonly orgId?: string;
      readonly includeClaude?: boolean;
      readonly includeCodex?: boolean;
      readonly featureSwitches?: Readonly<Record<string, boolean>>;
      readonly maxConcurrent?: number;
    } = {},
  ) {
    const tracker = createRunTracker();
    const fixture = installS3Fixture(context);
    const actor = bdd.user({ orgId: options.orgId });

    runs.acceptTelemetryIngest();
    mockOptionalEnv("OPENROUTER_API_KEY", undefined);
    if (options.includeClaude !== false) {
      mockClaudeCodeTokenEndpoint();
    }

    const group = await runs.configureRunnerGroup({
      maxConcurrent: options.maxConcurrent ?? 4,
    });
    await runs.grantProEntitlement(actor);

    if (options.includeClaude !== false) {
      await accept(
        personalProvidersApi().upsert({
          headers: signIn(actor),
          body: {
            type: "claude-code-oauth-token",
            secret: `claude-token-${randomUUID()}`,
          },
        }),
        [201],
      );
    }
    if (options.includeCodex) {
      await accept(
        personalProvidersApi().upsert({
          headers: signIn(actor),
          body: {
            type: "codex-oauth-token",
            authMethod: "auth_json",
            secrets: { CODEX_AUTH_JSON: makeCodexAuthJson() },
          },
        }),
        [201],
      );
    }
    if (options.featureSwitches) {
      await accept(
        featureSwitchesApi().update({
          headers: signIn(actor),
          body: { switches: options.featureSwitches },
        }),
        [200],
      );
    }

    async function sendTemplateRun(args: {
      readonly prompt: string;
      readonly model: string;
      readonly userMessage: UserMessageInputDocument;
      readonly threadId?: string;
    }) {
      const clientEventId = randomUUID();
      const sent = await accept(
        chatEventsApi().send({
          headers: signIn(actor),
          body: {
            prompt: args.prompt,
            hasTextContent: true,
            clientEventId,
            model: args.model,
            ...(args.threadId === undefined ? {} : { threadId: args.threadId }),
            userMessage: args.userMessage,
          },
        }),
        [201],
      );
      await flushWaitUntilForTest();
      const { events } = await chat.listThreadEvents(actor, sent.body.threadId);
      const launched = events.find((event) => {
        return (
          event.eventType === "input.prompt" &&
          event.revokesEventId === clientEventId &&
          event.runId !== undefined
        );
      });
      if (!launched?.runId) {
        throw new Error("Expected template chat send to launch a Run");
      }
      const execution = await runs.executionInput(launched.runId);
      const entry = tracker.track(
        actor,
        launched.runId,
        execution.sandboxToken,
      );
      return {
        threadId: sent.body.threadId,
        runId: launched.runId,
        execution,
        entry,
        events,
      };
    }

    return { actor, fixture, group, tracker, sendTemplateRun };
  }

  function userTemplateMessage(
    prompt: string,
    userTemplateId: string,
  ): UserMessageInputDocument {
    return {
      version: 1,
      parts: [
        { type: "text", text: prompt },
        {
          type: "template",
          titleSnapshot: "Custom template",
          template: {
            type: "custom",
            selection: { userTemplateId },
          },
        },
      ],
    };
  }

  function presentationTemplateMessage(
    prompt: string,
    templateId: string,
  ): UserMessageInputDocument {
    return {
      version: 1,
      parts: [
        { type: "text", text: prompt },
        {
          type: "template",
          titleSnapshot: "Imported presentation",
          template: {
            type: "presentation",
            selection: {
              templateId: formatUserPresentationTemplateId(templateId),
            },
          },
        },
      ],
    };
  }

  async function verifyFifoHeadTemplate(
    kind: "user-template" | "presentation-template",
  ) {
    const { actor, fixture, tracker, sendTemplateRun } = await setupMember({
      maxConcurrent: 4,
    });
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", 1);

    const headFiles = [
      { path: "SKILL.md", content: "# Head template guidance" },
      { path: "design-system.md", content: "Head palette." },
    ] as const;
    const laterFiles = [
      { path: "SKILL.md", content: "# Later template guidance" },
      { path: "design-system.md", content: "Later palette." },
    ] as const;

    const headTemplate =
      kind === "user-template"
        ? await publishUserPresentationTemplate(
            actor,
            fixture,
            "Head template",
            headFiles,
          )
        : await publishPresentationTemplate(
            actor,
            fixture,
            "Head template",
            headFiles,
          );
    const laterTemplate =
      kind === "user-template"
        ? await publishUserPresentationTemplate(
            actor,
            fixture,
            "Later template",
            laterFiles,
          )
        : await publishPresentationTemplate(
            actor,
            fixture,
            "Later template",
            laterFiles,
          );

    // Occupy the single concurrent slot with a blocker Run on another thread.
    await sendTemplateRun({
      prompt: "Hold the single concurrency slot",
      model: CLAUDE_MODEL,
      userMessage: {
        version: 1,
        parts: [{ type: "text", text: "Hold the single concurrency slot" }],
      },
    });

    const headClientEventId = randomUUID();
    const headUserMessage =
      kind === "user-template"
        ? userTemplateMessage("Use the head template", headTemplate.id)
        : presentationTemplateMessage("Use the head template", headTemplate.id);
    const queuedHead = await accept(
      chatEventsApi().send({
        headers: signIn(actor),
        body: {
          prompt: "Use the head template",
          hasTextContent: true,
          clientEventId: headClientEventId,
          model: CLAUDE_MODEL,
          userMessage: headUserMessage,
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();
    const targetThreadId = queuedHead.body.threadId;

    // Raise capacity without triggering a pick yet.
    mockEnv("CONCURRENT_RUN_LIMIT_CAP", 4);

    const laterClientEventId = randomUUID();
    const laterUserMessage =
      kind === "user-template"
        ? userTemplateMessage("Use the later template", laterTemplate.id)
        : presentationTemplateMessage(
            "Use the later template",
            laterTemplate.id,
          );
    await accept(
      chatEventsApi().send({
        headers: signIn(actor),
        body: {
          threadId: targetThreadId,
          prompt: "Use the later template",
          hasTextContent: true,
          clientEventId: laterClientEventId,
          model: CLAUDE_MODEL,
          userMessage: laterUserMessage,
        },
      }),
      [201],
    );
    await flushWaitUntilForTest();

    const afterLaterSend = await chat.listThreadEvents(actor, targetThreadId);
    const headLaunched = afterLaterSend.events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === headClientEventId &&
        event.runId !== undefined
      );
    });
    if (!headLaunched?.runId) {
      throw new Error("Expected FIFO head template input to launch first");
    }
    const headExecution = await runs.executionInput(headLaunched.runId);
    const headEntry = tracker.track(
      actor,
      headLaunched.runId,
      headExecution.sandboxToken,
    );
    const headBundles =
      headExecution.startupInputs.contentBundles.templates ?? [];
    expect(headBundles).toHaveLength(1);
    const headBundle = headBundles[0];
    if (!headBundle) {
      throw new Error("Expected head Run template bundle");
    }
    expect(readTemplateFiles(fixture, headBundle)).toStrictEqual({
      "SKILL.md": "# Head template guidance",
      "design-system.md": "Head palette.",
    });

    await tracker.finishRun(headEntry);

    const afterCancel = await chat.listThreadEvents(actor, targetThreadId);
    const laterLaunched = afterCancel.events.find((event) => {
      return (
        event.eventType === "input.prompt" &&
        event.revokesEventId === laterClientEventId &&
        event.runId !== undefined
      );
    });
    if (!laterLaunched?.runId) {
      throw new Error("Expected later template input to launch after cancel");
    }
    const laterExecution = await runs.executionInput(laterLaunched.runId);
    tracker.track(actor, laterLaunched.runId, laterExecution.sandboxToken);
    const laterBundles =
      laterExecution.startupInputs.contentBundles.templates ?? [];
    expect(laterBundles).toHaveLength(1);
    const laterBundle = laterBundles[0];
    if (!laterBundle) {
      throw new Error("Expected later Run template bundle");
    }
    expect(readTemplateFiles(fixture, laterBundle)).toStrictEqual({
      "SKILL.md": "# Later template guidance",
      "design-system.md": "Later palette.",
    });
  }

  it(
    "template-guidance-publication-011 user-template uses the FIFO head template when a later send supplies a different prefetch candidate",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      await expect(
        verifyFifoHeadTemplate("user-template"),
      ).resolves.toBeUndefined();
    },
  );

  it(
    "template-guidance-publication-016 presentation-template uses the FIFO head template when a later send supplies a different prefetch candidate",
    { timeout: TEST_WITH_TRIPLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      await expect(
        verifyFifoHeadTemplate("presentation-template"),
      ).resolves.toBeUndefined();
    },
  );

  it(
    "template-guidance-publication-022 mounts every user-template kind and presentation guidance once in selection order",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, fixture, sendTemplateRun } = await setupMember();

      const presUserFiles = [
        { path: "SKILL.md", content: "# User presentation template" },
        { path: "design-system.md", content: "User deck tokens." },
      ] as const;
      const presLegacyFiles = [
        { path: "SKILL.md", content: "# Presentation template" },
        { path: "design-system.md", content: "Imported deck tokens." },
      ] as const;
      const docFiles = [
        { path: "SKILL.md", content: "# Document template" },
        { path: "reference.txt", content: "Document reference." },
      ] as const;
      const illusFiles = [
        { path: "SKILL.md", content: "# Illustration template" },
        { path: "style.txt", content: "Ink linework." },
      ] as const;

      const presUser = await publishUserPresentationTemplate(
        actor,
        fixture,
        "User deck",
        presUserFiles,
      );
      const presLegacy = await publishPresentationTemplate(
        actor,
        fixture,
        "Imported deck",
        presLegacyFiles,
      );

      const docSourceId = await uploadTemplateFile(
        context,
        actor,
        fixture,
        { filename: "brief.docx", contentType: DOCX },
        Buffer.from("docx-bytes"),
      );
      const docPackageId = await uploadTemplateFile(
        context,
        actor,
        fixture,
        { filename: "doc-package.tar.gz", contentType: GZIP },
        tarGz(docFiles),
      );
      const docTemplate = await accept(
        userTemplatesApi().publish({
          headers: signIn(actor),
          body: {
            kind: "document",
            title: "Doc template",
            sourceFileId: docSourceId,
            packageFileId: docPackageId,
          },
        }),
        [200],
      );

      const illusSourceId = await uploadTemplateFile(
        context,
        actor,
        fixture,
        { filename: "style.png", contentType: PNG },
        Buffer.from("style-png"),
      );
      const illusExampleId = await uploadTemplateFile(
        context,
        actor,
        fixture,
        { filename: "example.png", contentType: PNG },
        Buffer.from("example-png"),
      );
      const illusPackageId = await uploadTemplateFile(
        context,
        actor,
        fixture,
        { filename: "illus-package.tar.gz", contentType: GZIP },
        tarGz(illusFiles),
      );
      const illusTemplate = await accept(
        userTemplatesApi().publish({
          headers: signIn(actor),
          body: {
            kind: "illustration",
            title: "Illustration template",
            sourceFileId: illusSourceId,
            exampleFileIds: [illusExampleId],
            packageFileId: illusPackageId,
          },
        }),
        [200],
      );

      const orderedSelectionParts: UserMessageInputDocument["parts"] = [
        { type: "text", text: "Combine all four templates" },
        {
          type: "template",
          titleSnapshot: "Doc template",
          template: {
            type: "custom",
            selection: { userTemplateId: docTemplate.body.id },
          },
        },
        {
          type: "template",
          titleSnapshot: "Illustration template",
          template: {
            type: "custom",
            selection: { userTemplateId: illusTemplate.body.id },
          },
        },
        {
          type: "template",
          titleSnapshot: "User deck",
          template: {
            type: "custom",
            selection: { userTemplateId: presUser.id },
          },
        },
        {
          type: "template",
          titleSnapshot: "Imported deck",
          template: {
            type: "presentation",
            selection: {
              templateId: formatUserPresentationTemplateId(presLegacy.id),
            },
          },
        },
      ];

      const launched = await sendTemplateRun({
        prompt: "Combine all four templates",
        model: CLAUDE_MODEL,
        userMessage: {
          version: 1,
          parts: [...orderedSelectionParts, ...orderedSelectionParts.slice(1)],
        },
      });

      const bundles =
        launched.execution.startupInputs.contentBundles.templates ?? [];
      expect(bundles).toHaveLength(4);

      const userBundles = bundles.filter((entry) => {
        return entry.ownerKind === "user-template";
      });
      expect(
        userBundles.map((entry) => {
          return entry.templateId;
        }),
      ).toStrictEqual([
        docTemplate.body.id,
        illusTemplate.body.id,
        presUser.id,
      ]);

      const expectedByTemplateId = new Map<string, Record<string, string>>([
        [
          presLegacy.id,
          {
            "SKILL.md": "# Presentation template",
            "design-system.md": "Imported deck tokens.",
          },
        ],
        [
          docTemplate.body.id,
          {
            "SKILL.md": "# Document template",
            "reference.txt": "Document reference.",
          },
        ],
        [
          illusTemplate.body.id,
          {
            "SKILL.md": "# Illustration template",
            "style.txt": "Ink linework.",
          },
        ],
        [
          presUser.id,
          {
            "SKILL.md": "# User presentation template",
            "design-system.md": "User deck tokens.",
          },
        ],
      ]);

      for (const bundle of bundles) {
        expect(readTemplateFiles(fixture, bundle)).toStrictEqual(
          expectedByTemplateId.get(bundle.templateId),
        );
      }
    },
  );

  it(
    "template-guidance-publication-023 allows package replacement and retry after a completed metadata edit",
    { timeout: TEST_WITH_SINGLE_RUN_LEGACY_TIMEOUT_DO_NOT_INCREASE },
    async () => {
      const { actor, fixture, sendTemplateRun } = await setupMember();

      const published = await publishUserPresentationTemplate(
        actor,
        fixture,
        "Initial template",
        [
          { path: "SKILL.md", content: "# Guidance A" },
          { path: "design-system.md", content: "Palette A." },
        ],
      );

      await accept(
        userTemplatesApi().update({
          headers: signIn(actor),
          params: { templateId: published.id },
          body: {
            title: "Renamed before replacement",
            visibility: "organization",
          },
        }),
        [200],
      );

      const packageBId = await uploadTemplateFile(
        context,
        actor,
        fixture,
        { filename: "package-b.tar.gz", contentType: GZIP },
        tarGz([
          { path: "SKILL.md", content: "# Guidance B" },
          { path: "design-system.md", content: "Palette B." },
        ]),
      );

      const firstReplace = await accept(
        userTemplatesApi().replacePackage({
          headers: signIn(actor),
          params: { templateId: published.id },
          body: { packageFileId: packageBId },
        }),
        [200],
      );
      const secondReplace = await accept(
        userTemplatesApi().replacePackage({
          headers: signIn(actor),
          params: { templateId: published.id },
          body: { packageFileId: packageBId },
        }),
        [200],
      );

      for (const replaced of [firstReplace.body, secondReplace.body]) {
        expect(replaced).toMatchObject({
          id: published.id,
          title: "Renamed before replacement",
          visibility: "organization",
        });
      }

      const detail = await accept(
        userTemplatesApi().get({
          headers: signIn(actor),
          params: { templateId: published.id },
        }),
        [200],
      );
      expect(detail.body).toMatchObject({
        id: published.id,
        title: "Renamed before replacement",
        visibility: "organization",
      });

      const launched = await sendTemplateRun({
        prompt: "Run with replaced guidance B",
        model: CLAUDE_MODEL,
        userMessage: userTemplateMessage(
          "Run with replaced guidance B",
          published.id,
        ),
      });

      const bundles =
        launched.execution.startupInputs.contentBundles.templates ?? [];
      expect(bundles).toHaveLength(1);
      const bundle = bundles[0];
      if (!bundle) {
        throw new Error("Expected replaced template bundle");
      }
      expect(readTemplateFiles(fixture, bundle)).toStrictEqual({
        "SKILL.md": "# Guidance B",
        "design-system.md": "Palette B.",
      });
    },
  );
});
