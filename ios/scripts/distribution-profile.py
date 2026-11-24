#!/usr/bin/env python3
"""Validate an App Store profile and prepare source-declared bundle entitlements."""

import argparse
import datetime
import fnmatch
import plistlib
import re
import uuid
from pathlib import Path

TEAM = "C5UWSXYB67"
BUNDLES = {
    "ai.okou.ios": Path("ios/Okou/Resources/Okou.entitlements"),
    "ai.okou.ios.notifications": Path(
        "ios/NotificationExtension/NotificationExtension.entitlements"
    ),
    "ai.okou.ios.widgets": Path("ios/Widgets/OkouWidgets.entitlements"),
}


def prepare(profile_path, destination, bundle_id, connector_callback_host):
    if destination.exists():
        raise ValueError("Entitlement output must be a new file")
    profile = plistlib.loads(profile_path.read_bytes())
    uuid.UUID(profile["UUID"])
    if profile["TeamIdentifier"] != [TEAM] or profile[
        "ApplicationIdentifierPrefix"
    ] != [TEAM]:
        raise ValueError("Wrong signing team or application prefix")
    approved = profile["Entitlements"]
    if approved["application-identifier"] != f"{TEAM}.{bundle_id}":
        raise ValueError("Wrong profile bundle ID")
    if (
        approved.get("get-task-allow")
        or profile.get("ProvisionedDevices")
        or profile.get("ProvisionsAllDevices")
    ):
        raise ValueError("An App Store Connect distribution profile is required")
    expiry = profile["ExpirationDate"].replace(tzinfo=datetime.timezone.utc)
    if expiry <= datetime.datetime.now(datetime.timezone.utc):
        raise ValueError("Expired provisioning profile")
    if "group.ai.okou.ios" not in approved.get(
        "com.apple.security.application-groups", []
    ):
        raise ValueError("Profile must enable the shared Okou App Group")
    if bundle_id == "ai.okou.ios" and approved.get("aps-environment") != "production":
        raise ValueError("Application distribution profile must enable production APNs")
    source = (
        BUNDLES[bundle_id].read_bytes().replace(b"$(APS_ENVIRONMENT)", b"production")
    )
    source = source.replace(b"$(AppIdentifierPrefix)", (TEAM + ".").encode())
    if b"$(OKOU_CONNECTOR_CALLBACK_HOST)" in source:
        if not connector_callback_host or not re.fullmatch(
            r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", connector_callback_host
        ):
            raise ValueError("A valid archived connector callback host is required")
        source = source.replace(
            b"$(OKOU_CONNECTOR_CALLBACK_HOST)", connector_callback_host.encode()
        )
    if b"$(" in source:
        raise ValueError("Unresolved source entitlement build setting")
    requested = plistlib.loads(source)
    for key, value in requested.items():
        if isinstance(value, list):
            patterns = approved.get(key, [])
            if any(
                not any(fnmatch.fnmatchcase(item, pattern) for pattern in patterns)
                for item in value
            ):
                raise ValueError(f"Profile does not authorize requested {key}")
        elif approved.get(key) != value:
            raise ValueError(f"Profile does not authorize requested {key}")
    for key in ("application-identifier", "com.apple.developer.team-identifier"):
        requested[key] = approved[key]
    requested["get-task-allow"] = False
    destination.write_bytes(plistlib.dumps(requested))
    print(profile["UUID"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("profile", type=Path)
    parser.add_argument("destination", type=Path)
    parser.add_argument("--bundle-id", required=True, choices=BUNDLES)
    parser.add_argument("--connector-callback-host")
    args = parser.parse_args()
    prepare(
        args.profile, args.destination, args.bundle_id, args.connector_callback_host
    )


if __name__ == "__main__":
    main()
