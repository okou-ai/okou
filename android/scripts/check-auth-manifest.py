"""Fail closed on public entries in the actual pinned SDK/app merged manifest."""

from pathlib import Path
import sys
import xml.etree.ElementTree as ET

A = "{http://schemas.android.com/apk/res/android}"
SSO = "com.clerk.api.sso.SSOReceiverActivity"
SHARED = "com.clerk.api.sharedsession.SharedSessionSyncProvider"
PROFILE = "androidx.profileinstaller.ProfileInstallReceiver"
REVOCATION = "com.google.android.gms.auth.api.signin.RevocationBoundService"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def audit(path, package):
    root = ET.parse(path).getroot()
    require(package in {"ai.okou.android", "ai.okou.android.debug"}, "Unexpected package")
    require(root.get("package") == package, "Unexpected application package")
    app = root.find("application")
    require(app is not None, "Missing application")
    require(app.get(A + "allowBackup") == "false", "Credentials must not enter app backup")
    expected = {
        ("activity", "ai.okou.android.MainActivity"),
        ("activity", SSO),
        ("receiver", PROFILE),
        ("service", REVOCATION),
    }
    if package.endswith(".debug"):
        # Compose's debug-only test manifest; never accepted in the release APK.
        expected.add(("activity", "androidx.activity.ComponentActivity"))
    found = set()
    shared_found = False
    for component in app:
        if component.tag not in {"activity", "activity-alias", "provider", "service", "receiver"}:
            continue
        name = component.get(A + "name")
        if name == SHARED:
            require(not shared_found, "Duplicate SDK shared-session provider")
            shared_found = True
            require(component.tag == "provider" and component.get(A + "enabled") == "false" and
                    component.get(A + "exported") == "false" and
                    component.get(A + "grantUriPermissions") == "false" and
                    component.get(A + "authorities") == f"{package}.clerk.shared-session-sync",
                    "SDK shared-session provider must remain private and disabled")
        public = component.get(A + "exported") == "true" or (
            component.get(A + "exported") is None and component.findall("intent-filter")
        )
        if not public:
            continue
        key = (component.tag, name)
        require(key in expected and key not in found, f"Unreviewed public entry: {key}")
        found.add(key)
        if name == SSO:
            filters = component.findall("intent-filter")
            require(len(filters) == 2, "Unexpected Clerk callback filters")
            hosts = set()
            for intent in filters:
                require(not intent.attrib and len(intent) == 4, "Unexpected callback filter shape")
                require([e.attrib for e in intent.findall("action")] == [{A + "name": "android.intent.action.VIEW"}], "Unexpected callback action")
                require({e.get(A + "name") for e in intent.findall("category")} == {
                    "android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"
                }, "Unexpected callback categories")
                data = intent.findall("data")
                require(len(data) == 1, "Unexpected callback data filters")
                host = data[0].get(A + "host")
                require(data[0].attrib == {A + "host": host, A + "scheme": "clerk"}, "Unexpected callback URL")
                hosts.add(host)
            require(hosts == {f"{package}.callback", f"{package}.oauth"}, "Callback escaped its package")
        elif name == PROFILE:
            require(component.get(A + "permission") == "android.permission.DUMP", "Profile installer permission changed")
        elif name == REVOCATION:
            require(component.get(A + "permission") == "com.google.android.gms.auth.api.signin.permission.REVOCATION_NOTIFICATION", "Revocation service permission changed")
            require(not component.findall("intent-filter"), "Unexpected revocation intent filters")
        elif name == "androidx.activity.ComponentActivity":
            require(not component.findall("intent-filter"), "Unexpected debug activity intent filters")
        else:
            filters = component.findall("intent-filter")
            require(len(filters) == 1 and len(filters[0]) == 2, "Unexpected launcher filter shape")
            require([e.attrib for e in filters[0].findall("action")] == [{A + "name": "android.intent.action.MAIN"}], "Unexpected launcher action")
            require([e.attrib for e in filters[0].findall("category")] == [{A + "name": "android.intent.category.LAUNCHER"}], "Unexpected launcher category")
    require(found == expected, f"Merged public entries changed: {found ^ expected}")
    require(shared_found, "Clerk initialization requires its disabled provider to be registered")


if __name__ == "__main__":
    try:
        audit(Path(sys.argv[1]), sys.argv[2])
    except (ValueError, OSError, ET.ParseError) as error:
        sys.exit(f"Android authentication manifest audit failed: {error}")
    print("Merged Android authentication entries audited")
