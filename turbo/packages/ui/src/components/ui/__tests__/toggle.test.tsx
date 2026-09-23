import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Toggle } from "../toggle";
import { ToggleGroup } from "../toggle-group";

describe("Toggle and ToggleGroup", () => {
  it("moves focus without changing the selection and activates once without submitting", async () => {
    const user = userEvent.setup();
    const ref = { current: null as HTMLDivElement | null };
    function Filters() {
      const [value, setValue] = useState<string[]>(["all"]);
      const [changes, setChanges] = useState(0);
      const [submitted, setSubmitted] = useState(false);
      return (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
          }}
        >
          <ToggleGroup
            ref={ref}
            aria-label="Filters"
            value={value}
            onValueChange={(next) => {
              setValue(next);
              setChanges((count) => {
                return count + 1;
              });
            }}
          >
            <Toggle value="all">All</Toggle>
            <Toggle value="locked" disabled>
              Locked
            </Toggle>
            <Toggle value="mine">Mine</Toggle>
          </ToggleGroup>
          <output>{`${value.join(",") || "empty"}:${changes}:${submitted ? "submitted" : "ready"}`}</output>
          <button type="submit">Apply</button>
        </form>
      );
    }
    render(<Filters />);
    expect(ref.current).toBe(screen.getByRole("group", { name: "Filters" }));
    await user.tab();
    expect(screen.getByRole("button", { name: "All" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Mine" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("all:0:ready");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("mine:1:ready");
    await user.keyboard(" ");
    expect(screen.getByRole("status")).toHaveTextContent("empty:2:ready");
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getByRole("status")).toHaveTextContent("all:3:ready");
    await user.click(screen.getByRole("button", { name: "Locked" }));
    expect(screen.getByRole("status")).toHaveTextContent("all:3:ready");
    await user.tab();
    expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent("all:3:submitted");
  });

  it("forwards cancellation details and leaves selection ownership with the caller", async () => {
    const user = userEvent.setup();
    function Choices() {
      const [value, setValue] = useState<string[]>([]);
      const [attempt, setAttempt] = useState("");
      return (
        <>
          <ToggleGroup
            multiple
            value={value}
            onValueChange={(next, details) => {
              setAttempt(`${next.join(",")}:${details.event.type}`);
              if (next.includes("restricted")) {
                details.cancel();
                return;
              }
              setValue(next);
            }}
          >
            <Toggle value="public">Public</Toggle>
            <Toggle value="restricted">Restricted</Toggle>
          </ToggleGroup>
          <output>{`Saved: ${value.join(",")}; Attempt: ${attempt}`}</output>
        </>
      );
    }
    render(<Choices />);
    await user.click(screen.getByRole("button", { name: "Public" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved: public; Attempt: public:click",
    );
    await user.click(screen.getByRole("button", { name: "Restricted" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved: public; Attempt: public,restricted:click",
    );
    await user.keyboard("{ArrowLeft}{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Saved: ; Attempt: :click",
    );
  });

  it("retains standalone pressed control and disables the complete group", async () => {
    const user = userEvent.setup();
    const ref = { current: null as HTMLButtonElement | null };
    function Controls() {
      const [pressed, setPressed] = useState(false);
      const [changes, setChanges] = useState(0);
      return (
        <>
          <ToggleGroup
            disabled
            onValueChange={() => {
              setChanges(changes + 1);
            }}
          >
            <Toggle value="one">One</Toggle>
            <Toggle value="two">Two</Toggle>
          </ToggleGroup>
          <Toggle
            ref={ref}
            pressed={pressed}
            onPressedChange={(next, details) => {
              if (details.event.type === "click") setPressed(next);
            }}
          >
            Details
          </Toggle>
          <output>{`${pressed ? "Details shown" : "Details hidden"}; changes: ${changes}`}</output>
        </>
      );
    }
    render(<Controls />);
    expect(ref.current).toBe(screen.getByRole("button", { name: "Details" }));
    await user.click(screen.getByRole("button", { name: "One" }));
    await user.tab();
    expect(ref.current).toHaveFocus();
    await user.keyboard(" ");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Details shown; changes: 0",
    );
    await user.keyboard("{Enter}");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Details hidden; changes: 0",
    );
  });
});
