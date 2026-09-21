import { describe, expect, it } from "vitest";

import {
  connectorCatalogValidationAuthorityIsCurrent,
  connectorCatalogValidationAuthorityIsCurrentOrNewer,
  createConnectorCatalogValidatorIdentity,
  type ConnectorCatalogValidationAuthority,
  type ConnectorCatalogValidatorIdentity,
} from "../connector-catalog/authority";
import { CONNECTOR_CATALOG_VALIDATOR_VERSION } from "../connector-catalog/version";

function authority(
  validatorVersion: string,
  buildCommitSha: string | null = null,
): ConnectorCatalogValidationAuthority {
  return { validatorVersion, buildCommitSha };
}

function validator(
  validatorVersion: string,
  buildCommitSha: string | null = null,
): ConnectorCatalogValidatorIdentity {
  return createConnectorCatalogValidatorIdentity({
    validatorVersion,
    buildCommitSha,
  });
}

describe("connector catalog validation authority", () => {
  it("orders the package authority after the final standalone validator", () => {
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: authority("2.0.17"),
        validator: validator(CONNECTOR_CATALOG_VALIDATOR_VERSION),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: authority(CONNECTOR_CATALOG_VALIDATOR_VERSION),
        validator: validator("2.0.17"),
      }),
    ).toBeTruthy();
  });

  it.each([
    { stored: "2.0.0", current: "1.999.999", reusable: true },
    { stored: "2.0.1", current: "2.0.0", reusable: true },
    { stored: "2.0.0", current: "2.0.0", reusable: true },
    { stored: "1.999.999", current: "2.0.0", reusable: false },
  ])(
    "orders accepted validator package $stored against $current",
    ({ stored, current, reusable }) => {
      expect(
        connectorCatalogValidationAuthorityIsCurrentOrNewer({
          authority: authority(stored),
          validator: validator(current),
        }),
      ).toBe(reusable);
    },
  );

  it("requires the exact package version and preview commit for current authority", () => {
    const firstCommit = "a".repeat(40);
    const secondCommit = "b".repeat(40);
    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: authority("2.0.0", firstCommit),
        validator: validator("2.0.0", firstCommit),
      }),
    ).toBeTruthy();
    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: authority("2.0.0", firstCommit),
        validator: validator("2.0.0", secondCommit),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogValidationAuthorityIsCurrent({
        authority: authority("2.0.0"),
        validator: validator("2.0.1"),
      }),
    ).toBeFalsy();
    expect(
      connectorCatalogValidationAuthorityIsCurrentOrNewer({
        authority: authority("2.0.0", firstCommit),
        validator: validator("2.0.0"),
      }),
    ).toBeFalsy();
  });

  it.each(["01.2.3", "1.02.3", "1.2.03", "1.2", "1.2.3-rc.1"])(
    "rejects non-core validator package version %s",
    (validatorVersion) => {
      expect(() => {
        validator(validatorVersion);
      }).toThrow(`Invalid core SemVer: ${validatorVersion}`);
    },
  );

  it("rejects malformed preview commit SHAs", () => {
    expect(() => {
      validator("2.0.0", "not-a-commit");
    }).toThrow("Invalid connector catalog validator build commit SHA");
  });
});
