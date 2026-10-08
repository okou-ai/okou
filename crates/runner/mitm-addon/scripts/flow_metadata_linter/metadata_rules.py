"""Metadata key-expression rules for flow metadata key linting."""

from __future__ import annotations

import ast
from enum import Enum, auto
from pathlib import Path

from flow_metadata_linter.ast_helpers import (
    _static_first_call_argument_nodes,
    _static_mapping_input_key_outcomes,
)
from flow_metadata_linter.paths import ADDON_ROOT as _ADDON_ROOT
from flow_metadata_linter.registry import REGISTERED_METADATA_KEYS as _REGISTERED_METADATA_KEYS

_METADATA_PAIR_LENGTH = 2
_STRING_FORMAT_CONVERSION = ord("s")
_SEQUENCE_WRAPPER_CALLS = {"frozenset", "iter", "list", "reversed", "set", "sorted", "tuple"}


class _MetadataCollectionMode(Enum):
    MAPPING_INPUT = auto()
    PAIR_ITERABLE = auto()
    KEY_SEQUENCE = auto()
    # Input to dict() whose resulting keys are consumed as update pairs.
    MAPPING_PAIR_KEYS = auto()


def _is_metadata_attribute(node: ast.AST) -> bool:
    return isinstance(node, ast.Attribute) and node.attr == "metadata"


def _registered_key_name(node: ast.AST) -> str | None:
    value = _static_string_value(node)
    if value is None:
        return None
    return _REGISTERED_METADATA_KEYS.get(value)


def _static_string_value(node: ast.AST) -> str | None:
    if isinstance(node, ast.keyword) and node.arg is not None:
        return node.arg
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
                continue
            if (
                isinstance(value, ast.FormattedValue)
                and value.conversion in {-1, _STRING_FORMAT_CONVERSION}
                and _is_plain_string_format_spec(value.format_spec)
            ):
                formatted_value = _static_string_value(value.value)
                if formatted_value is not None:
                    parts.append(formatted_value)
                    continue
                return None
            return None
        return "".join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = _static_string_value(node.left)
        right = _static_string_value(node.right)
        if left is not None and right is not None:
            return left + right
    return None


def _is_plain_string_format_spec(node: ast.AST | None) -> bool:
    if node is None:
        return True
    spec = _static_string_value(node)
    return spec in {"", "s"}


def _violation(path: Path, node: ast.AST, key_name: str) -> str:
    location = path.relative_to(_ADDON_ROOT) if path.is_relative_to(_ADDON_ROOT) else path
    line_number = getattr(node, "lineno", 0)
    return f"{location}:{line_number}: use metadata_keys.{key_name} for flow.metadata access"


def _metadata_dict_key_violations(path: Path, node: ast.AST | None) -> list[str]:
    return _metadata_collection_violations(path, node, _MetadataCollectionMode.MAPPING_INPUT)


def _metadata_pair_iterable_violations(path: Path, node: ast.AST) -> list[str]:
    return _metadata_collection_violations(path, node, _MetadataCollectionMode.PAIR_ITERABLE)


def _metadata_key_sequence_violations(path: Path, node: ast.AST | None) -> list[str]:
    return _metadata_collection_violations(path, node, _MetadataCollectionMode.KEY_SEQUENCE)


def _metadata_collection_violations(
    path: Path, node: ast.AST | None, mode: _MetadataCollectionMode
) -> list[str]:
    if node is None:
        return []
    if isinstance(node, ast.NamedExpr):
        return _metadata_collection_violations(path, node.value, mode)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_collection_violations(path, node.body, mode),
            *_metadata_collection_violations(path, node.orelse, mode),
        ]
    if isinstance(node, ast.BoolOp):
        violations: list[str] = []
        for value in node.values:
            violations.extend(_metadata_collection_violations(path, value, mode))
        return violations
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add | ast.BitOr):
        operand_mode = mode
        if isinstance(node.op, ast.Add) and mode is _MetadataCollectionMode.MAPPING_INPUT:
            operand_mode = _MetadataCollectionMode.PAIR_ITERABLE
        return [
            *_metadata_collection_violations(path, node.left, operand_mode),
            *_metadata_collection_violations(path, node.right, operand_mode),
        ]
    if isinstance(node, ast.DictComp):
        if mode in {
            _MetadataCollectionMode.PAIR_ITERABLE,
            _MetadataCollectionMode.MAPPING_PAIR_KEYS,
        }:
            return _metadata_pair_element_violations(path, node.key)
        return _metadata_key_expression_violations(path, node.key)
    if isinstance(node, ast.List | ast.Tuple | ast.Set):
        return _metadata_collection_sequence_violations(path, node, mode)
    if isinstance(node, ast.ListComp | ast.SetComp | ast.GeneratorExp):
        if mode is _MetadataCollectionMode.KEY_SEQUENCE:
            return _metadata_key_expression_violations(path, node.elt)
        if mode is _MetadataCollectionMode.MAPPING_PAIR_KEYS:
            return _metadata_mapping_entry_pair_key_violations(path, node.elt)
        return _metadata_pair_element_violations(path, node.elt)
    if isinstance(node, ast.Call):
        return _metadata_collection_call_violations(path, node, mode)
    if not isinstance(node, ast.Dict):
        return []
    return _metadata_mapping_container_violations(path, node, mode)


def _metadata_mapping_container_violations(
    path: Path, node: ast.Dict, mode: _MetadataCollectionMode
) -> list[str]:
    violations: list[str] = []
    for key, value in zip(node.keys, node.values, strict=True):
        if key is None:
            violations.extend(_metadata_collection_violations(path, value, mode))
            continue
        if mode in {
            _MetadataCollectionMode.PAIR_ITERABLE,
            _MetadataCollectionMode.MAPPING_PAIR_KEYS,
        }:
            violations.extend(_metadata_pair_element_violations(path, key))
            continue
        violations.extend(_metadata_key_expression_violations(path, key))
    return violations


def _metadata_collection_sequence_violations(
    path: Path,
    node: ast.List | ast.Tuple | ast.Set,
    mode: _MetadataCollectionMode,
) -> list[str]:
    if mode is _MetadataCollectionMode.MAPPING_PAIR_KEYS:
        mapping_pair_violations: list[str] = []
        for element in node.elts:
            if isinstance(element, ast.Starred):
                mapping_pair_violations.extend(
                    _metadata_collection_violations(path, element.value, mode)
                )
                continue
            mapping_pair_violations.extend(
                _metadata_mapping_entry_pair_key_violations(path, element)
            )
        return mapping_pair_violations
    if mode is not _MetadataCollectionMode.KEY_SEQUENCE:
        return _metadata_pair_sequence_violations(path, node)
    violations: list[str] = []
    for element in node.elts:
        if isinstance(element, ast.Starred):
            violations.extend(_metadata_collection_violations(path, element.value, mode))
            continue
        violations.extend(_metadata_key_expression_violations(path, element))
    return violations


def _metadata_collection_call_violations(
    path: Path, node: ast.Call, mode: _MetadataCollectionMode
) -> list[str]:
    if mode is _MetadataCollectionMode.MAPPING_PAIR_KEYS:
        # Project constructor input to resulting keys before consuming those keys as pairs.
        mapping_pair_violations: list[str] = []
        for key in _static_mapping_input_key_outcomes(node, include_all=True).nodes:
            mapping_pair_violations.extend(_metadata_pair_element_violations(path, key))
        return mapping_pair_violations
    if isinstance(node.func, ast.Attribute):
        if (
            isinstance(node.func.value, ast.Name)
            and node.func.value.id == "dict"
            and node.func.attr == "fromkeys"
        ):
            keys_mode = (
                _MetadataCollectionMode.PAIR_ITERABLE
                if mode is _MetadataCollectionMode.PAIR_ITERABLE
                else _MetadataCollectionMode.KEY_SEQUENCE
            )
            violations: list[str] = []
            for keys_arg in _static_first_call_argument_nodes(node.args):
                violations.extend(_metadata_collection_violations(path, keys_arg, keys_mode))
            return violations
        if (
            mode is not _MetadataCollectionMode.KEY_SEQUENCE
            and node.func.attr == "items"
            and not node.args
            and not node.keywords
        ):
            return _metadata_collection_violations(
                path, node.func.value, _MetadataCollectionMode.MAPPING_INPUT
            )
        if node.func.attr == "keys" and not node.args and not node.keywords:
            keys_mode = (
                _MetadataCollectionMode.KEY_SEQUENCE
                if mode is _MetadataCollectionMode.KEY_SEQUENCE
                else _MetadataCollectionMode.PAIR_ITERABLE
            )
            return _metadata_collection_violations(path, node.func.value, keys_mode)
        if node.func.attr == "copy" and not node.args and not node.keywords:
            return _metadata_collection_violations(path, node.func.value, mode)
        return []
    if not isinstance(node.func, ast.Name):
        return []
    if node.func.id == "dict":
        input_mode = (
            _MetadataCollectionMode.MAPPING_PAIR_KEYS
            if mode is _MetadataCollectionMode.PAIR_ITERABLE
            else _MetadataCollectionMode.MAPPING_INPUT
        )
        violations = []
        for update_arg in _static_first_call_argument_nodes(node.args):
            violations.extend(_metadata_collection_violations(path, update_arg, input_mode))
        if input_mode is _MetadataCollectionMode.MAPPING_INPUT:
            violations.extend(_metadata_keyword_violations(path, node.keywords))
        return violations
    if node.func.id == "zip" and mode is not _MetadataCollectionMode.KEY_SEQUENCE:
        violations = []
        for keys_arg in _static_first_call_argument_nodes(node.args):
            violations.extend(
                _metadata_collection_violations(
                    path, keys_arg, _MetadataCollectionMode.KEY_SEQUENCE
                )
            )
        return violations
    if node.func.id in _SEQUENCE_WRAPPER_CALLS:
        collection_mode = (
            _MetadataCollectionMode.PAIR_ITERABLE
            if mode is _MetadataCollectionMode.MAPPING_INPUT
            else mode
        )
        violations = []
        for collection_arg in _static_first_call_argument_nodes(node.args):
            violations.extend(
                _metadata_collection_violations(path, collection_arg, collection_mode)
            )
        return violations
    return []


def _metadata_pair_sequence_violations(
    path: Path, node: ast.List | ast.Tuple | ast.Set
) -> list[str]:
    violations: list[str] = []
    for item in node.elts:
        if isinstance(item, ast.Starred):
            violations.extend(_metadata_pair_iterable_violations(path, item.value))
            continue
        violations.extend(_metadata_pair_element_violations(path, item))
    return violations


def _metadata_pair_element_violations(path: Path, node: ast.AST) -> list[str]:
    if isinstance(node, ast.NamedExpr):
        return _metadata_pair_element_violations(path, node.value)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_pair_element_violations(path, node.body),
            *_metadata_pair_element_violations(path, node.orelse),
        ]
    if isinstance(node, ast.BoolOp):
        violations: list[str] = []
        for value in node.values:
            violations.extend(_metadata_pair_element_violations(path, value))
        return violations
    if not isinstance(node, ast.List | ast.Tuple) or len(node.elts) != _METADATA_PAIR_LENGTH:
        return []
    return _metadata_key_expression_violations(path, node.elts[0])


def _metadata_mapping_entry_pair_key_violations(path: Path, node: ast.AST) -> list[str]:
    if isinstance(node, ast.NamedExpr):
        return _metadata_mapping_entry_pair_key_violations(path, node.value)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_mapping_entry_pair_key_violations(path, node.body),
            *_metadata_mapping_entry_pair_key_violations(path, node.orelse),
        ]
    if isinstance(node, ast.BoolOp):
        violations: list[str] = []
        for value in node.values:
            violations.extend(_metadata_mapping_entry_pair_key_violations(path, value))
        return violations
    if not isinstance(node, ast.List | ast.Tuple) or len(node.elts) != _METADATA_PAIR_LENGTH:
        return []
    return _metadata_pair_element_violations(path, node.elts[0])


def _metadata_key_expression_violations(path: Path, node: ast.AST) -> list[str]:
    if isinstance(node, ast.NamedExpr):
        return _metadata_key_expression_violations(path, node.value)
    if isinstance(node, ast.IfExp):
        return [
            *_metadata_key_expression_violations(path, node.body),
            *_metadata_key_expression_violations(path, node.orelse),
        ]
    if isinstance(node, ast.BoolOp):
        violations: list[str] = []
        for value in node.values:
            violations.extend(_metadata_key_expression_violations(path, value))
        return violations
    key_name = _registered_key_name(node)
    if key_name is None:
        return []
    return [_violation(path, node, key_name)]


def _metadata_keyword_violations(path: Path, keywords: list[ast.keyword]) -> list[str]:
    violations: list[str] = []
    for keyword in keywords:
        if keyword.arg is None:
            violations.extend(_metadata_dict_key_violations(path, keyword.value))
            continue
        key_name = _REGISTERED_METADATA_KEYS.get(keyword.arg)
        if key_name is not None:
            violations.append(_violation(path, keyword, key_name))
    return violations
