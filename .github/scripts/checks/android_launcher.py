"""Audit source manifests before exempting the intentionally public Android launcher."""

from dataclasses import dataclass
from pathlib import Path, PurePosixPath
import sys
import xml.etree.ElementTree as ET
from xml.parsers import expat

ANDROID = "http://schemas.android.com/apk/res/android"
NAME = f"{{{ANDROID}}}name"
EXPORTED = f"{{{ANDROID}}}exported"
MANIFEST = "android/app/src/main/AndroidManifest.xml"
RULE = "java.android.security.exported_activity.exported_activity"
COMPONENTS = {"activity", "activity-alias", "service", "receiver", "provider"}


@dataclass(frozen=True)
class ReviewedLauncher:
    start_line: int
    end_line: int

    def covers(self, rule, path, start_line, end_line):
        return (
            rule == RULE
            and isinstance(path, str)
            and str(PurePosixPath(path)) == MANIFEST
            and type(start_line) is int
            and type(end_line) is int
            and self.start_line <= start_line <= end_line <= self.end_line
        )


def launcher_lines(content):
    """Use XML locations, not a regex that could match an activity in a comment."""
    parser = expat.ParserCreate(namespace_separator="}")
    stack = []
    start_line = None
    end_line = None
    active = False

    def start(tag, attributes):
        nonlocal start_line, active
        stack.append(tag)
        if stack == ["manifest", "application", "activity"] and attributes.get(
            f"{ANDROID}}}name"
        ) == ".MainActivity":
            start_line = parser.CurrentLineNumber
            active = True

    def end(tag):
        nonlocal end_line, active
        if stack == ["manifest", "application", "activity"] and active:
            end_line = parser.CurrentLineNumber
            active = False
        stack.pop()

    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.Parse(content, True)
    if start_line is None or end_line is None:
        raise ValueError("Cannot locate the reviewed Android launcher")
    return ReviewedLauncher(start_line, end_line)


def reviewed_launcher(root):
    """Reject new public components or input routes; absence of Android is allowed."""
    root = Path(root)
    if (root / "android").exists() and not (root / MANIFEST).is_file():
        raise ValueError("Android project is missing its reviewed launcher manifest")
    reviewed = None
    for path in sorted(root.glob("android/*/src/**/AndroidManifest.xml")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"{relative}: source manifests must stay inside the repository")
        content = path.read_text()
        if "<!DOCTYPE" in content:
            raise ValueError(f"{relative}: manifest DTDs are not supported")
        manifest = ET.fromstring(content)
        launchers = []
        for component in manifest.iter():
            if component.tag not in COMPONENTS:
                continue
            if (
                relative == MANIFEST
                and component.tag == "activity"
                and component.get(NAME) == ".MainActivity"
            ):
                launchers.append(component)
            elif component.get(EXPORTED) != "false":
                raise ValueError(
                    f"{relative}: {component.tag} {component.get(NAME)} must explicitly "
                    "set android:exported=false; additional public entries need security review"
                )
        if relative != MANIFEST:
            continue
        application = manifest.find("application")
        if len(launchers) != 1 or application is None or launchers[0] not in application:
            raise ValueError(f"{relative}: expected one direct MainActivity launcher")
        activity = launchers[0]
        if activity.get(EXPORTED) != "true" or len(activity) != 1:
            raise ValueError(f"{relative}: launcher must be exported with one intent filter")
        intent = activity[0]
        entries = [(child.tag, child.attrib) for child in intent]
        expected = [
            ("action", {NAME: "android.intent.action.MAIN"}),
            ("category", {NAME: "android.intent.category.LAUNCHER"}),
        ]
        if (
            intent.tag != "intent-filter"
            or intent.attrib
            or len(entries) != 2
            or entries not in (expected, list(reversed(expected)))
            or any(len(child) for child in intent)
        ):
            raise ValueError(f"{relative}: only MAIN/LAUNCHER is reviewed; no data or extra routes")
        reviewed = launcher_lines(content)
    if (root / MANIFEST).exists() and reviewed is None:
        raise ValueError("Android launcher was not audited")
    return reviewed


if __name__ == "__main__":
    try:
        launcher = reviewed_launcher(sys.argv[1] if len(sys.argv) > 1 else ".")
    except (ValueError, OSError, ET.ParseError, expat.ExpatError) as failure:
        sys.exit(f"Android launcher audit failed: {failure}")
    print("Android source manifests audited; only the reviewed MAIN/LAUNCHER may be public")
