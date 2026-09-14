"""AST visitor for flow metadata alias and key usage analysis."""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path
from typing import overload

from flow_metadata_linter.ast_helpers import (
    _argument_annotations,
    _argument_names,
    _comparison_operator_may_raise,
    _expression_bound_names,
    _is_modeled_implicit_exception_operation,
    _iterable_is_statically_empty,
    _iteration_may_raise,
    _literal_iteration_limit,
    _pattern_is_exhaustive,
    _pattern_names,
    _scope_bound_name_visitor,
    _static_first_call_argument_nodes,
    _static_truth_value,
    _target_names,
    _target_requires_unpacking,
    _truth_test_may_raise,
    _type_alias_target_names,
    _type_alias_value,
    _type_param_names,
    _type_params,
)
from flow_metadata_linter.metadata_rules import (
    _is_metadata_attribute,
    _metadata_dict_key_violations,
    _metadata_key_expression_violations,
    _violation,
)
from flow_metadata_linter.registry import REGISTERED_METADATA_KEYS as _REGISTERED_METADATA_KEYS

_METADATA_METHODS_WITH_KEY_ARGUMENTS = {
    "__contains__",
    "__delitem__",
    "__getitem__",
    "__setitem__",
    "get",
    "pop",
    "setdefault",
}
_METADATA_METHODS_WITH_DICT_ARGUMENTS = {"__ior__", "update"}
_DIRECT_UNBOUND_METADATA_KEY_CALL_ARGUMENTS = {
    ("dict", "__contains__"): (0, 1),
    ("dict", "__delitem__"): (0, 1),
    ("dict", "__getitem__"): (0, 1),
    ("dict", "__setitem__"): (0, 1),
    ("dict", "get"): (0, 1),
    ("dict", "pop"): (0, 1),
    ("dict", "setdefault"): (0, 1),
    ("operator", "contains"): (0, 1),
    ("operator", "delitem"): (0, 1),
    ("operator", "getitem"): (0, 1),
    ("operator", "setitem"): (0, 1),
}
_DIRECT_UNBOUND_METADATA_MAPPING_INPUT_CALLS = {
    ("dict", "__ior__"),
    ("dict", "update"),
    ("operator", "ior"),
}


@dataclass
class _ExceptionAliasState:
    """Whether exception paths exist and aliases that may hold on those paths."""

    may_raise: bool = False
    aliases: set[str] = field(default_factory=set)

    def record(self, aliases: set[str]) -> None:
        self.may_raise = True
        self.aliases.update(aliases)

    def merge(self, other: _ExceptionAliasState) -> None:
        if other.may_raise:
            self.record(other.aliases)


@dataclass
class _LoopControlAliasState:
    """Reachable break and continue exits owned by one loop."""

    may_break: bool = False
    break_aliases: set[str] = field(default_factory=set)
    may_continue: bool = False
    continue_aliases: set[str] = field(default_factory=set)

    def record_break(self, aliases: set[str]) -> None:
        self.may_break = True
        self.break_aliases.update(aliases)

    def record_continue(self, aliases: set[str]) -> None:
        self.may_continue = True
        self.continue_aliases.update(aliases)

    def merge(self, other: _LoopControlAliasState) -> None:
        if other.may_break:
            self.record_break(other.break_aliases)
        if other.may_continue:
            self.record_continue(other.continue_aliases)


def _metadata_match_pattern_alias_names(pattern: ast.pattern) -> set[str]:
    if isinstance(pattern, ast.MatchAs):
        names = set() if pattern.name is None else {pattern.name}
        if pattern.pattern is not None:
            names.update(_metadata_match_pattern_alias_names(pattern.pattern))
        return names
    if isinstance(pattern, ast.MatchMapping):
        return set() if pattern.rest is None else {pattern.rest}
    if isinstance(pattern, ast.MatchOr):
        names: set[str] = set()
        for child_pattern in pattern.patterns:
            names.update(_metadata_match_pattern_alias_names(child_pattern))
        return names
    return set()


def _direct_unbound_metadata_key_arguments(node: ast.Call) -> tuple[ast.AST, ast.AST] | None:
    if not isinstance(node.func, ast.Attribute) or not isinstance(node.func.value, ast.Name):
        return None
    argument_indexes = _DIRECT_UNBOUND_METADATA_KEY_CALL_ARGUMENTS.get(
        (node.func.value.id, node.func.attr)
    )
    if argument_indexes is None:
        return None
    mapping_index, key_index = argument_indexes
    last_required_index = max(argument_indexes)
    if len(node.args) <= last_required_index or any(
        isinstance(argument, ast.Starred) for argument in node.args[: last_required_index + 1]
    ):
        return None
    return node.args[mapping_index], node.args[key_index]


def _direct_unbound_metadata_mapping_arguments(
    node: ast.Call,
) -> tuple[ast.AST, list[ast.expr], bool] | None:
    if not isinstance(node.func, ast.Attribute) or not isinstance(node.func.value, ast.Name):
        return None
    qualified_call = (node.func.value.id, node.func.attr)
    if (
        qualified_call not in _DIRECT_UNBOUND_METADATA_MAPPING_INPUT_CALLS
        or not node.args
        or isinstance(node.args[0], ast.Starred)
    ):
        return None
    return node.args[0], node.args[1:], qualified_call == ("dict", "update")


class _MetadataKeyVisitor(ast.NodeVisitor):
    """Conservatively track names that may refer to ``flow.metadata``.

    The visitor is flow-sensitive within each Python scope, but joins control-flow
    exits as a may analysis: a name remains an alias if it can denote metadata on
    any represented path. Metadata-valued assignments, defaults, captures, and
    named expressions introduce aliases; rebinding, deletion, imports, and Python
    scope bindings shadow or discard them. Ordinary branch joins include only exits
    that can fall through, while loops also retain zero-iteration and possible body
    or ``else`` exits. Loop entries grow monotonically over the finite set of source
    names until normal and continue backedges add no aliases. Each pass preserves
    statement-level rebinding and retains newly discovered diagnostics. Direct
    literal iterables also bound the number of body passes by their element count.

    Sequential body traversal requires every concrete statement visitor to report
    its normal-exit result explicitly. Expression visitors return ``None`` outside
    that contract, while a missing statement result fails in visitor dispatch.

    The mutable analysis state has these invariants:

    * ``_metadata_alias_scopes`` is never empty. Its last set is the alias state for
      the current lexical or branch context, and index zero is the module state used
      to resolve ``global`` declarations and class-body bindings. Scoped and branch
      visitors push independent sets, then explicitly join or discard their exits.
    * ``_exception_alias_scopes`` contains collectors for modeled exceptional exits
      from active constructs. ``may_raise`` is stored separately from the alias set
      so an exceptional path with no aliases is not confused with no exceptional
      path. Nested ``try`` and handler states merge into the nearest collector, and
      a failing class body projects away class-bound names before propagating.
      Function and lambda bodies install boundaries, context managers retain paths
      they may suppress, and ``finally`` transfers normal and exceptional states.
      Expression-level modeled implicit failures use one operation predicate, with
      ordered recording for short-circuit, comparison, assertion, loop, and
      comprehension evaluation. Decorated definitions record their application-call
      state after definition-time evaluation and before name binding. Deferred
      annotations, type parameters, and type-alias values retain the linter's existing
      syntactic alias and key behavior without feeding runtime exception collectors.
    * ``_class_nested_scope_alias_scopes`` holds the surrounding non-class alias
      base while a class body is active. Nested classes, function and lambda bodies,
      and implicit comprehension scopes use that base because they do not close over
      class-local names; the class body itself has a separate alias scope with its
      own binding rules.
    * ``_metadata_key_checked_node_ids`` contains only AST identities whose key
      checks produced violations. Generic and specialized traversal can inspect the
      same node, so these identities prevent duplicate checks while
      ``_violation_messages`` independently de-duplicates equal diagnostics and
      ``violations`` preserves first-seen order. State-only ``finally`` replay
      snapshots and restores all three diagnostic collections so repeated traversal
      contributes transfer state without repeating diagnostics.
    * ``_named_expr_target_scope_indexes`` contains indexes into
      ``_metadata_alias_scopes`` for active comprehensions. The first iterable is
      visited before the implicit comprehension scope is pushed; afterward, named
      expression targets are written to the containing non-comprehension scope and
      the current comprehension state. Nested comprehensions reuse that containing
      target, while entry into a new lexical scope resets the index stack.
    * ``_implicit_exception_alias_scope_projections`` projects implicit
      comprehension-local aliases back to the surrounding scopes that remain
      visible if eager comprehension evaluation fails. Generator-expression
      runtime evaluation is isolated because it is deferred.
    * ``_loop_control_alias_scopes`` retains aliases from explicit ``break`` and
      ``continue`` exits for the nearest loop. Break exits reach the post-loop join,
      while continue backedges reach the next iteration or truth test. Assignment
      targets are visited in binding order so a later fallible attribute or
      subscript target observes earlier name bindings. Context-manager sequence
      targets record their outer unpack before that traversal; because those
      bindings only remove metadata aliases, the pre-binding state covers nested
      partial-binding failures.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self.violations: list[str] = []
        self._violation_messages: set[str] = set()
        self._metadata_alias_scopes: list[set[str]] = [set()]
        self._exception_alias_scopes: list[_ExceptionAliasState] = []
        self._class_nested_scope_alias_scopes: list[set[str]] = []
        self._metadata_key_checked_node_ids: set[int] = set()
        self._named_expr_target_scope_indexes: list[int] = []
        self._implicit_exception_alias_scope_projections: list[tuple[int, set[str]]] = []
        self._loop_control_alias_scopes: list[_LoopControlAliasState] = []

    @property
    def _metadata_aliases(self) -> set[str]:
        return self._metadata_alias_scopes[-1]

    @property
    def _named_expr_target_aliases(self) -> set[str]:
        if not self._named_expr_target_scope_indexes:
            return self._metadata_aliases
        return self._metadata_alias_scopes[self._named_expr_target_scope_indexes[-1]]

    def _add_violation(self, violation: str) -> None:
        if violation in self._violation_messages:
            return
        self._violation_messages.add(violation)
        self.violations.append(violation)

    def _add_violations(self, violations: list[str]) -> None:
        for violation in violations:
            self._add_violation(violation)

    @overload
    def visit(self, node: ast.stmt) -> bool: ...

    @overload
    def visit(self, node: ast.AST) -> None: ...

    def visit(self, node: ast.AST) -> bool | None:
        self._record_metadata_merge_key_violations(node)
        result = super().visit(node)
        if _is_modeled_implicit_exception_operation(node) and not isinstance(
            node, (ast.Compare, ast.FormattedValue)
        ):
            self._record_implicit_exception_aliases()
        if isinstance(node, ast.stmt):
            if not isinstance(result, bool):
                raise TypeError(f"{type(node).__name__} visitor must return statement flow")
            return result
        return None

    def _is_metadata_reference(self, node: ast.AST) -> bool:
        return (
            _is_metadata_attribute(node)
            or (isinstance(node, ast.Name) and node.id in self._metadata_aliases)
            or (isinstance(node, ast.NamedExpr) and self._is_metadata_alias_value(node.value))
        )

    def _is_metadata_alias_value(self, node: ast.AST) -> bool:
        if self._is_metadata_reference(node) or self._is_metadata_merge_value(node):
            return True
        if isinstance(node, ast.IfExp):
            return self._is_metadata_alias_value(node.body) or self._is_metadata_alias_value(
                node.orelse
            )
        if isinstance(node, ast.BoolOp):
            return any(self._is_metadata_alias_value(value) for value in node.values)
        if isinstance(node, ast.Await):
            return self._is_metadata_alias_value(node.value)
        if isinstance(node, ast.UnaryOp) and not isinstance(node.op, ast.Not):
            return self._is_metadata_alias_value(node.operand)
        return (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == "copy"
            and self._is_metadata_alias_value(node.func.value)
        )

    def _is_metadata_merge_value(self, node: ast.AST) -> bool:
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitOr):
            left_is_metadata = self._is_metadata_alias_value(node.left)
            right_is_metadata = self._is_metadata_alias_value(node.right)
            return left_is_metadata or right_is_metadata
        if isinstance(node, ast.Dict) and any(
            key is None and self._is_metadata_alias_value(value)
            for key, value in zip(node.keys, node.values, strict=True)
        ):
            return True
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "dict"
        ):
            positional_metadata = any(
                self._is_metadata_alias_value(argument) for argument in node.args
            )
            unpacked_keyword_metadata = any(
                keyword.arg is None and self._is_metadata_alias_value(keyword.value)
                for keyword in node.keywords
            )
            return positional_metadata or unpacked_keyword_metadata
        return False

    def _metadata_merge_key_violations(self, node: ast.AST) -> list[str]:
        if self._is_metadata_merge_value(node):
            return _metadata_dict_key_violations(self.path, node)
        if isinstance(node, ast.IfExp):
            return [
                *self._metadata_merge_key_violations(node.body),
                *self._metadata_merge_key_violations(node.orelse),
            ]
        if isinstance(node, ast.BoolOp):
            violations: list[str] = []
            for value in node.values:
                violations.extend(self._metadata_merge_key_violations(value))
            return violations
        return []

    def _record_metadata_merge_key_violations(self, node: ast.AST | None) -> None:
        if node is None:
            return
        node_id = id(node)
        if node_id in self._metadata_key_checked_node_ids:
            return
        violations = self._metadata_merge_key_violations(node)
        if not violations:
            return
        self._metadata_key_checked_node_ids.add(node_id)
        self._add_violations(violations)

    def _record_metadata_dict_key_violations(self, node: ast.AST | None) -> None:
        if node is None:
            return
        node_id = id(node)
        if node_id in self._metadata_key_checked_node_ids:
            return
        violations = _metadata_dict_key_violations(self.path, node)
        if not violations:
            return
        self._metadata_key_checked_node_ids.add(node_id)
        self._add_violations(violations)

    def _record_metadata_dict_keyword_violations(self, keywords: list[ast.keyword]) -> None:
        for keyword in keywords:
            if keyword.arg is None:
                self._record_metadata_dict_key_violations(keyword.value)
                continue
            key_name = _REGISTERED_METADATA_KEYS.get(keyword.arg)
            if key_name is not None:
                self._add_violation(_violation(self.path, keyword, key_name))

    def _record_metadata_subscript_key_violations(self, node: ast.Subscript) -> None:
        if self._is_metadata_alias_value(node.value):
            self._add_violations(_metadata_key_expression_violations(self.path, node.slice))

    def _metadata_default_argument_names(self, args: ast.arguments) -> set[str]:
        metadata_defaults: set[str] = set()
        positional_args = [*args.posonlyargs, *args.args]
        default_offset = len(positional_args) - len(args.defaults)
        for arg, default in zip(positional_args[default_offset:], args.defaults, strict=True):
            if self._is_metadata_alias_value(default):
                metadata_defaults.add(arg.arg)
        for arg, default in zip(args.kwonlyargs, args.kw_defaults, strict=True):
            if default is not None and self._is_metadata_alias_value(default):
                metadata_defaults.add(arg.arg)
        return metadata_defaults

    def _visit_default_value(self, node: ast.AST) -> None:
        self._record_metadata_merge_key_violations(node)
        self.visit(node)

    def _replace_current_aliases(self, aliases: set[str]) -> None:
        self._metadata_aliases.clear()
        self._metadata_aliases.update(aliases)

    def _alias_scope_snapshot(self) -> list[set[str]]:
        return [set(aliases) for aliases in self._metadata_alias_scopes]

    def _restore_alias_scope_snapshot(self, snapshot: list[set[str]]) -> None:
        for aliases, saved_aliases in zip(self._metadata_alias_scopes, snapshot, strict=True):
            aliases.clear()
            aliases.update(saved_aliases)

    def _merge_alias_scope_snapshots(self, snapshots: list[list[set[str]]]) -> None:
        for scope_index, aliases in enumerate(self._metadata_alias_scopes):
            aliases.clear()
            for snapshot in snapshots:
                aliases.update(snapshot[scope_index])

    def _record_exception_aliases(self, aliases: set[str] | None = None) -> None:
        if not self._exception_alias_scopes:
            return
        self._exception_alias_scopes[-1].record(
            self._metadata_aliases if aliases is None else aliases
        )

    def _record_exception_state(self, state: _ExceptionAliasState) -> None:
        if state.may_raise:
            self._record_exception_aliases(state.aliases)

    def _project_implicit_exception_aliases(self, aliases: set[str]) -> set[str]:
        projected_aliases = set(aliases)
        for scope_index, local_names in reversed(self._implicit_exception_alias_scope_projections):
            projected_aliases.difference_update(local_names)
            projected_aliases.update(self._metadata_alias_scopes[scope_index] & local_names)
        return projected_aliases

    def _record_implicit_exception_aliases(self, aliases: set[str] | None = None) -> None:
        self._record_exception_aliases(
            self._project_implicit_exception_aliases(
                self._metadata_aliases if aliases is None else aliases
            )
        )

    def _record_truth_test_exception(self, node: ast.AST) -> None:
        if _truth_test_may_raise(node):
            self._record_implicit_exception_aliases()

    def _visit_definition_expression(
        self,
        node: ast.AST,
        shadowed_names: set[str],
        *,
        check_metadata_merge: bool = False,
    ) -> None:
        outer_aliases = set(self._metadata_aliases)
        self._metadata_aliases.difference_update(shadowed_names)
        if check_metadata_merge:
            self._record_metadata_merge_key_violations(node)
        self.visit(node)
        expression_aliases = set(self._metadata_aliases)
        self._replace_current_aliases(
            (expression_aliases - shadowed_names) | (outer_aliases & shadowed_names)
        )

    def _visit_deferred_expression(
        self, node: ast.AST, shadowed_names: set[str] | None = None
    ) -> None:
        shadowed = set() if shadowed_names is None else shadowed_names
        outer_aliases = set(self._metadata_aliases)
        self._metadata_aliases.difference_update(shadowed)
        self._exception_alias_scopes.append(_ExceptionAliasState())
        self._record_metadata_merge_key_violations(node)
        self.visit(node)
        self._exception_alias_scopes.pop()
        expression_aliases = set(self._metadata_aliases)
        self._replace_current_aliases((expression_aliases - shadowed) | (outer_aliases & shadowed))

    def _visit_annotation_target(self, node: ast.AST) -> None:
        if isinstance(node, ast.Attribute):
            self._record_metadata_merge_key_violations(node.value)
            self.visit(node.value)
            return
        if isinstance(node, ast.Subscript):
            self._record_metadata_merge_key_violations(node.value)
            self._record_metadata_merge_key_violations(node.slice)
            self._record_metadata_subscript_key_violations(node)
            self.visit(node.value)
            self.visit(node.slice)

    def _nested_function_base_aliases(self) -> set[str]:
        if self._class_nested_scope_alias_scopes:
            return set(self._class_nested_scope_alias_scopes[-1])
        return set(self._metadata_aliases)

    def _visit_current_scope_body(self, body: list[ast.stmt]) -> bool:
        return all(self.visit(statement) for statement in body)

    def _visit_branch_body(self, body: list[ast.stmt], aliases: set[str]) -> tuple[set[str], bool]:
        self._metadata_alias_scopes.append(set(aliases))
        falls_through = self._visit_current_scope_body(body)
        result = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        return result, falls_through

    def _visit_branch_body_capturing_exceptions(
        self, body: list[ast.stmt], aliases: set[str]
    ) -> tuple[set[str], bool, _ExceptionAliasState]:
        exception_state = _ExceptionAliasState()
        self._exception_alias_scopes.append(exception_state)
        result_aliases, falls_through = self._visit_branch_body(body, aliases)
        self._exception_alias_scopes.pop()
        return result_aliases, falls_through, exception_state

    def _visit_branch_body_state_only(
        self, body: list[ast.stmt], aliases: set[str]
    ) -> tuple[set[str], bool]:
        violation_count = len(self.violations)
        violation_messages = set(self._violation_messages)
        checked_node_ids = set(self._metadata_key_checked_node_ids)
        result = self._visit_branch_body(body, aliases)
        del self.violations[violation_count:]
        self._violation_messages = violation_messages
        self._metadata_key_checked_node_ids = checked_node_ids
        return result

    def _visit_except_handler_branch(
        self, handler: ast.ExceptHandler, aliases: set[str]
    ) -> tuple[set[str], bool]:
        self._metadata_alias_scopes.append(set(aliases))
        if handler.type is not None:
            self._record_metadata_merge_key_violations(handler.type)
            self.visit(handler.type)
        if handler.name is not None:
            self._metadata_aliases.discard(handler.name)
        falls_through = self._visit_current_scope_body(handler.body)
        result = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        return result, falls_through

    def _visit_except_handler_branch_capturing_exceptions(
        self, handler: ast.ExceptHandler, aliases: set[str]
    ) -> tuple[set[str], bool, _ExceptionAliasState]:
        exception_state = _ExceptionAliasState()
        self._exception_alias_scopes.append(exception_state)
        result_aliases, falls_through = self._visit_except_handler_branch(handler, aliases)
        self._exception_alias_scopes.pop()
        if handler.name is not None:
            exception_state.aliases.discard(handler.name)
        return result_aliases, falls_through, exception_state

    def _visit_scoped_body(
        self,
        body: list[ast.stmt],
        shadowed: set[str] | None = None,
        added: set[str] | None = None,
        base_aliases: set[str] | None = None,
    ) -> bool:
        aliases = set(self._metadata_aliases if base_aliases is None else base_aliases)
        if shadowed is not None:
            aliases.difference_update(shadowed)
        if added is not None:
            aliases.update(added)
        self._metadata_alias_scopes.append(aliases)
        previous_named_expr_target_scope_indexes = self._named_expr_target_scope_indexes
        self._named_expr_target_scope_indexes = []
        falls_through = self._visit_current_scope_body(body)
        self._named_expr_target_scope_indexes = previous_named_expr_target_scope_indexes
        self._metadata_alias_scopes.pop()
        return falls_through

    def _visit_scoped_expression(
        self,
        expression: ast.AST,
        shadowed: set[str] | None = None,
        added: set[str] | None = None,
        base_aliases: set[str] | None = None,
    ) -> None:
        aliases = set(self._metadata_aliases if base_aliases is None else base_aliases)
        if shadowed is not None:
            aliases.difference_update(shadowed)
        if added is not None:
            aliases.update(added)
        self._metadata_alias_scopes.append(aliases)
        previous_named_expr_target_scope_indexes = self._named_expr_target_scope_indexes
        self._named_expr_target_scope_indexes = []
        self._record_metadata_merge_key_violations(expression)
        self.visit(expression)
        self._named_expr_target_scope_indexes = previous_named_expr_target_scope_indexes
        self._metadata_alias_scopes.pop()

    def _visit_function_definition(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
        for decorator in node.decorator_list:
            self._visit_definition_expression(decorator, set(), check_metadata_merge=True)
        type_param_names = _type_param_names(node)
        for type_param in _type_params(node):
            self._visit_deferred_expression(type_param, type_param_names)
        metadata_defaults = self._metadata_default_argument_names(node.args)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self._visit_default_value(default)
        for annotation in _argument_annotations(node.args):
            self._visit_deferred_expression(annotation, type_param_names)
        if node.returns is not None:
            self._visit_deferred_expression(node.returns, type_param_names)
        body_scope_bindings = _scope_bound_name_visitor(node.body)
        body_global_names = body_scope_bindings.global_names
        shadowed_names = (
            (
                _argument_names(node.args)
                | body_scope_bindings.local_names
                | (type_param_names - body_global_names)
            )
            - metadata_defaults
        ) | {node.name}
        body_base_aliases = self._nested_function_base_aliases()
        body_base_aliases.difference_update(body_global_names)
        body_base_aliases.update(self._metadata_alias_scopes[0] & body_global_names)
        self._exception_alias_scopes.append(_ExceptionAliasState())
        self._visit_scoped_body(node.body, shadowed_names, metadata_defaults, body_base_aliases)
        self._exception_alias_scopes.pop()
        if node.decorator_list:
            self._record_implicit_exception_aliases()
        self._metadata_aliases.discard(node.name)
        return True

    def visit_FunctionDef(self, node: ast.FunctionDef) -> bool:
        return self._visit_function_definition(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> bool:
        return self._visit_function_definition(node)

    def visit_Lambda(self, node: ast.Lambda) -> None:
        metadata_defaults = self._metadata_default_argument_names(node.args)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self._visit_default_value(default)
        self._exception_alias_scopes.append(_ExceptionAliasState())
        self._visit_scoped_expression(
            node.body,
            (_argument_names(node.args) | _expression_bound_names(node.body)) - metadata_defaults,
            metadata_defaults,
            self._nested_function_base_aliases(),
        )
        self._exception_alias_scopes.pop()

    def visit_ClassDef(self, node: ast.ClassDef) -> bool:
        for decorator in node.decorator_list:
            self._visit_definition_expression(decorator, set(), check_metadata_merge=True)
        type_param_names = _type_param_names(node)
        for type_param in _type_params(node):
            self._visit_deferred_expression(type_param, type_param_names)
        for base in node.bases:
            self._visit_definition_expression(base, type_param_names, check_metadata_merge=True)
        for keyword in node.keywords:
            self._visit_definition_expression(keyword, type_param_names, check_metadata_merge=True)
        outer_aliases = self._nested_function_base_aliases() - type_param_names
        class_scope_bindings = _scope_bound_name_visitor(node.body)
        class_body_bound_names = class_scope_bindings.local_names
        class_body_global_names = class_scope_bindings.global_names
        class_body_aliases = outer_aliases - class_body_bound_names - class_body_global_names
        class_body_aliases.update(
            self._metadata_alias_scopes[0] & (class_body_bound_names | class_body_global_names)
        )
        class_failure_aliases = set(self._metadata_aliases)
        class_exception_state = _ExceptionAliasState()
        self._exception_alias_scopes.append(class_exception_state)
        self._class_nested_scope_alias_scopes.append(outer_aliases)
        body_falls_through = self._visit_scoped_body(node.body, base_aliases=class_body_aliases)
        self._class_nested_scope_alias_scopes.pop()
        self._exception_alias_scopes.pop()
        if class_exception_state.may_raise:
            outer_visible_names = (
                (class_failure_aliases | class_exception_state.aliases)
                - class_body_bound_names
                - class_body_global_names
                - type_param_names
            )
            class_failure_aliases.difference_update(outer_visible_names)
            class_failure_aliases.update(class_exception_state.aliases & outer_visible_names)
            self._record_exception_aliases(class_failure_aliases)
        if node.decorator_list:
            self._record_implicit_exception_aliases()
        self._metadata_aliases.discard(node.name)
        return body_falls_through

    def visit_TypeAlias(self, node: ast.AST) -> bool:
        type_param_names = _type_param_names(node)
        target_names = _type_alias_target_names(node)
        shadowed_names = type_param_names | target_names
        for type_param in _type_params(node):
            self._visit_deferred_expression(type_param, shadowed_names)
        value = _type_alias_value(node)
        if value is not None:
            self._visit_deferred_expression(value, shadowed_names)
        for name in target_names:
            self._metadata_aliases.discard(name)
        return True

    def _visit_type_parameter(self, node: ast.AST) -> None:
        for _field_name, value in ast.iter_fields(node):
            if isinstance(value, ast.AST):
                self._record_metadata_merge_key_violations(value)
                self.visit(value)
            elif isinstance(value, list):
                for item in value:
                    if isinstance(item, ast.AST):
                        self._record_metadata_merge_key_violations(item)
                        self.visit(item)

    def visit_TypeVar(self, node: ast.AST) -> None:
        self._visit_type_parameter(node)

    def visit_ParamSpec(self, node: ast.AST) -> None:
        self._visit_type_parameter(node)

    def visit_TypeVarTuple(self, node: ast.AST) -> None:
        self._visit_type_parameter(node)

    def visit_Assign(self, node: ast.Assign) -> bool:
        if any(_is_metadata_attribute(target) for target in node.targets):
            self._record_metadata_dict_key_violations(node.value)
        else:
            self._record_metadata_merge_key_violations(node.value)
        value_is_metadata_alias = self._is_metadata_alias_value(node.value)
        self.visit(node.value)
        for target in node.targets:
            self._visit_assignment_target(
                target,
                direct_value_is_metadata_alias=(
                    value_is_metadata_alias and isinstance(target, ast.Name)
                ),
            )
        return True

    def visit_AnnAssign(self, node: ast.AnnAssign) -> bool:
        if _is_metadata_attribute(node.target):
            self._record_metadata_dict_key_violations(node.value)
        elif node.value is not None:
            self._record_metadata_merge_key_violations(node.value)
        value_is_metadata_alias = node.value is not None and self._is_metadata_alias_value(
            node.value
        )
        if node.value is not None:
            self.visit(node.value)
            self._visit_assignment_target(
                node.target,
                direct_value_is_metadata_alias=(
                    value_is_metadata_alias and isinstance(node.target, ast.Name)
                ),
            )
        else:
            self._visit_annotation_target(node.target)
        self._visit_deferred_expression(node.annotation)
        return True

    def visit_AugAssign(self, node: ast.AugAssign) -> bool:
        target_is_metadata = self._is_metadata_reference(node.target)
        value_is_metadata_merge = self._is_metadata_merge_value(node.value)
        if target_is_metadata:
            self._record_metadata_dict_key_violations(node.value)
        elif value_is_metadata_merge:
            self._record_metadata_merge_key_violations(node.value)
        self.visit(node.target)
        self.visit(node.value)
        self._record_implicit_exception_aliases()
        if (
            isinstance(node.op, ast.BitOr)
            and isinstance(node.target, ast.Name)
            and (target_is_metadata or value_is_metadata_merge)
        ):
            self._metadata_aliases.add(node.target.id)
        return True

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        if isinstance(node.target, ast.Name):
            is_metadata_alias = self._is_metadata_alias_value(node.value)
            self._record_metadata_merge_key_violations(node.value)
            self.visit(node.value)
            target_aliases = self._named_expr_target_aliases
            if is_metadata_alias:
                target_aliases.add(node.target.id)
                self._metadata_aliases.add(node.target.id)
            else:
                target_aliases.discard(node.target.id)
                self._metadata_aliases.discard(node.target.id)
            return
        self.visit(node.value)

    def _visit_sequence_expression(self, node: ast.List | ast.Tuple) -> None:
        for element in node.elts:
            self._record_metadata_merge_key_violations(element)
        self.generic_visit(node)

    def visit_List(self, node: ast.List) -> None:
        self._visit_sequence_expression(node)

    def visit_Tuple(self, node: ast.Tuple) -> None:
        self._visit_sequence_expression(node)

    def visit_Set(self, node: ast.Set) -> None:
        for element in node.elts:
            self._record_metadata_merge_key_violations(element)
        for element in node.elts:
            self.visit(element)
            if not isinstance(element, ast.Starred):
                self._record_implicit_exception_aliases()

    def visit_Dict(self, node: ast.Dict) -> None:
        node_is_metadata_merge = self._is_metadata_merge_value(node)
        for key, value in zip(node.keys, node.values, strict=True):
            self._record_metadata_merge_key_violations(key)
            if key is not None or not node_is_metadata_merge:
                self._record_metadata_merge_key_violations(value)
        for key, value in zip(node.keys, node.values, strict=True):
            if key is not None:
                self.visit(key)
            self.visit(value)
            if key is not None:
                self._record_implicit_exception_aliases()

    def visit_BinOp(self, node: ast.BinOp) -> None:
        if not self._is_metadata_merge_value(node):
            self._record_metadata_merge_key_violations(node.left)
            self._record_metadata_merge_key_violations(node.right)
        self.generic_visit(node)

    def visit_BoolOp(self, node: ast.BoolOp) -> None:
        exit_snapshots: list[list[set[str]]] = []
        for index, value in enumerate(node.values):
            self.visit(value)
            if index == len(node.values) - 1:
                exit_snapshots.append(self._alias_scope_snapshot())
                break
            self._record_truth_test_exception(value)
            truth_value = _static_truth_value(value)
            stops_on_value = (isinstance(node.op, ast.And) and truth_value is not True) or (
                isinstance(node.op, ast.Or) and truth_value is not False
            )
            continues_after_value = (isinstance(node.op, ast.And) and truth_value is not False) or (
                isinstance(node.op, ast.Or) and truth_value is not True
            )
            if stops_on_value:
                exit_snapshots.append(self._alias_scope_snapshot())
            if not continues_after_value:
                break
        if exit_snapshots:
            self._merge_alias_scope_snapshots(exit_snapshots)

    def visit_IfExp(self, node: ast.IfExp) -> None:
        self.visit(node.test)
        self._record_truth_test_exception(node.test)
        test_truth = _static_truth_value(node.test)
        branch_entry = self._alias_scope_snapshot()
        branch_exits: list[list[set[str]]] = []
        if test_truth is not False:
            self.visit(node.body)
            branch_exits.append(self._alias_scope_snapshot())
        if test_truth is not True:
            self._restore_alias_scope_snapshot(branch_entry)
            self.visit(node.orelse)
            branch_exits.append(self._alias_scope_snapshot())
        self._merge_alias_scope_snapshots(branch_exits)

    def visit_UnaryOp(self, node: ast.UnaryOp) -> None:
        self._record_metadata_merge_key_violations(node.operand)
        self.generic_visit(node)

    def visit_Await(self, node: ast.Await) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Starred(self, node: ast.Starred) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_FormattedValue(self, node: ast.FormattedValue) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.visit(node.value)
        # Conversion precedes the optional spec; final formatting always follows both.
        if node.conversion != -1:
            self._record_implicit_exception_aliases()
        if node.format_spec is not None:
            self.visit(node.format_spec)
        self._record_implicit_exception_aliases()

    def visit_Slice(self, node: ast.Slice) -> None:
        self._record_metadata_merge_key_violations(node.lower)
        self._record_metadata_merge_key_violations(node.upper)
        self._record_metadata_merge_key_violations(node.step)
        self.generic_visit(node)

    def visit_Subscript(self, node: ast.Subscript) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self._record_metadata_merge_key_violations(node.slice)
        self._record_metadata_subscript_key_violations(node)
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call) -> None:
        node_is_metadata_merge = self._is_metadata_merge_value(node)
        self._record_metadata_merge_key_violations(node)
        self._record_metadata_merge_key_violations(node.func)
        for index, argument in enumerate(node.args):
            if not node_is_metadata_merge or index > 0 or isinstance(argument, ast.Starred):
                self._record_metadata_merge_key_violations(argument)
        for keyword in node.keywords:
            if not (node_is_metadata_merge and keyword.arg is None):
                self._record_metadata_merge_key_violations(keyword.value)
        if isinstance(node.func, ast.Attribute) and self._is_metadata_alias_value(node.func.value):
            if node.func.attr in _METADATA_METHODS_WITH_KEY_ARGUMENTS and node.args:
                for key_arg in _static_first_call_argument_nodes(node.args):
                    self._add_violations(_metadata_key_expression_violations(self.path, key_arg))
            if node.func.attr in _METADATA_METHODS_WITH_DICT_ARGUMENTS:
                for update_arg in _static_first_call_argument_nodes(node.args):
                    self._record_metadata_dict_key_violations(update_arg)
                self._record_metadata_dict_keyword_violations(node.keywords)
        direct_unbound_arguments = _direct_unbound_metadata_key_arguments(node)
        if direct_unbound_arguments is not None:
            mapping_arg, key_arg = direct_unbound_arguments
            if self._is_metadata_alias_value(mapping_arg):
                self._add_violations(_metadata_key_expression_violations(self.path, key_arg))
        direct_unbound_mapping_arguments = _direct_unbound_metadata_mapping_arguments(node)
        if direct_unbound_mapping_arguments is not None:
            mapping_arg, update_args, has_keyword_entries = direct_unbound_mapping_arguments
            if self._is_metadata_alias_value(mapping_arg):
                for update_arg in _static_first_call_argument_nodes(update_args):
                    self._record_metadata_dict_key_violations(update_arg)
                if has_keyword_entries:
                    self._record_metadata_dict_keyword_violations(node.keywords)
        self.visit(node.func)
        for argument in node.args:
            self.visit(argument)
        for keyword in node.keywords:
            self.visit(keyword.value)

    def visit_keyword(self, node: ast.keyword) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Expr(self, node: ast.Expr) -> bool:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)
        return True

    def visit_Return(self, node: ast.Return) -> bool:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)
        return False

    def visit_Assert(self, node: ast.Assert) -> bool:
        self._record_metadata_merge_key_violations(node.test)
        self._record_metadata_merge_key_violations(node.msg)
        self.visit(node.test)
        self._record_truth_test_exception(node.test)
        test_truth = _static_truth_value(node.test)
        normal_aliases = self._alias_scope_snapshot()
        if test_truth is not True and node.msg is not None:
            self.visit(node.msg)
        if test_truth is not True:
            self._record_implicit_exception_aliases()
        if test_truth is not False:
            self._restore_alias_scope_snapshot(normal_aliases)
        return test_truth is not False

    def visit_Raise(self, node: ast.Raise) -> bool:
        self._record_metadata_merge_key_violations(node.exc)
        self._record_metadata_merge_key_violations(node.cause)
        self.generic_visit(node)
        self._record_exception_aliases()
        return False

    def visit_Yield(self, node: ast.Yield) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_YieldFrom(self, node: ast.YieldFrom) -> None:
        self._record_metadata_merge_key_violations(node.value)
        self.generic_visit(node)

    def visit_Compare(self, node: ast.Compare) -> None:
        self._record_metadata_merge_key_violations(node.left)
        for comparator in node.comparators:
            self._record_metadata_merge_key_violations(comparator)
        if (
            len(node.comparators) == 1
            and isinstance(node.ops[0], (ast.In, ast.NotIn))
            and self._is_metadata_alias_value(node.comparators[0])
        ):
            self._add_violations(_metadata_key_expression_violations(self.path, node.left))
        self.visit(node.left)
        exit_snapshots: list[list[set[str]]] = []
        for index, comparator in enumerate(node.comparators):
            self.visit(comparator)
            if _comparison_operator_may_raise(node.ops[index]):
                self._record_implicit_exception_aliases()
            if index < len(node.comparators) - 1:
                exit_snapshots.append(self._alias_scope_snapshot())
        exit_snapshots.append(self._alias_scope_snapshot())
        self._merge_alias_scope_snapshots(exit_snapshots)

    def visit_Delete(self, node: ast.Delete) -> bool:
        for target in node.targets:
            self._visit_delete_target(target)
        return True

    def visit_Pass(self, node: ast.Pass) -> bool:
        return True

    def visit_Global(self, node: ast.Global) -> bool:
        return True

    def visit_Nonlocal(self, node: ast.Nonlocal) -> bool:
        return True

    def visit_Break(self, node: ast.Break) -> bool:
        if self._loop_control_alias_scopes:
            self._loop_control_alias_scopes[-1].record_break(self._metadata_aliases)
        return False

    def visit_Continue(self, node: ast.Continue) -> bool:
        if self._loop_control_alias_scopes:
            self._loop_control_alias_scopes[-1].record_continue(self._metadata_aliases)
        return False

    def _visit_delete_target(self, target: ast.AST) -> None:
        if isinstance(target, (ast.List, ast.Tuple)):
            for element in target.elts:
                self._visit_delete_target(element)
            return
        self.visit(target)
        for name in _target_names(target):
            self._metadata_aliases.discard(name)

    def visit_If(self, node: ast.If) -> bool:
        self._record_metadata_merge_key_violations(node.test)
        self.visit(node.test)
        self._record_truth_test_exception(node.test)
        base_aliases = set(self._metadata_aliases)
        test_truth = _static_truth_value(node.test)
        if test_truth is not False:
            body_aliases, body_falls_through = self._visit_branch_body(node.body, base_aliases)
        else:
            body_falls_through = False
        if test_truth is not True and node.orelse:
            orelse_aliases, orelse_falls_through = self._visit_branch_body(
                node.orelse, base_aliases
            )
        elif test_truth is True:
            orelse_aliases = set()
            orelse_falls_through = False
        else:
            orelse_aliases = base_aliases
            orelse_falls_through = True
        exit_aliases: set[str] = set()
        if body_falls_through:
            exit_aliases.update(body_aliases)
        if orelse_falls_through:
            exit_aliases.update(orelse_aliases)
        self._replace_current_aliases(exit_aliases)
        return body_falls_through or orelse_falls_through

    def _visit_loop_body(
        self, body: list[ast.stmt], aliases: set[str]
    ) -> tuple[set[str], bool, _LoopControlAliasState]:
        loop_control_state = _LoopControlAliasState()
        self._loop_control_alias_scopes.append(loop_control_state)
        body_aliases, body_falls_through = self._visit_branch_body(body, aliases)
        self._loop_control_alias_scopes.pop()
        backedge_aliases = set(loop_control_state.continue_aliases)
        if body_falls_through:
            backedge_aliases.update(body_aliases)
        may_repeat = body_falls_through or loop_control_state.may_continue
        return backedge_aliases, may_repeat, loop_control_state

    def _visit_loop_else_and_join_exits(
        self,
        orelse: list[ast.stmt],
        exhaustion_aliases: set[str],
        loop_control_state: _LoopControlAliasState,
    ) -> bool:
        if orelse:
            orelse_aliases, orelse_falls_through = self._visit_branch_body(
                orelse, exhaustion_aliases
            )
        else:
            orelse_aliases = exhaustion_aliases
            orelse_falls_through = True
        loop_exit_aliases = set(loop_control_state.break_aliases)
        if orelse_falls_through:
            loop_exit_aliases.update(orelse_aliases)
        self._replace_current_aliases(loop_exit_aliases)
        return loop_control_state.may_break or orelse_falls_through

    def _visit_for_statement(self, node: ast.For | ast.AsyncFor) -> bool:
        self._record_metadata_merge_key_violations(node.iter)
        self.visit(node.iter)
        iteration_may_raise = isinstance(node, ast.AsyncFor) or _iteration_may_raise(
            node.iter, advances=True
        )
        if iteration_may_raise:
            self._record_implicit_exception_aliases()
        base_aliases = set(self._metadata_aliases)
        if isinstance(node, ast.For) and _iterable_is_statically_empty(node.iter):
            if node.orelse:
                orelse_aliases, orelse_falls_through = self._visit_branch_body(
                    node.orelse, base_aliases
                )
            else:
                orelse_aliases = base_aliases
                orelse_falls_through = True
            self._replace_current_aliases(orelse_aliases)
            return orelse_falls_through
        entry_aliases = set(base_aliases)
        loop_control_state = _LoopControlAliasState()
        remaining_iterations = (
            _literal_iteration_limit(node.iter) if isinstance(node, ast.For) else None
        )
        while True:
            self._replace_current_aliases(entry_aliases)
            self._visit_assignment_target(node.target, direct_value_is_metadata_alias=False)
            backedge_aliases, may_repeat, body_control_state = self._visit_loop_body(
                node.body, set(self._metadata_aliases)
            )
            loop_control_state.merge(body_control_state)
            if iteration_may_raise and may_repeat:
                self._record_implicit_exception_aliases(backedge_aliases)
            if backedge_aliases <= entry_aliases:
                break
            entry_aliases.update(backedge_aliases)
            if remaining_iterations is not None:
                remaining_iterations -= 1
                if remaining_iterations == 0:
                    break
        return self._visit_loop_else_and_join_exits(node.orelse, entry_aliases, loop_control_state)

    def visit_For(self, node: ast.For) -> bool:
        return self._visit_for_statement(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> bool:
        return self._visit_for_statement(node)

    def visit_While(self, node: ast.While) -> bool:
        self._record_metadata_merge_key_violations(node.test)
        self.visit(node.test)
        self._record_truth_test_exception(node.test)
        base_aliases = set(self._metadata_aliases)
        if _static_truth_value(node.test) is False:
            if node.orelse:
                orelse_aliases, orelse_falls_through = self._visit_branch_body(
                    node.orelse, base_aliases
                )
            else:
                orelse_aliases = base_aliases
                orelse_falls_through = True
            self._replace_current_aliases(orelse_aliases)
            return orelse_falls_through
        entry_aliases = set(base_aliases)
        loop_control_state = _LoopControlAliasState()
        while True:
            backedge_aliases, may_repeat, body_control_state = self._visit_loop_body(
                node.body, entry_aliases
            )
            loop_control_state.merge(body_control_state)
            if not may_repeat:
                break
            self._replace_current_aliases(backedge_aliases)
            self.visit(node.test)
            self._record_truth_test_exception(node.test)
            later_test_aliases = set(self._metadata_aliases)
            if later_test_aliases <= entry_aliases:
                break
            entry_aliases.update(later_test_aliases)
        return self._visit_loop_else_and_join_exits(node.orelse, entry_aliases, loop_control_state)

    def _visit_with_items(self, items: list[ast.withitem], body: list[ast.stmt]) -> bool:
        item, *remaining_items = items
        self._record_metadata_merge_key_violations(item.context_expr)
        self.visit(item.context_expr)
        body_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.append(body_aliases)
        exception_state = _ExceptionAliasState()
        self._exception_alias_scopes.append(exception_state)
        if item.optional_vars is not None:
            if _target_requires_unpacking(item.optional_vars):
                self._record_implicit_exception_aliases()
            self._visit_assignment_target(item.optional_vars, direct_value_is_metadata_alias=False)
        protected_region_falls_through = (
            self._visit_with_items(remaining_items, body)
            if remaining_items
            else self._visit_current_scope_body(body)
        )
        self._exception_alias_scopes.pop()
        body_result_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        exit_aliases = body_result_aliases if protected_region_falls_through else set()
        exit_aliases.update(exception_state.aliases)
        self._replace_current_aliases(exit_aliases)
        self._record_exception_state(exception_state)
        return protected_region_falls_through or exception_state.may_raise

    def _visit_with_statement(self, node: ast.With | ast.AsyncWith) -> bool:
        return self._visit_with_items(node.items, node.body)

    def visit_With(self, node: ast.With) -> bool:
        return self._visit_with_statement(node)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> bool:
        return self._visit_with_statement(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.type is not None:
            self._record_metadata_merge_key_violations(node.type)
            self.visit(node.type)
        base_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.append(base_aliases)
        if node.name is not None:
            self._metadata_aliases.discard(node.name)
        self._visit_current_scope_body(node.body)
        result_aliases = set(self._metadata_aliases)
        self._metadata_alias_scopes.pop()
        self._replace_current_aliases(base_aliases | result_aliases)

    def _visit_try_statement(self, node: ast.Try) -> bool:
        outer_loop_control_state = (
            self._loop_control_alias_scopes[-1] if self._loop_control_alias_scopes else None
        )
        try_loop_control_state = (
            _LoopControlAliasState() if outer_loop_control_state is not None else None
        )
        body_loop_control_state = (
            _LoopControlAliasState() if try_loop_control_state is not None else None
        )
        if body_loop_control_state is not None:
            self._loop_control_alias_scopes.append(body_loop_control_state)
        base_aliases = set(self._metadata_aliases)
        body_aliases, body_falls_through, body_exception_state = (
            self._visit_branch_body_capturing_exceptions(node.body, base_aliases)
        )
        if body_loop_control_state is not None and try_loop_control_state is not None:
            self._loop_control_alias_scopes.pop()
            try_loop_control_state.merge(body_loop_control_state)
        handler_start_aliases = base_aliases | body_aliases | body_exception_state.aliases
        handler_results: list[tuple[set[str], bool, _ExceptionAliasState]] = []
        for handler in node.handlers:
            handler_loop_control_state = (
                _LoopControlAliasState() if try_loop_control_state is not None else None
            )
            if handler_loop_control_state is not None:
                self._loop_control_alias_scopes.append(handler_loop_control_state)
            handler_results.append(
                self._visit_except_handler_branch_capturing_exceptions(
                    handler, handler_start_aliases
                )
            )
            if handler_loop_control_state is not None and try_loop_control_state is not None:
                self._loop_control_alias_scopes.pop()
                if body_exception_state.may_raise:
                    try_loop_control_state.merge(handler_loop_control_state)
        exit_aliases: set[str] = set()
        has_normal_exit = False
        exception_state = _ExceptionAliasState()
        if not any(handler.type is None for handler in node.handlers):
            exception_state.merge(body_exception_state)
        if body_falls_through:
            if node.orelse:
                orelse_loop_control_state = (
                    _LoopControlAliasState() if try_loop_control_state is not None else None
                )
                if orelse_loop_control_state is not None:
                    self._loop_control_alias_scopes.append(orelse_loop_control_state)
                orelse_aliases, orelse_falls_through, orelse_exception_state = (
                    self._visit_branch_body_capturing_exceptions(node.orelse, body_aliases)
                )
                if orelse_loop_control_state is not None and try_loop_control_state is not None:
                    self._loop_control_alias_scopes.pop()
                    try_loop_control_state.merge(orelse_loop_control_state)
                exception_state.merge(orelse_exception_state)
                if orelse_falls_through:
                    exit_aliases.update(orelse_aliases)
                    has_normal_exit = True
            else:
                exit_aliases.update(body_aliases)
                has_normal_exit = True
        for aliases, falls_through, handler_exception_state in handler_results:
            if body_exception_state.may_raise:
                exception_state.merge(handler_exception_state)
            if falls_through:
                exit_aliases.update(aliases)
                has_normal_exit = True
        falls_through = has_normal_exit
        if node.finalbody:
            finalbody_scan_aliases = (
                base_aliases
                | body_aliases
                | body_exception_state.aliases
                | exit_aliases
                | exception_state.aliases
            )
            for aliases, _falls_through, handler_exception_state in handler_results:
                finalbody_scan_aliases.update(aliases)
                finalbody_scan_aliases.update(handler_exception_state.aliases)
            if try_loop_control_state is not None:
                finalbody_scan_aliases.update(try_loop_control_state.break_aliases)
                finalbody_scan_aliases.update(try_loop_control_state.continue_aliases)
            finalbody_exception_state = _ExceptionAliasState()
            self._exception_alias_scopes.append(finalbody_exception_state)
            finalbody_scan_result, finalbody_falls_through = self._visit_branch_body(
                node.finalbody, finalbody_scan_aliases
            )
            falls_through = has_normal_exit and finalbody_falls_through
            if finalbody_scan_aliases == exit_aliases:
                exit_aliases = finalbody_scan_result
            elif has_normal_exit:
                exit_aliases = self._visit_branch_body_state_only(node.finalbody, exit_aliases)[0]
            if exception_state.may_raise and finalbody_falls_through:
                exception_state.aliases = (
                    finalbody_scan_result
                    if finalbody_scan_aliases == exception_state.aliases
                    else self._visit_branch_body_state_only(
                        node.finalbody, exception_state.aliases
                    )[0]
                )
            else:
                exception_state = _ExceptionAliasState()
            self._exception_alias_scopes.pop()
            if not finalbody_falls_through:
                exit_aliases = set()
            exception_state.merge(finalbody_exception_state)
            if (
                outer_loop_control_state is not None
                and try_loop_control_state is not None
                and try_loop_control_state.may_break
            ):
                break_aliases, break_falls_through = self._visit_branch_body_state_only(
                    node.finalbody, try_loop_control_state.break_aliases
                )
                if break_falls_through:
                    outer_loop_control_state.record_break(break_aliases)
            if (
                outer_loop_control_state is not None
                and try_loop_control_state is not None
                and try_loop_control_state.may_continue
            ):
                continued_aliases, continued_falls_through = self._visit_branch_body_state_only(
                    node.finalbody, try_loop_control_state.continue_aliases
                )
                if continued_falls_through:
                    outer_loop_control_state.record_continue(continued_aliases)
        elif outer_loop_control_state is not None and try_loop_control_state is not None:
            outer_loop_control_state.merge(try_loop_control_state)
        self._replace_current_aliases(exit_aliases)
        self._record_exception_state(exception_state)
        return falls_through

    def visit_Try(self, node: ast.Try) -> bool:
        return self._visit_try_statement(node)

    def visit_TryStar(self, node: ast.Try) -> bool:
        return self._visit_try_statement(node)

    def visit_Match(self, node: ast.Match) -> bool:
        subject_is_metadata = self._is_metadata_alias_value(node.subject)
        self._record_metadata_merge_key_violations(node.subject)
        self.visit(node.subject)
        continuing_aliases = set(self._metadata_aliases)
        exit_aliases: set[str] = set()
        case_falls_through = False
        has_unmatched_path = True
        for case in node.cases:
            if subject_is_metadata:
                self._record_metadata_match_pattern_key_violations(case.pattern)
            names = _pattern_names(case.pattern)
            pattern_is_exhaustive = _pattern_is_exhaustive(case.pattern)
            aliases = set(continuing_aliases)
            aliases.difference_update(names)
            if subject_is_metadata:
                aliases.update(_metadata_match_pattern_alias_names(case.pattern))
            self._metadata_alias_scopes.append(aliases)
            guard_truth: bool | None = True
            if case.guard is not None:
                self._record_metadata_merge_key_violations(case.guard)
                self.visit(case.guard)
                self._record_truth_test_exception(case.guard)
                guard_truth = _static_truth_value(case.guard)
            guard_aliases = set(self._metadata_aliases)
            falls_through = (
                self._visit_current_scope_body(case.body) if guard_truth is not False else False
            )
            if falls_through:
                case_falls_through = True
                exit_aliases.update(self._metadata_aliases)
            self._metadata_alias_scopes.pop()
            if case.guard is not None and guard_truth is not True:
                if pattern_is_exhaustive:
                    continuing_aliases = guard_aliases
                else:
                    continuing_aliases.update(guard_aliases)
            if guard_truth is True and pattern_is_exhaustive:
                has_unmatched_path = False
                break
        if has_unmatched_path:
            exit_aliases.update(continuing_aliases)
        self._replace_current_aliases(exit_aliases)
        return has_unmatched_path or case_falls_through

    def _record_metadata_match_pattern_key_violations(self, pattern: ast.pattern) -> None:
        if isinstance(pattern, ast.MatchMapping):
            for key in pattern.keys:
                self._add_violations(_metadata_key_expression_violations(self.path, key))
            return
        if isinstance(pattern, ast.MatchAs) and pattern.pattern is not None:
            self._record_metadata_match_pattern_key_violations(pattern.pattern)
            return
        if isinstance(pattern, ast.MatchOr):
            for child_pattern in pattern.patterns:
                self._record_metadata_match_pattern_key_violations(child_pattern)

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self._visit_comprehension(node.generators, [node.elt], deferred=False)

    def visit_SetComp(self, node: ast.SetComp) -> None:
        self._visit_comprehension(node.generators, [node.elt], deferred=False)

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        self._visit_comprehension(node.generators, [node.elt], deferred=True)

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self._visit_comprehension(node.generators, [node.key, node.value], deferred=False)

    def visit_Import(self, node: ast.Import) -> bool:
        for alias in node.names:
            self._metadata_aliases.discard(alias.asname or alias.name.split(".", maxsplit=1)[0])
        return True

    def visit_ImportFrom(self, node: ast.ImportFrom) -> bool:
        for alias in node.names:
            if alias.name == "*":
                self._metadata_aliases.clear()
            else:
                self._metadata_aliases.discard(alias.asname or alias.name)
        return True

    def _visit_assignment_target(
        self, target: ast.AST, *, direct_value_is_metadata_alias: bool
    ) -> None:
        if isinstance(target, ast.Name):
            if direct_value_is_metadata_alias:
                self._metadata_aliases.add(target.id)
            else:
                self._metadata_aliases.discard(target.id)
            return
        if isinstance(target, ast.Starred):
            self._visit_assignment_target(target.value, direct_value_is_metadata_alias=False)
            return
        if isinstance(target, (ast.List, ast.Tuple)):
            for element in target.elts:
                self._visit_assignment_target(element, direct_value_is_metadata_alias=False)
            return
        self.visit(target)

    def _visit_comprehension(
        self,
        generators: list[ast.comprehension],
        body_expressions: list[ast.AST],
        *,
        deferred: bool,
    ) -> None:
        if not generators:
            for expression in body_expressions:
                self.visit(expression)
            return

        first_generator, *remaining_generators = generators
        self._record_metadata_merge_key_violations(first_generator.iter)
        self.visit(first_generator.iter)
        if first_generator.is_async or _iteration_may_raise(
            first_generator.iter, advances=not deferred
        ):
            self._record_implicit_exception_aliases()
        if not first_generator.is_async and _iterable_is_statically_empty(first_generator.iter):
            return

        named_expr_target_scope_index = (
            self._named_expr_target_scope_indexes[-1]
            if self._named_expr_target_scope_indexes
            else len(self._metadata_alias_scopes) - 1
        )
        outer_scope_index = len(self._metadata_alias_scopes) - 1
        local_names: set[str] = set()
        for generator in generators:
            local_names.update(_target_names(generator.target))
        self._metadata_alias_scopes.append(self._nested_function_base_aliases())
        self._named_expr_target_scope_indexes.append(named_expr_target_scope_index)
        self._implicit_exception_alias_scope_projections.append((outer_scope_index, local_names))
        if deferred:
            self._exception_alias_scopes.append(_ExceptionAliasState())
        reached_generators = [first_generator]
        body_is_reachable = True
        self._visit_assignment_target(first_generator.target, direct_value_is_metadata_alias=False)
        for condition in first_generator.ifs:
            self._record_metadata_merge_key_violations(condition)
            self.visit(condition)
            self._record_truth_test_exception(condition)
            if _static_truth_value(condition) is not True:
                self._record_later_comprehension_iterations(reached_generators)
            if _static_truth_value(condition) is False:
                body_is_reachable = False
                break
        for generator in remaining_generators if body_is_reachable else []:
            self._record_metadata_merge_key_violations(generator.iter)
            self.visit(generator.iter)
            if generator.is_async or _iteration_may_raise(generator.iter, advances=True):
                self._record_implicit_exception_aliases()
            if not generator.is_async and _iterable_is_statically_empty(generator.iter):
                body_is_reachable = False
                break
            reached_generators.append(generator)
            self._visit_assignment_target(generator.target, direct_value_is_metadata_alias=False)
            for condition in generator.ifs:
                self._record_metadata_merge_key_violations(condition)
                self.visit(condition)
                self._record_truth_test_exception(condition)
                if _static_truth_value(condition) is not True:
                    self._record_later_comprehension_iterations(reached_generators)
                if _static_truth_value(condition) is False:
                    body_is_reachable = False
                    break
            if not body_is_reachable:
                break
        if body_is_reachable:
            for expression in body_expressions:
                self._record_metadata_merge_key_violations(expression)
                self.visit(expression)
            self._record_later_comprehension_iterations(reached_generators)
        if deferred:
            self._exception_alias_scopes.pop()
        self._implicit_exception_alias_scope_projections.pop()
        self._named_expr_target_scope_indexes.pop()
        self._metadata_alias_scopes.pop()

    def _record_later_comprehension_iterations(self, generators: list[ast.comprehension]) -> None:
        for generator in reversed(generators):
            if generator.is_async or _iteration_may_raise(generator.iter, advances=True):
                self._record_implicit_exception_aliases()
