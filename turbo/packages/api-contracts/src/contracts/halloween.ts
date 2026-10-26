import {
  array,
  boolean,
  literal,
  number,
  object,
  string,
  enum as zEnum,
  type infer as Infer,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

export const halloweenPhaseSchema = zEnum([
  "upcoming",
  "open",
  "ended",
  "unavailable",
]);
export const halloweenOutcomeSchema = zEnum([
  "playing",
  "success",
  "wrong",
  "left",
  "interrupted",
]);
export const halloweenQuestionSchema = object({
  id: string(),
  text: string(),
  options: array(object({ id: string(), text: string() })).length(3),
});
export const halloweenRoundSchema = object({
  id: string().uuid(),
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
  linked: boolean(),
});
export type HalloweenRound = Infer<typeof halloweenRoundSchema>;
export type HalloweenQuestion = Infer<typeof halloweenQuestionSchema>;
export type HalloweenPhase = Infer<typeof halloweenPhaseSchema>;

const credential = object({
  id: string().uuid(),
  token: string().regex(/^[a-f0-9]{64}$/),
});
const errors = {
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  500: apiErrorSchema,
  503: apiErrorSchema,
} as const;
const c = initContract();
export const halloweenContract = c.router({
  status: {
    method: "GET",
    path: "/api/halloween",
    responses: {
      200: object({
        phase: halloweenPhaseSchema,
        changesInMs: number().int().min(0).nullable(),
      }),
      ...errors,
    },
  },
  start: {
    method: "POST",
    path: "/api/halloween/rounds",
    body: credential,
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  answer: {
    method: "POST",
    path: "/api/halloween/answer",
    body: credential.extend({ questionId: string(), optionId: string() }),
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  next: {
    method: "POST",
    path: "/api/halloween/next",
    body: credential.extend({ questionId: string() }),
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  leave: {
    method: "POST",
    path: "/api/halloween/leave",
    body: credential.extend({ reason: zEnum(["left", "interrupted"]) }),
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  link: {
    method: "POST",
    path: "/api/halloween/link",
    headers: authHeadersSchema,
    body: credential.extend({ interrupted: boolean().optional() }),
    responses: { 200: halloweenRoundSchema, ...errors },
  },
  exposure: {
    method: "POST",
    path: "/api/halloween/exposure",
    headers: authHeadersSchema,
    body: object({}),
    responses: { 200: object({ first: boolean() }), ...errors },
  },
});

export const halloweenParticipantSchema = object({
  userId: string(),
  email: string().nullable(),
  orgId: string().nullable(),
  firstPlayedAt: string(),
  lastPlayedAt: string(),
  linkedAt: string(),
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
  id: string().uuid(),
  capturedAt: string(),
  participants: array(halloweenParticipantSchema),
});
export const halloweenOperationsContract = c.router({
  capture: {
    method: "POST",
    path: "/api/halloween/operations/batches",
    headers: authHeadersSchema,
    body: object({ id: string().uuid() }),
    responses: { 200: batch, ...errors },
  },
  batch: {
    method: "GET",
    path: "/api/halloween/operations/batches/:id",
    headers: authHeadersSchema,
    pathParams: object({ id: string().uuid() }),
    responses: { 200: batch, ...errors },
  },
  review: {
    method: "POST",
    path: "/api/halloween/operations/review",
    headers: authHeadersSchema,
    body: object({
      batchId: string().uuid(),
      userId: string(),
      decision: zEnum(["winner", "not_selected"]),
    }),
    responses: { 200: object({ saved: literal(true) }), ...errors },
  },
});
