import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { featureSwitchesContract } from "@okouai/api-contracts/contracts/feature-switches";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  halloweenContract,
  halloweenOperationsContract,
  type HalloweenRound,
} from "@okouai/api-contracts/contracts/halloween";
import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { createUniqueStaffOrgIdFixture } from "../../../test-fixtures/staff-org";
import { halloweenRoutes } from "../halloween";
import { halloweenOperationsRoutes } from "../halloween-operations";
import { featureSwitchesRoutes } from "../feature-switches";
import { createRouteMocks } from "./helpers/route-test";

const context = testContext();
const mocks = createRouteMocks(context);
const headers = Object.freeze({ authorization: "Bearer clerk-session" });
// Independent answer key from Rebecca's approved sheet, in question-ID order.
const answers = "CBACBACBACBACBACBAABCABCABCABCABCCABCABCABCABCABCABA";
function correctOption(round: HalloweenRound) {
  const question = round.question!;
  return answers[Number(question.id.slice(-2)) - 1]!;
}
function roundReference(round: HalloweenRound) {
  return { id: round.id };
}
function clients(app: Awaited<ReturnType<typeof setupApp>>) {
  return {
    game: app(halloweenContract),
    operations: app(halloweenOperationsContract),
  };
}
function actor(staff = true) {
  const userId = `user_${randomUUID()}`;
  const orgId = staff ? createUniqueStaffOrgIdFixture() : `org_${randomUUID()}`;
  mocks.clerk.session(userId, orgId);
  context.mocks.clerk.users.getUser.mockResolvedValue({
    id: userId,
    firstName: "Quiz",
    lastName: "Player",
    primaryEmailAddressId: "email",
    emailAddresses: [{ id: "email", emailAddress: `${userId}@example.com` }],
    privateMetadata: {},
    publicMetadata: {},
  });
  return { userId, orgId };
}
beforeEach(() => {
  mockNow(new Date("2026-10-30T12:00:00Z"));
  actor();
});

async function getFinale(game: Awaited<ReturnType<typeof clients>>["game"]) {
  let round = (
    await accept(game.start({ headers, body: { restart: false } }), [200])
  ).body;
  const body = roundReference(round);
  const questions = new Set<string>();
  for (let i = 0; i < 4; i++) {
    expect(round.questionNumber).toBe(i + 1);
    expect(round.question?.id).not.toBe("QUIZ-53");
    questions.add(round.question!.id);
    expect(JSON.stringify(round.question)).not.toContain("correct");
    const questionId = round.question!.id;
    round = (
      await accept(
        game.answer({
          headers,
          body: { ...body, questionId, optionId: correctOption(round) },
        }),
        [200],
      )
    ).body;
    expect(round.correct).toBe(i + 1);
    expect(round.feedback?.correct).toBeTruthy();
    expect(round.question!.id).toBe(questionId);
    round = (
      await accept(game.next({ headers, body: { ...body, questionId } }), [200])
    ).body;
  }
  expect(questions.size).toBe(4);
  expect(round.question?.id).toBe("QUIZ-53");
  return { body, round };
}

describe("Halloween quiz", () => {
  it.each(["A", "B", "C"])(
    "accepts finale %s and requires explicit result confirmation",
    async (optionId) => {
      const { game } = clients(
        setupApp({
          context,
          routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
        }),
      );
      const { body } = await getFinale(game);
      const answerBody = { ...body, questionId: "QUIZ-53", optionId };
      const responses = await Promise.all([
        game.answer({ headers, body: answerBody }),
        game.answer({ headers, body: answerBody }),
      ]);
      for (const response of responses) {
        expect(response).toMatchObject({
          status: 200,
          body: { correct: 5, outcome: "playing", completedAt: null },
        });
      }
      const { body: success } = await accept(
        game.next({ headers, body: { ...body, questionId: "QUIZ-53" } }),
        [200],
      );
      expect(success.outcome).toBe("success");
      expect(success.completedAt).toBeTruthy();
      expect(
        (await accept(game.current({ headers }), [200])).body,
      ).toStrictEqual(success);
      expect(
        (await accept(game.start({ headers, body: { restart: false } }), [200]))
          .body,
      ).toStrictEqual(success);
      const replayed = await accept(
        game.start({ headers, body: { restart: true } }),
        [200],
      );
      expect(replayed.body).toMatchObject({
        outcome: "playing",
        questionNumber: 1,
      });
      expect(replayed.body.id).not.toBe(success.id);
      const left = await accept(game.leave({ headers, body }), [200]);
      expect(left.body).toStrictEqual(success);
    },
  );

  it("restores account progress until an explicit restart", async () => {
    const { game } = clients(
      setupApp({
        context,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    const original = await accept(
      game.start({ headers, body: { restart: false } }),
      [200],
    );
    const body = roundReference(original.body);
    expect((await accept(game.current({ headers }), [200])).body).toStrictEqual(
      original.body,
    );
    const answered = await accept(
      game.answer({
        headers,
        body: {
          ...body,
          questionId: original.body.question!.id,
          optionId: correctOption(original.body),
        },
      }),
      [200],
    );
    const advanced = await accept(
      game.next({
        headers,
        body: { ...body, questionId: answered.body.question!.id },
      }),
      [200],
    );
    expect(advanced.body.questionNumber).toBe(2);
    expect(
      (await accept(game.start({ headers, body: { restart: false } }), [200]))
        .body,
    ).toStrictEqual(advanced.body);
    const restarted = await accept(
      game.start({ headers, body: { restart: true } }),
      [200],
    );
    expect(restarted.body).toMatchObject({
      outcome: "playing",
      questionNumber: 1,
    });
    expect(restarted.body.id).not.toBe(original.body.id);
    actor();
    await accept(game.current({ headers }), [404]);
    await accept(
      game.leave({
        headers,
        body: roundReference(restarted.body),
      }),
      [404],
    );
  });

  it("locks a wrong answer and prevents regrading or advancing", async () => {
    const { game } = clients(
      setupApp({
        context,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    const { body: round } = await accept(
      game.start({ headers, body: { restart: false } }),
      [200],
    );
    const body = roundReference(round);
    const questionId = round.question!.id;
    const wrong = round.question!.options.find((o) => {
      return o.id !== correctOption(round);
    })!;
    const { body: failed } = await accept(
      game.answer({
        headers,
        body: { ...body, questionId, optionId: wrong.id },
      }),
      [200],
    );
    expect(failed).toMatchObject({
      outcome: "wrong",
      correct: 0,
      question: null,
    });
    expect(
      (
        await accept(
          game.answer({
            headers,
            body: { ...body, questionId, optionId: correctOption(round) },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual(failed);
    expect(
      (
        await accept(
          game.next({ headers, body: { ...body, questionId } }),
          [200],
        )
      ).body,
    ).toStrictEqual(failed);
  });

  it("uses the feature switch as the only availability gate for signed-in users", async () => {
    const app = setupApp({
      context,
      routes: [
        ...halloweenRoutes,
        ...halloweenOperationsRoutes,
        ...featureSwitchesRoutes,
      ],
    });
    const { game } = clients(app);
    const switches = app(featureSwitchesContract);
    actor(false);
    let activeRound: HalloweenRound | null = null;
    for (const now of ["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z"]) {
      mockNow(new Date(now));
      expect(
        (await accept(game.status({ headers }), [200])).body,
      ).toStrictEqual({ phase: "open" });
      activeRound = (
        await accept(game.start({ headers, body: { restart: true } }), [200])
      ).body;
    }
    if (!activeRound?.question) {
      throw new Error("Expected an active Halloween round");
    }

    await accept(
      switches.update({
        headers,
        body: { switches: { [FeatureSwitchKey.HalloweenQuiz]: false } },
      }),
      [200],
    );
    expect((await accept(game.status({ headers }), [200])).body).toStrictEqual({
      phase: "unavailable",
    });
    await accept(game.current({ headers }), [409]);
    await accept(game.start({ headers, body: { restart: false } }), [409]);
    const unavailable = {
      status: 409,
      body: {
        error: {
          code: "CONFLICT",
          message: "This Halloween quiz is not open",
        },
      },
    };
    await expect(
      game.answer({
        headers,
        body: {
          ...roundReference(activeRound),
          questionId: activeRound.question.id,
          optionId: correctOption(activeRound),
        },
      }),
    ).resolves.toMatchObject(unavailable);
    await expect(
      game.next({
        headers,
        body: {
          ...roundReference(activeRound),
          questionId: activeRound.question.id,
        },
      }),
    ).resolves.toMatchObject(unavailable);
    await expect(
      game.leave({ headers, body: roundReference(activeRound) }),
    ).resolves.toMatchObject(unavailable);

    await accept(switches.delete({ headers }), [200]);
    expect((await accept(game.current({ headers }), [200])).body).toStrictEqual(
      activeRound,
    );
  });

  it("requires authentication for every gameplay endpoint", async () => {
    const { game } = clients(
      setupApp({
        context,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    const body = { id: randomUUID() };
    const status = await accept(game.status({ headers: {} }), [401]);
    expect(status.status).toBe(401);
    await accept(game.current({ headers: {} }), [401]);
    await accept(game.start({ headers: {}, body: { restart: false } }), [401]);
    await accept(
      game.answer({
        headers: {},
        body: { ...body, questionId: "QUIZ-01", optionId: "A" },
      }),
      [401],
    );
    await accept(
      game.next({
        headers: {},
        body: { ...body, questionId: "QUIZ-01" },
      }),
      [401],
    );
    await accept(game.leave({ headers: {}, body }), [401]);
  });

  it("exports immutable deduplicated staff batches without losing prior round history", async () => {
    const { game, operations } = clients(
      await setupApp({
        context,
        isolatePg: true,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    mockNow(new Date("2026-01-01T00:00:00Z"));
    for (let index = 0; index < 2; index++) {
      const started = await accept(
        game.start({ headers, body: { restart: true } }),
        [200],
      );
      const left = await accept(
        game.leave({ headers, body: roundReference(started.body) }),
        [200],
      );
      expect(left.body.outcome).toBe("left");
    }
    const batchId = randomUUID();
    const first = await accept(
      operations.capture({ headers, body: { id: batchId } }),
      [200],
    );
    expect(first.body.participants).toHaveLength(1);
    expect(first.body.participants[0]?.rounds).toHaveLength(2);
    const originalUser = first.body.participants[0]!.userId;
    await accept(
      operations.review({
        headers,
        body: { batchId, userId: originalUser, decision: "winner" },
      }),
      [200],
    );
    const later = await accept(
      game.start({ headers, body: { restart: true } }),
      [200],
    );
    await accept(
      game.leave({
        headers,
        body: roundReference(later.body),
      }),
      [200],
    );
    expect(
      (
        await accept(
          operations.capture({ headers, body: { id: batchId } }),
          [200],
        )
      ).body,
    ).toStrictEqual(first.body);
    const next = await accept(
      operations.capture({ headers, body: { id: randomUUID() } }),
      [200],
    );
    expect(next.body.participants[0]).toMatchObject({
      decision: "winner",
      rounds: expect.any(Array),
    });
    expect(next.body.participants[0]?.rounds).toHaveLength(3);
    actor(false);
    await accept(operations.batch({ headers, params: { id: batchId } }), [403]);
    await accept(
      operations.capture({ headers, body: { id: randomUUID() } }),
      [403],
    );
  });
});
