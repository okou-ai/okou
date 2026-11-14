import { fireEvent, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import {
  click,
  queryAllByRoleFast,
  setupPage,
} from "../../__tests__/page-helper.ts";
import { testContext } from "../../signals/__tests__/test-helpers.ts";

const context = testContext();

interface DiagnosticOutput {
  schema: number;
  run: number;
  total: number;
  retained: number;
  dropped: number;
  entries: { seq: number; kind: string; mark?: number }[];
}

function button(name: string, panel: HTMLElement): HTMLElement {
  const target = queryAllByRoleFast("button", panel).find((element) => {
    return element.textContent?.trim() === name;
  });
  if (!target) {
    throw new Error(`Missing diagnostic control ${name}`);
  }
  return target;
}

function output(): DiagnosticOutput {
  const field = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Stopped diagnostic JSON",
  });
  return JSON.parse(field.value) as DiagnosticOutput;
}

test("A preview investigator records, reads a bounded trace, and starts an independent run", async () => {
  await setupPage({
    context,
    path: "/",
    host: "pr-47142-app-okou-app-preview.vm0.workers.dev",
  });
  const panel = await screen.findByRole("region", {
    name: "Preview scroll diagnostics",
  });
  const controls = within(panel);
  expect(controls.getByText("PWA diag: Idle")).toBeInTheDocument();

  click(button("Start", panel));
  expect(controls.getByText("PWA diag: Recording")).toBeInTheDocument();
  click(button("Mark", panel));
  expect(button("Stop", panel)).toBeEnabled();

  // Native viewport events are the recorder's external production interface.
  for (let index = 0; index < 245; index++) {
    fireEvent.resize(window);
  }
  click(button("Stop", panel));
  expect(controls.getByText("PWA diag: Stopped")).toBeInTheDocument();
  const first = output();
  expect(first.schema).toBe(1);
  expect(first.run).toBe(1);
  expect(first.retained).toBe(240);
  expect(first.entries).toHaveLength(240);
  expect(first.dropped).toBeGreaterThan(0);
  expect(first.total).toBe(first.retained + first.dropped);
  expect(first.entries.at(-1)?.kind).toBe("stop");

  click(button("Read snapshot", panel));
  expect(output()).toStrictEqual(first);
  click(button("Start", panel));
  expect(controls.getByText("PWA diag: Recording")).toBeInTheDocument();
  click(button("Mark", panel));
  expect(button("Stop", panel)).toBeEnabled();
  click(button("Stop", panel));
  expect(controls.getByText("PWA diag: Stopped")).toBeInTheDocument();
  const second = output();
  expect(second.run).toBe(2);
  expect(second.dropped).toBe(0);
  expect(second.entries[0]).toMatchObject({ seq: 1, kind: "start" });
  expect(
    second.entries.find((entry) => {
      return entry.kind === "mark";
    }),
  ).toMatchObject({ mark: 1 });
});
