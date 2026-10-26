import { randomBytes, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
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
function credential() {
  return { id: randomUUID(), token: randomBytes(32).toString("hex") };
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

async function getFinale(
  game: Awaited<ReturnType<typeof clients>>["game"],
  body: ReturnType<typeof credential>,
) {
  let round = (await accept(game.start({ headers, body }), [200])).body;
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
          body: { ...body, questionId, optionId: correctOption(round) },
        }),
        [200],
      )
    ).body;
    expect(round.correct).toBe(i + 1);
    expect(round.feedback?.correct).toBeTruthy();
    expect(round.question!.id).toBe(questionId);
    round = (await accept(game.next({ body: { ...body, questionId } }), [200]))
      .body;
  }
  expect(questions.size).toBe(4);
  expect(round.question?.id).toBe("QUIZ-53");
  return round;
}

describe("Halloween quiz", () => {
  it.each(["A", "B", "C"])(
    "accepts finale %s and requires explicit result confirmation",
    async (optionId) => {
      const { game } = clients(
        await setupApp({
          context,
          isolatePg: true,
          routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
        }),
      );
      const body = credential();
      await getFinale(game, body);
      const answerBody = { ...body, questionId: "QUIZ-53", optionId };
      const responses = await Promise.all([
        game.answer({ body: answerBody }),
        game.answer({ body: answerBody }),
      ]);
      for (const response of responses) {
        expect(response).toMatchObject({
          status: 200,
          body: { correct: 5, outcome: "playing", completedAt: null },
        });
      }
      const { body: success } = await accept(
        game.next({ body: { ...body, questionId: "QUIZ-53" } }),
        [200],
      );
      expect(success.outcome).toBe("success");
      expect(success.completedAt).toBeTruthy();
      mockNow(new Date("2026-11-06T12:00:00Z"));
      const left = await accept(
        game.leave({ body: { ...body, reason: "interrupted" } }),
        [200],
      );
      expect(left.body).toStrictEqual(success);
    },
  );

  it("keeps the original draw on start retries and does not allow credential theft", async () => {
    const { game } = clients(
      await setupApp({
        context,
        isolatePg: true,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    const body = credential();
    const original = await accept(game.start({ headers, body }), [200]);
    expect(
      (await accept(game.start({ headers, body }), [200])).body,
    ).toStrictEqual(original.body);
    await accept(
      game.next({ body: { ...body, questionId: original.body.question!.id } }),
      [409],
    );
    await accept(
      game.leave({
        body: {
          ...body,
          token: randomBytes(32).toString("hex"),
          reason: "left",
        },
      }),
      [404],
    );
  });

  it("locks a wrong answer and prevents regrading or advancing", async () => {
    const { game } = clients(
      await setupApp({
        context,
        isolatePg: true,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    const body = credential();
    const { body: round } = await accept(game.start({ headers, body }), [200]);
    const questionId = round.question!.id;
    const wrong = round.question!.options.find((o) => {
      return o.id !== correctOption(round);
    })!;
    const { body: failed } = await accept(
      game.answer({ body: { ...body, questionId, optionId: wrong.id } }),
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
            body: { ...body, questionId, optionId: correctOption(round) },
          }),
          [200],
        )
      ).body,
    ).toStrictEqual(failed);
    expect(
      (await accept(game.next({ body: { ...body, questionId } }), [200])).body,
    ).toStrictEqual(failed);
  });

  it("honors Los Angeles midnight across DST while allowing existing rounds to finish", async () => {
    const { game } = clients(
      await setupApp({
        context,
        isolatePg: true,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    mockNow(new Date("2026-10-29T06:59:59Z"));
    await accept(game.start({ headers, body: credential() }), [409]);
    expect((await accept(game.status({ headers }), [200])).body.phase).toBe(
      "upcoming",
    );
    mockNow(new Date("2026-10-29T07:00:00Z"));
    expect((await accept(game.status({ headers }), [200])).body.phase).toBe(
      "open",
    );
    mockNow(new Date("2026-11-05T07:59:59Z"));
    const body = credential();
    await getFinale(game, body);
    mockNow(new Date("2026-11-05T08:00:00Z"));
    expect((await accept(game.status({ headers }), [200])).body.phase).toBe(
      "ended",
    );
    await accept(game.start({ headers, body: credential() }), [409]);
    await accept(
      game.answer({ body: { ...body, questionId: "QUIZ-53", optionId: "B" } }),
      [200],
    );
    expect(
      (
        await accept(
          game.next({ body: { ...body, questionId: "QUIZ-53" } }),
          [200],
        )
      ).body.outcome,
    ).toBe("success");
  });

  it("associates an interrupted round once, including after the event, and rejects another account", async () => {
    const { game } = clients(
      await setupApp({
        context,
        isolatePg: true,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    const body = credential();
    await accept(game.start({ headers, body }), [200]);
    mockNow(new Date("2026-11-07T12:00:00Z"));
    const first = await accept(
      game.link({ headers, body: { ...body, interrupted: true } }),
      [200],
    );
    expect(first.body).toMatchObject({ linked: true, outcome: "interrupted" });
    expect(
      (
        await accept(
          game.link({ headers, body: { ...body, interrupted: true } }),
          [200],
        )
      ).body,
    ).toStrictEqual(first.body);
    actor();
    await accept(game.link({ headers, body }), [404]);
  });

  it("tracks the first homepage exposure per authenticated account", async () => {
    const { game } = clients(
      await setupApp({
        context,
        isolatePg: true,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    expect(
      (await accept(game.exposure({ headers, body: {} }), [200])).body.first,
    ).toBeTruthy();
    expect(
      (await accept(game.exposure({ headers, body: {} }), [200])).body.first,
    ).toBeFalsy();
    actor();
    expect(
      (await accept(game.exposure({ headers, body: {} }), [200])).body.first,
    ).toBeTruthy();
  });

  it("exports immutable deduplicated staff batches without losing prior round history", async () => {
    const { game, operations } = clients(
      await setupApp({
        context,
        isolatePg: true,
        routes: [...halloweenRoutes, ...halloweenOperationsRoutes],
      }),
    );
    const bodies = [credential(), credential()];
    for (const body of bodies) {
      await accept(game.start({ headers, body }), [200]);
      await accept(
        game.link({ headers, body: { ...body, interrupted: true } }),
        [200],
      );
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
    const later = credential();
    await accept(game.start({ headers, body: later }), [200]);
    await accept(
      game.link({ headers, body: { ...later, interrupted: true } }),
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
