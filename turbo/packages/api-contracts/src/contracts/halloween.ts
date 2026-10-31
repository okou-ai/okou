import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  uuid,
  enum as zEnum,
  type infer as Infer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const halloweenPhaseSchema = zEnum(["open", "unavailable"]);
export const halloweenOutcomeSchema = zEnum([
  "playing",
  "success",
  "wrong",
  "left",
]);
export const halloweenQuestionSchema = object({
  id: string(),
  text: string(),
  options: array(object({ id: string(), text: string() })).length(3),
});
export const halloweenRoundSchema = object({
  id: uuid(),
  outcome: halloweenOutcomeSchema,
  correct: number().int().min(0).max(5),
  question: halloweenQuestionSchema.nullable(),
  questionNumber: number().int().min(1).max(5),
  feedback: object({
    correct: boolean(),
    explanation: string(),
    selectedId: string(),
  }).nullable(),
  startedAt: string(),
  completedAt: string().nullable(),
});
export type HalloweenRound = Infer<typeof halloweenRoundSchema>;
export type HalloweenQuestion = Infer<typeof halloweenQuestionSchema>;
export type HalloweenPhase = Infer<typeof halloweenPhaseSchema>;

const roundReference = object({
  id: uuid(),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
  503: apiErrorSchema,
};
const c = initContract();
export const halloweenContract = c.router({
  status: {
    method: "GET",
    path: "/api/halloween",
    headers: authHeadersSchema,
    responses: {
      200: object({ phase: halloweenPhaseSchema }),
      ...errors,
    },
  },
  current: {
    method: "GET",
    path: "/api/halloween/rounds/current",
    headers: authHeadersSchema,
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  start: {
    method: "POST",
    path: "/api/halloween/rounds",
    headers: authHeadersSchema,
    body: object({ restart: boolean() }),
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  answer: {
    method: "POST",
    path: "/api/halloween/answer",
    headers: authHeadersSchema,
    body: roundReference.extend({
      questionId: string(),
      optionId: string(),
    }),
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  next: {
    method: "POST",
    path: "/api/halloween/next",
    headers: authHeadersSchema,
    body: roundReference.extend({ questionId: string() }),
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  leave: {
    method: "POST",
    path: "/api/halloween/leave",
    headers: authHeadersSchema,
    body: roundReference,
    responses: { 200: halloweenRoundSchema, ...errors },
  },
});

export const halloweenParticipantSchema = object({
  userId: string(),
  email: string().nullable(),
  orgId: string(),
  firstPlayedAt: string(),
  lastPlayedAt: string(),
  rounds: array(
    object({
      id: string(),
      outcome: halloweenOutcomeSchema,
      startedAt: string(),
      completedAt: string().nullable(),
    }),
  ),
  decision: zEnum(["pending", "winner", "not_selected"]),
  notifiedAt: string().nullable(),
  rewardedAt: string().nullable(),
});
export type HalloweenParticipant = Infer<typeof halloweenParticipantSchema>;
const batch = object({
  id: uuid(),
  capturedAt: string(),
  participants: array(halloweenParticipantSchema),
});
export const halloweenOperationsContract = c.router({
  capture: {
    method: "POST",
    path: "/api/halloween/operations/batches",
    headers: authHeadersSchema,
    body: object({ id: uuid() }),
    responses: { 200: batch, ...errors },
  },
  batch: {
    method: "GET",
    path: "/api/halloween/operations/batches/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: uuid() }),
    responses: { 200: batch, ...errors },
  },
  review: {
    method: "POST",
    path: "/api/halloween/operations/review",
    headers: authHeadersSchema,
    body: object({
      batchId: uuid(),
      userId: string(),
      decision: zEnum(["winner", "not_selected"]),
    }),
    responses: { 200: object({ saved: literal(true) }), ...errors },
  },
});
