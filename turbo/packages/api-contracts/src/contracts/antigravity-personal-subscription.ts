import {
  discriminatedUnion,
  iso,
  literal,
  object,
  strictObject,
  string,
  uuid,
} from "zod";
import { authHeadersSchema, initContract } from "./base";
import { apiErrorSchema } from "./errors";

const binding = object({ bindingId: uuid() });
export const antigravityLoginHost = string()
  .regex(/^(?:[a-z0-9][a-z0-9_-]*@)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i)
  .max(255);
const profile = discriminatedUnion("status", [
  object({ status: literal("disconnected") }),
  object({ status: literal("unassigned") }),
  binding.extend({
    status: literal("pending"),
    expiresAt: iso.datetime(),
    loginHost: antigravityLoginHost,
  }),
  binding.extend({ status: literal("expired") }),
  binding.extend({ status: literal("unavailable") }),
  binding.extend({ status: literal("connected") }),
]);
const responses = {
  200: profile,
  400: apiErrorSchema,
  401: apiErrorSchema,
  403: apiErrorSchema,
  404: apiErrorSchema,
  409: apiErrorSchema,
  503: apiErrorSchema,
} as const;
const path = "/api/me/subscriptions/antigravity";

export const antigravityPersonalSubscriptionContract = initContract().router({
  get: {
    method: "GET",
    path,
    headers: authHeadersSchema,
    responses,
    summary: "Read your internal Antigravity profile binding",
  },
  start: {
    method: "POST",
    path,
    headers: authHeadersSchema,
    body: strictObject({}),
    responses,
    summary:
      "Start personal Google sign-in on your assigned Antigravity worker",
  },
  disconnect: {
    method: "DELETE",
    path: `${path}/:bindingId`,
    headers: authHeadersSchema,
    pathParams: binding,
    responses,
    summary: "Cancel or disconnect this exact Antigravity profile binding",
  },
  workerStatus: {
    method: "GET",
    path: "/api/internal/antigravity/subscriptions/:bindingId",
    headers: authHeadersSchema,
    pathParams: binding,
    responses,
    summary:
      "Check the binding for this worker before opening a Google login or using its profile",
  },
  workerDisconnect: {
    method: "DELETE",
    path: "/api/internal/antigravity/subscriptions/:bindingId",
    headers: authHeadersSchema,
    pathParams: binding,
    responses,
    summary:
      "Disconnect this exact profile when its owner logs out through the native worker",
  },
  confirm: {
    method: "POST",
    path: "/api/internal/antigravity/subscriptions/:bindingId/confirm",
    headers: authHeadersSchema,
    pathParams: binding,
    body: strictObject({}),
    responses,
    summary: "Confirm a native sign-in from its assigned worker identity",
  },
});
