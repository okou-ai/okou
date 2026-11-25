import { fireEvent, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { fill } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  arrangeNativePage,
  expectStreamingAt,
} from "./browser-native-page-fixture.ts";
const context = testContext();
test("browser-address-search-004 A malformed location stays editable after submission", async () => {
  const { openPage } = arrangeNativePage(context);
  await openPage();
  await expectStreamingAt("https://example.com");
  const address = screen.getByLabelText("Address");
  await fill(address, "///invalid");
  fireEvent.submit(address.closest("form")!);
  await expect(screen.findByRole("alert")).resolves.toBeInTheDocument();
  expect(screen.getByLabelText("Open address")).toBeDisabled();
  expect(address).toHaveValue("///invalid");
});
