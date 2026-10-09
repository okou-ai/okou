import { apiTestDatabaseUrl } from "./test-database-url";

test("keeps the configured connection and unrelated parameters", () => {
  const url = apiTestDatabaseUrl(
    "postgresql://test%40user:test%23password@db.example.test:5544/fixtures?sslmode=verify-full&application_name=seed-client&connect_timeout=5&options=-c%20statement_timeout%3D3000",
    "-c lock_timeout=1000",
  );

  expect(url.username).toBe("test%40user");
  expect(url.password).toBe("test%23password");
  expect(url.hostname).toBe("db.example.test");
  expect(url.port).toBe("5544");
  expect(url.pathname).toBe("/fixtures");
  expect(url.searchParams.get("sslmode")).toBe("verify-full");
  expect(url.searchParams.get("application_name")).toBe("seed-client");
  expect(url.searchParams.get("connect_timeout")).toBe("5");
  expect(url.searchParams.get("options")).toBe(
    "-c statement_timeout=3000 -c timezone=UTC",
  );
});

test.each([
  {
    name: "adds UTC when no startup options are configured",
    urlOptions: [],
    inheritedOptions: undefined,
    expected: "-c timezone=UTC",
  },
  {
    name: "preserves inherited PGOPTIONS when URL options are absent",
    urlOptions: [],
    inheritedOptions: "-c lock_timeout=1000 -c timezone=Asia/Shanghai",
    expected: "-c lock_timeout=1000 -c timezone=Asia/Shanghai -c timezone=UTC",
  },
  {
    name: "uses URL options instead of inherited PGOPTIONS",
    urlOptions: ["-c statement_timeout=3000 -c timezone=Asia/Shanghai"],
    inheritedOptions: "-c lock_timeout=1000",
    expected:
      "-c statement_timeout=3000 -c timezone=Asia/Shanghai -c timezone=UTC",
  },
  {
    name: "falls back to PGOPTIONS when URL options are empty",
    urlOptions: [""],
    inheritedOptions: "-c lock_timeout=1000",
    expected: "-c lock_timeout=1000 -c timezone=UTC",
  },
  {
    name: "preserves the last duplicate URL options value",
    urlOptions: ["-c statement_timeout=1000", "-c statement_timeout=3000"],
    inheritedOptions: "-c lock_timeout=1000",
    expected: "-c statement_timeout=3000 -c timezone=UTC",
  },
  {
    name: "falls back when the last duplicate URL options value is empty",
    urlOptions: ["-c statement_timeout=1000", ""],
    inheritedOptions: "-c lock_timeout=1000",
    expected: "-c lock_timeout=1000 -c timezone=UTC",
  },
])("$name", ({ urlOptions, inheritedOptions, expected }) => {
  const configured = new URL("postgresql://test@db.example.test/fixtures");
  for (const options of urlOptions) {
    configured.searchParams.append("options", options);
  }
  const url = apiTestDatabaseUrl(configured.toString(), inheritedOptions);

  expect(url.searchParams.getAll("options")).toStrictEqual([expected]);
});

test("retains the existing local test endpoint when no URL is provided", () => {
  const url = apiTestDatabaseUrl(undefined, undefined);

  expect(url.hostname).toBe("localhost");
  expect(url.port).toBe("5432");
  expect(url.pathname).toBe("/vm0_test");
  expect(url.searchParams.get("options")).toBe("-c timezone=UTC");
});
