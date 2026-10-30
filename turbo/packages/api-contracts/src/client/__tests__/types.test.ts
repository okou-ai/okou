import { describe, expectTypeOf, it } from "vitest";
import { literal, number, object, string, type input } from "zod";
import {
  initClient as initContractClient,
  initContract,
} from "../../contracts/trpc-contract";
import { initClient } from "../transport";
import type {
  ClientDescriptor,
  ClientInferResponses,
  ClientRouter,
  InitClientArgs,
  InitClientReturn,
} from "../types";

const c = initContract();
const contract = c.router({
  defaults: {
    method: "GET",
    path: "/items",
    query: object({ page: string().default("1").transform(Number) }).default({
      page: 1,
    }),
    responses: { 200: object({ count: number() }) },
  },
  update: {
    method: "PATCH",
    path: "/items/:id",
    pathParams: object({ id: string() }),
    headers: object({ "x-scope": string() }),
    body: object({
      count: string().transform(Number),
      label: string().default("new"),
    }),
    responses: {
      200: object({ count: string().transform(Number) }),
      409: object({ error: literal("conflict") }),
    },
  },
  noInput: {
    method: "GET",
    path: "/health",
    responses: { 204: c.noBody() },
  },
  optionalBody: {
    method: "POST",
    path: "/optional",
    body: string().optional(),
    responses: { 200: c.type<{ readonly accepted: boolean }>() },
  },
});

const descriptor: ClientDescriptor<typeof contract> = {
  defaults: { method: "GET", path: "/items", statuses: { 200: true } },
  update: {
    method: "PATCH",
    path: "/items/:id",
    statuses: { 200: true, 409: true },
  },
  noInput: { method: "GET", path: "/health", statuses: { 204: true } },
  optionalBody: {
    method: "POST",
    path: "/optional",
    statuses: { 200: true },
  },
};

const config = { baseUrl: "https://api.example.test" };
const fullClient = initContractClient(contract, config);
const sharedFullClient = initClient(contract, config);
const descriptorClient = initClient(descriptor, config);

describe("client descriptor inference", () => {
  it("preserves full-contract client methods through projection and shared transport", () => {
    expectTypeOf(descriptorClient).toEqualTypeOf(fullClient);
    expectTypeOf(sharedFullClient).toEqualTypeOf(fullClient);
    expectTypeOf(descriptor).toExtend<ClientRouter>();
    expectTypeOf(descriptorClient).toEqualTypeOf<
      InitClientReturn<typeof descriptor, InitClientArgs>
    >();
  });

  it("preserves optional/defaulted input and pre-transform request values", () => {
    type DefaultsInput = Parameters<typeof descriptorClient.defaults>[0];
    type UpdateInput = Parameters<typeof descriptorClient.update>[0];

    expectTypeOf<undefined>().toExtend<DefaultsInput>();
    expectTypeOf<NonNullable<DefaultsInput>["query"]>().toEqualTypeOf<
      input<typeof contract.defaults.query>
    >();
    expectTypeOf<UpdateInput["body"]>().toEqualTypeOf<{
      count: string;
      label?: string | undefined;
    }>();
    expectTypeOf<UpdateInput["params"]>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<UpdateInput["headers"]>().toEqualTypeOf<{
      "x-scope": string;
    }>();
    expectTypeOf<
      undefined extends UpdateInput ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<undefined>().toExtend<
      Parameters<typeof descriptorClient.noInput>[0]
    >();
    type OptionalBodyInput = Parameters<
      typeof descriptorClient.optionalBody
    >[0];
    expectTypeOf<
      undefined extends OptionalBodyInput ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<OptionalBodyInput["body"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<
      Omit<UpdateInput, "params"> extends UpdateInput ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<
      { count: number } extends UpdateInput["body"] ? true : false
    >().toEqualTypeOf<false>();
  });

  it("preserves transformed response bodies and status-discriminated narrowing", () => {
    type Response = Awaited<ReturnType<typeof descriptorClient.update>>;

    expectTypeOf<Response>().toEqualTypeOf<
      ClientInferResponses<typeof contract.update>
    >();
    expectTypeOf<Response["status"]>().toEqualTypeOf<200 | 409>();
    expectTypeOf<Extract<Response, { status: 200 }>["body"]>().toEqualTypeOf<{
      count: number;
    }>();
    expectTypeOf<Extract<Response, { status: 409 }>["body"]>().toEqualTypeOf<{
      error: "conflict";
    }>();
    expectTypeOf<Response["headers"]>().toEqualTypeOf<Headers>();
    expectTypeOf<
      Awaited<ReturnType<typeof descriptorClient.noInput>>["body"]
    >().toEqualTypeOf<undefined>();
  });

  it("requires every declared status in the projected runtime metadata", () => {
    type Statuses = typeof descriptor.update.statuses;
    expectTypeOf<Statuses>().toEqualTypeOf<Readonly<Record<200 | 409, true>>>();
    expectTypeOf<
      { 200: true } extends Statuses ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<typeof descriptor.update.method>().toEqualTypeOf<"PATCH">();
    expectTypeOf<
      503 extends keyof Statuses ? true : false
    >().toEqualTypeOf<false>();
    expectTypeOf<typeof descriptor.update.path>().toEqualTypeOf<
      typeof contract.update.path
    >();
  });
});
