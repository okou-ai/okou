import { createRef, type ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Checkbox } from "../checkbox";

describe("Checkbox", () => {
  it("allows an uncontrolled checkbox to be toggled", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        aria-label="Email notifications"
        onCheckedChange={onCheckedChange}
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Email notifications",
    });
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);

    expect(checkbox).toBeChecked();
    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({ reason: "none", event: expect.any(Event) }),
    );

    await user.keyboard(" ");

    expect(checkbox).not.toBeChecked();
    expect(onCheckedChange).toHaveBeenCalledTimes(2);
    expect(onCheckedChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ reason: "none", event: expect.any(Event) }),
    );
  });

  it("leaves checked and indeterminate state under the caller's control", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    const { rerender } = render(
      <Checkbox
        checked={false}
        indeterminate
        aria-label="Select all"
        onCheckedChange={onCheckedChange}
      />,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Select all" });
    expect(checkbox).toBePartiallyChecked();

    await user.click(checkbox);

    expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(
      true,
      expect.objectContaining({ reason: "none" }),
    );
    expect(checkbox).toBePartiallyChecked();

    rerender(
      <Checkbox
        checked
        indeterminate={false}
        aria-label="Select all"
        onCheckedChange={onCheckedChange}
      />,
    );
    expect(checkbox).toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();

    await user.keyboard(" ");

    expect(onCheckedChange).toHaveBeenCalledTimes(2);
    expect(onCheckedChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ reason: "none" }),
    );
    expect(checkbox).toBeChecked();

    rerender(<Checkbox checked={false} aria-label="Select all" />);
    expect(checkbox).not.toBeChecked();
    expect(checkbox).not.toBePartiallyChecked();
  });

  it.each([false, true])(
    "lets the caller cancel a change from defaultChecked=%s",
    async (defaultChecked) => {
      const user = userEvent.setup();
      const onCheckedChange = vi.fn<
        NonNullable<ComponentProps<typeof Checkbox>["onCheckedChange"]>
      >((_checked, details) => {
        details.cancel();
      });
      render(
        <Checkbox
          aria-label="Protected preference"
          defaultChecked={defaultChecked}
          onCheckedChange={onCheckedChange}
        />,
      );
      const checkbox = screen.getByRole("checkbox", {
        name: "Protected preference",
      });

      await user.click(checkbox);

      expect(onCheckedChange).toHaveBeenCalledExactlyOnceWith(
        !defaultChecked,
        expect.objectContaining({
          reason: "none",
          event: expect.any(Event),
          isCanceled: true,
        }),
      );
      expect(checkbox).toHaveAttribute("aria-checked", String(defaultChecked));
    },
  );

  it("preserves label activation, refs, and an external form's submitted value", async () => {
    const user = userEvent.setup();
    const ref = createRef<HTMLElement>();
    const inputRef = createRef<HTMLInputElement>();
    const submissions: FormData[] = [];
    render(
      <>
        <form
          id="preferences"
          aria-label="Preferences"
          onSubmit={(event) => {
            event.preventDefault();
            submissions.push(new FormData(event.currentTarget));
          }}
        >
          <button type="submit">Save</button>
        </form>
        <label htmlFor="notifications">Email notifications</label>
        <Checkbox
          ref={ref}
          inputRef={inputRef}
          id="notifications"
          name="notifications"
          value="email"
          form="preferences"
          defaultChecked
        />
      </>,
    );
    const form = screen.getByRole<HTMLFormElement>("form", {
      name: "Preferences",
    });
    const checkbox = screen.getByRole("checkbox", {
      name: "Email notifications",
    });
    expect(ref.current).toBe(checkbox);
    expect(inputRef.current?.form).toBe(form);
    expect(new FormData(form).get("notifications")).toBe("email");

    await user.click(screen.getByText("Email notifications"));
    expect(checkbox).not.toBeChecked();
    expect(checkbox).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(checkbox).not.toBeChecked();
    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.has("notifications")).toBe(false);

    await user.keyboard(" ");
    expect(checkbox).toBeChecked();
    expect(new FormData(form).get("notifications")).toBe("email");
  });

  it.each(["disabled", "readOnly"] as const)(
    "preserves the checked value when %s",
    async (prop) => {
      const user = userEvent.setup();
      const onCheckedChange = vi.fn();
      render(
        <Checkbox
          aria-label="Fixed preference"
          defaultChecked
          disabled={prop === "disabled"}
          readOnly={prop === "readOnly"}
          onCheckedChange={onCheckedChange}
        />,
      );
      const checkbox = screen.getByRole("checkbox", {
        name: "Fixed preference",
      });

      await user.click(checkbox);
      await user.keyboard(" ");

      expect(checkbox).toBeChecked();
      expect(onCheckedChange).not.toHaveBeenCalled();
    },
  );
});
