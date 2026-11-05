import { StrictMode } from "react";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TransientAlert } from "../transient-alert";

afterEach(() => {
  vi.useRealTimers();
});

test("A retained failure expires without rerenders renewing or reopening it", () => {
  vi.useFakeTimers();
  const failure = {};
  const { rerender } = render(
    <StrictMode>
      <TransientAlert occurrences={[failure]}>Action failed</TransientAlert>
    </StrictMode>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Action failed");

  act(() => {
    vi.advanceTimersByTime(2000);
  });
  rerender(
    <StrictMode>
      <TransientAlert occurrences={[failure]}>Action failed</TransientAlert>
    </StrictMode>,
  );
  act(() => {
    vi.advanceTimersByTime(999);
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  rerender(
    <StrictMode>
      <TransientAlert occurrences={[failure]}>Action failed</TransientAlert>
    </StrictMode>,
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("A fresh identical-message failure gets a full interval while older failures remain", () => {
  vi.useFakeTimers();
  const first = {};
  const second = {};
  const { rerender } = render(
    <TransientAlert occurrences={[first]}>Action failed</TransientAlert>,
  );
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  rerender(
    <TransientAlert occurrences={[first, second]}>
      Action failed
    </TransientAlert>,
  );
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("Action failed");

  // Resolving another source neither renews nor cancels the fresh notice.
  rerender(
    <TransientAlert occurrences={[second]}>Action failed</TransientAlert>,
  );
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();

  rerender(
    <TransientAlert occurrences={[second, {}]}>Action failed</TransientAlert>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Action failed");
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

test("Clearing, separate presentation owners and unmount do not share timers", () => {
  vi.useFakeTimers();
  const first = {};
  const second = {};
  const { rerender, unmount } = render(
    <>
      <section aria-label="First viewer">
        <TransientAlert occurrences={[first]}>First failure</TransientAlert>
      </section>
      <section aria-label="Second viewer">
        <TransientAlert occurrences={[]}>Second failure</TransientAlert>
      </section>
    </>,
  );
  act(() => {
    vi.advanceTimersByTime(2000);
  });
  rerender(
    <>
      <section aria-label="First viewer">
        <TransientAlert occurrences={[first]}>First failure</TransientAlert>
      </section>
      <section aria-label="Second viewer">
        <TransientAlert occurrences={[second]}>Second failure</TransientAlert>
      </section>
    </>,
  );
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(
    within(screen.getByRole("region", { name: "First viewer" })).queryByRole(
      "alert",
    ),
  ).not.toBeInTheDocument();
  expect(screen.getByRole("alert")).toHaveTextContent("Second failure");

  rerender(
    <>
      <section aria-label="First viewer">
        <TransientAlert occurrences={[{}]}>First failure</TransientAlert>
      </section>
      <section aria-label="Second viewer">
        <TransientAlert occurrences={[]}>Second failure</TransientAlert>
      </section>
    </>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("First failure");
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

test("A suppressed duplicate still expires before its other presentation clears", () => {
  vi.useFakeTimers();
  const failure = {};
  const { rerender } = render(
    <TransientAlert occurrences={[failure]} hidden>
      Action failed
    </TransientAlert>,
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  act(() => {
    vi.advanceTimersByTime(3000);
  });
  rerender(
    <TransientAlert occurrences={[failure]}>Action failed</TransientAlert>,
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});
