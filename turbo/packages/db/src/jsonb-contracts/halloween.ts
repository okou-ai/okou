import {
  array,
  boolean,
  object,
  string,
  enum as zEnum,
  type infer as Infer,
} from "zod";

export const halloweenStoredQuestionsSchema = array(
  object({
    id: string(),
    text: string(),
    explanation: string(),
    options: array(
      object({ id: string(), text: string(), correct: boolean() }),
    ),
  }),
);
export type HalloweenStoredQuestions = Infer<
  typeof halloweenStoredQuestionsSchema
>;
export const halloweenSnapshotSchema = array(
  object({
    userId: string(),
    email: string().nullable(),
    orgId: string().nullable(),
    firstPlayedAt: string(),
    lastPlayedAt: string(),
    linkedAt: string(),
    rounds: array(
      object({
        id: string(),
        outcome: zEnum(["playing", "success", "wrong", "left", "interrupted"]),
        startedAt: string(),
        completedAt: string().nullable(),
      }),
    ),
    decision: zEnum(["pending", "winner", "not_selected"]),
    notifiedAt: string().nullable(),
    rewardedAt: string().nullable(),
  }),
);
export type HalloweenSnapshot = Infer<typeof halloweenSnapshotSchema>;
