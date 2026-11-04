import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { LayoutCommit, RequestCommit } from "../layout-panel";

test("a layout acknowledgement follows its semantic key, not unrelated rendering", () => {
  const commit = () => {
    screen.getByRole("textbox", { name: "Destination" }).focus();
  };
  const view = (key: string, value: string) => {
    return (
      <>
        <button type="button">Elsewhere</button>
        <LayoutCommit layoutKey={key} onLayoutCommit={commit}>
          <input aria-label="Destination" value={value} readOnly />
        </LayoutCommit>
      </>
    );
  };
  const { rerender } = render(view("initial", "first"));
  const destination = screen.getByRole("textbox", { name: "Destination" });
  expect(destination).toHaveFocus();
  screen.getByRole("button", { name: "Elsewhere" }).focus();
  rerender(view("initial", "unrelated"));
  expect(destination).toHaveValue("unrelated");
  expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
  rerender(view("new-layout", "committed"));
  expect(destination).toHaveValue("committed");
  expect(destination).toHaveFocus();
});

test("a request acknowledgement uses the exact request and committed enable boundary", () => {
  const request = {};
  const acknowledge = (committed: object) => {
    expect(committed).toBe(request);
    const destination = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Destination",
    });
    if (!destination.disabled) {
      destination.focus();
    }
  };
  const view = (pending: object | null, disabled: boolean, label: string) => {
    return (
      <>
        <button type="button">Elsewhere</button>
        <RequestCommit
          request={pending}
          commitKey={String(disabled)}
          onCommit={acknowledge}
        >
          <input aria-label="Destination" disabled={disabled} />
          <span>{label}</span>
        </RequestCommit>
      </>
    );
  };
  const { container, rerender } = render(view(null, false, "idle"));
  const destination = screen.getByRole("textbox", { name: "Destination" });
  expect(destination).not.toHaveFocus();
  const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
  elsewhere.focus();
  rerender(view(request, true, "pending"));
  expect(elsewhere).toHaveFocus();
  rerender(view(request, false, "enabled"));
  expect(destination).toBeEnabled();
  expect(destination).toHaveFocus();
  // No wrapper changes layout, and an unrelated render cannot replay the handoff.
  expect(destination.parentElement).toBe(container);
  elsewhere.focus();
  rerender(view(request, false, "unrelated"));
  expect(elsewhere).toHaveFocus();
});
