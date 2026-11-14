#!/usr/bin/env python3
"""Keep first-party saved-state writes inside the reviewed native UI boundary."""

import re
import sys
from pathlib import Path


BOUNDARY = Path("app/src/main/kotlin/ai/okou/android/state/SavedUiState.kt")
RESTRICTED = re.compile(
    r"\bandroidx\s*\.\s*compose\s*\.\s*runtime\s*\.\s*saveable\b"
    r"|\bandroidx\s*\.\s*lifecycle\s*\.\s*SavedStateHandle\b"
    r"|\bandroidx\s*\.\s*savedstate\s*\.\s*SavedStateRegistry(?:Owner|Controller)?\b"
    r"|\bimport\s+androidx\s*\.\s*(?:lifecycle|savedstate)\s*\.\s*\*"
    r"|\b(?:registerSavedStateProvider|setSavedStateProvider)\b"
)


def code_only(source: str) -> str:
    """Mask comments and literal text, preserving offsets for actionable diagnostics."""
    result = list(source)
    i = 0
    while i < len(source):
        start = i
        if source.startswith("//", i):
            end = source.find("\n", i)
            i = len(source) if end < 0 else end
        elif source.startswith("/*", i):
            depth = 1
            i += 2
            while i < len(source) and depth:
                if source.startswith("/*", i):
                    depth += 1
                    i += 2
                elif source.startswith("*/", i):
                    depth -= 1
                    i += 2
                else:
                    i += 1
        elif source.startswith('"""', i):
            end = source.find('"""', i + 3)
            i = len(source) if end < 0 else end + 3
        elif source[i] in ('"', "'"):
            quote = source[i]
            i += 1
            while i < len(source):
                if source[i] == "\\":
                    i += 2
                elif source[i] == quote:
                    i += 1
                    break
                else:
                    i += 1
        else:
            i += 1
            continue
        for pos in range(start, min(i, len(source))):
            if result[pos] != "\n":
                result[pos] = " "
    return "".join(result)


def violations(root: Path) -> list[str]:
    errors = []
    for path in sorted((root / "app/src/main").rglob("*.kt")):
        relative = path.relative_to(root)
        if relative == BOUNDARY:
            continue
        source = code_only(path.read_text()).replace("`", "")
        for match in RESTRICTED.finditer(source):
            line = source.count("\n", 0, match.start()) + 1
            errors.append(
                f"{relative}:{line}: use ai.okou.android.state for saved UI metadata; "
                "documents and pending writes belong to their persistent owner"
            )
    return errors


if __name__ == "__main__":
    findings = violations(Path(__file__).resolve().parent.parent)
    if findings:
        print("\n".join(findings), file=sys.stderr)
        sys.exit(1)
    print("Android saved-state API boundary audited")
