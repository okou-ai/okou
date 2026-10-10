"""Public helper API for flow metadata key linting."""

from __future__ import annotations

import ast
import tokenize
from pathlib import Path

from flow_metadata_linter.metadata_rules import _is_metadata_attribute, _registered_key_name
from flow_metadata_linter.paths import METADATA_KEYS_FILE, SRC_ROOT, TESTS_ROOT
from flow_metadata_linter.visitor import _MetadataKeyVisitor


def _python_files() -> list[Path]:
    files: list[Path] = []
    for root in (SRC_ROOT, TESTS_ROOT):
        files.extend(path for path in root.rglob("*.py") if path != METADATA_KEYS_FILE)
    return sorted(files)


def metadata_key_violations(path: Path) -> list[str]:
    """Parse the Python source file at ``path`` and return metadata key diagnostics.

    The file is opened with Python source encoding detection and parsed into an AST. Each
    diagnostic identifies the source location of a statically detected registered key used in
    flow metadata access and the ``metadata_keys`` constant to use instead.
    """
    with tokenize.open(str(path)) as source_file:
        source = source_file.read()
    tree = ast.parse(source, filename=str(path))
    # Diagnostics require a registered key expression. Check the parsed AST,
    # including concatenated strings, f-strings and keyword keys, before paying
    # for alias/control-flow analysis. Parsing still validates every source file.
    if not any(_is_metadata_attribute(node) for node in ast.walk(tree)) or not any(
        _registered_key_name(node) is not None for node in ast.walk(tree)
    ):
        return []
    visitor = _MetadataKeyVisitor(path)
    visitor.visit(tree)
    return visitor.violations


def repository_metadata_key_violations() -> list[str]:
    """Return metadata key diagnostics from the addon's source and test trees.

    The scan recursively covers Python files under ``src/`` and ``tests/`` and excludes
    ``src/flow_metadata_keys.py``. It does not inspect ``scripts/``.
    """
    return [violation for path in _python_files() for violation in metadata_key_violations(path)]
