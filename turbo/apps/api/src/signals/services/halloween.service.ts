import { createHash, randomInt } from "node:crypto";
import type { HalloweenRound } from "@okouai/api-contracts/contracts/halloween";
import { halloweenRounds } from "@okouai/db/schema/halloween";
import {
  halloweenStoredQuestionsSchema,
  type HalloweenStoredQuestions,
} from "@okouai/db/jsonb-contracts/halloween";
import { command } from "ccstate";
import { and, eq, isNull, or } from "drizzle-orm";
import { badRequestMessage, conflict, notFound } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { HALLOWEEN_QUESTION_BANK } from "./halloween-question-bank";

type StoredRound = typeof halloweenRounds.$inferSelect;
interface Credential {
  readonly id: string;
  readonly token: string;
}

function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

function roundQuestions(): HalloweenStoredQuestions {
  const finale = HALLOWEEN_QUESTION_BANK.find((q) => {
    return q.id === "QUIZ-53";
  });
  const pool = HALLOWEEN_QUESTION_BANK.filter((q) => {
    return q.id !== "QUIZ-53";
  });
  if (!finale || pool.length < 4) {
    throw new Error("Halloween question bank is incomplete");
  }
  return [...shuffled(pool).slice(0, 4), finale].map((q) => {
    return {
      ...q,
      options: shuffled(q.options),
    };
  });
}

function credentialWhere(credential: Credential) {
  return and(
    eq(halloweenRounds.id, credential.id),
    eq(
      halloweenRounds.tokenHash,
      createHash("sha256").update(credential.token).digest("hex"),
    ),
  );
}

function present(row: StoredRound): HalloweenRound {
  const question = halloweenStoredQuestionsSchema.parse(row.questions)[
    row.questionIndex
  ];
  if (!question) {
    throw new Error("Halloween round has no current question");
  }
  const selected = question.options.find((o) => {
    return o.id === row.selectedId;
  });
  return {
    id: row.id,
    outcome: row.outcome,
    correct: row.correct,
    questionNumber: row.questionIndex + 1,
    question:
      row.outcome === "playing"
        ? {
            id: question.id,
            text: question.text,
            options: question.options.map(({ id, text }) => {
              return { id, text };
            }),
          }
        : null,
    feedback: selected
      ? {
          correct: selected.correct,
          explanation: selected.correct
            ? question.explanation
            : "Okou got you this time.",
          selectedId: selected.id,
        }
      : null,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    linked: row.userId !== null,
  };
}

const receipt = (row: StoredRound) => {
  return {
    status: 200 as const,
    body: present(row),
  };
};

export const startHalloweenRound$ = command(
  async ({ set }, credential: Credential, signal: AbortSignal) => {
    const db = set(writeDb$);
    const at = nowDate();
    await db
      .insert(halloweenRounds)
      .values({
        id: credential.id,
        tokenHash: createHash("sha256").update(credential.token).digest("hex"),
        questions: roundQuestions(),
        startedAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing();
    signal.throwIfAborted();
    const [row] = await db
      .select()
      .from(halloweenRounds)
      .where(credentialWhere(credential));
    signal.throwIfAborted();
    return row ? receipt(row) : notFound("Game result not found");
  },
);

export const answerHalloweenRound$ = command(
  async (
    { set },
    input: Credential & {
      readonly questionId: string;
      readonly optionId: string;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [row] = await db
      .select()
      .from(halloweenRounds)
      .where(credentialWhere(input));
    signal.throwIfAborted();
    if (!row) {
      return notFound("Game result not found");
    }
    if (row.outcome !== "playing") {
      return receipt(row);
    }
    const question = halloweenStoredQuestionsSchema.parse(row.questions)[
      row.questionIndex
    ];
    if (question?.id !== input.questionId) {
      return conflict("This question has already ended");
    }
    if (row.selectedId !== null) {
      return receipt(row);
    }
    const selected = question.options.find((o) => {
      return o.id === input.optionId;
    });
    if (!selected) {
      return badRequestMessage("Choose one of the available answers");
    }
    const at = nowDate();
    await db
      .update(halloweenRounds)
      .set({
        selectedId: selected.id,
        correct: row.correct + (selected.correct ? 1 : 0),
        outcome: selected.correct ? "playing" : "wrong",
        completedAt: selected.correct ? null : at,
        updatedAt: at,
      })
      .where(
        and(
          credentialWhere(input),
          eq(halloweenRounds.outcome, "playing"),
          eq(halloweenRounds.questionIndex, row.questionIndex),
          isNull(halloweenRounds.selectedId),
        ),
      );
    signal.throwIfAborted();
    const [saved] = await db
      .select()
      .from(halloweenRounds)
      .where(credentialWhere(input));
    signal.throwIfAborted();
    return saved ? receipt(saved) : notFound("Game result not found");
  },
);

export const advanceHalloweenRound$ = command(
  async (
    { set },
    input: Credential & { readonly questionId: string },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [row] = await db
      .select()
      .from(halloweenRounds)
      .where(credentialWhere(input));
    signal.throwIfAborted();
    if (!row) {
      return notFound("Game result not found");
    }
    const question = halloweenStoredQuestionsSchema.parse(row.questions)[
      row.questionIndex
    ];
    if (row.outcome !== "playing" || question?.id !== input.questionId) {
      return receipt(row);
    }
    if (row.selectedId === null || row.correct !== row.questionIndex + 1) {
      return conflict("Answer this question first");
    }
    const at = nowDate();
    await db
      .update(halloweenRounds)
      .set(
        row.questionIndex === 4
          ? { outcome: "success", completedAt: at, updatedAt: at }
          : {
              questionIndex: row.questionIndex + 1,
              selectedId: null,
              updatedAt: at,
            },
      )
      .where(
        and(
          credentialWhere(input),
          eq(halloweenRounds.outcome, "playing"),
          eq(halloweenRounds.questionIndex, row.questionIndex),
          eq(halloweenRounds.selectedId, row.selectedId),
        ),
      );
    signal.throwIfAborted();
    const [saved] = await db
      .select()
      .from(halloweenRounds)
      .where(credentialWhere(input));
    signal.throwIfAborted();
    return saved ? receipt(saved) : notFound("Game result not found");
  },
);

export const leaveHalloweenRound$ = command(
  async (
    { set },
    input: Credential & { readonly reason: "left" | "interrupted" },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const at = nowDate();
    await db
      .update(halloweenRounds)
      .set({ outcome: input.reason, completedAt: at, updatedAt: at })
      .where(
        and(credentialWhere(input), eq(halloweenRounds.outcome, "playing")),
      );
    signal.throwIfAborted();
    const [row] = await db
      .select()
      .from(halloweenRounds)
      .where(credentialWhere(input));
    signal.throwIfAborted();
    return row ? receipt(row) : notFound("Game result not found");
  },
);

export const linkHalloweenRound$ = command(
  async (
    { set },
    input: Credential & {
      readonly userId: string;
      readonly orgId: string | null;
      readonly email: string | null;
      readonly interrupted?: boolean;
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    if (input.interrupted) {
      await set(
        leaveHalloweenRound$,
        { ...input, reason: "interrupted" },
        signal,
      );
    }
    const at = nowDate();
    await db
      .update(halloweenRounds)
      .set({
        userId: input.userId,
        orgId: input.orgId,
        email: input.email,
        linkedAt: at,
      })
      .where(and(credentialWhere(input), isNull(halloweenRounds.userId)));
    signal.throwIfAborted();
    const [row] = await db
      .select()
      .from(halloweenRounds)
      .where(
        and(
          credentialWhere(input),
          or(
            isNull(halloweenRounds.userId),
            eq(halloweenRounds.userId, input.userId),
          ),
        ),
      );
    signal.throwIfAborted();
    return row?.userId === input.userId
      ? receipt(row)
      : notFound("Game result not found");
  },
);
