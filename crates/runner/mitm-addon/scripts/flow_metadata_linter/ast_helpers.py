"""Generic Python AST helpers for flow metadata key linting."""

from __future__ import annotations

import ast
from dataclasses import dataclass

_STATIC_ITERABLE_WRAPPER_CALLS = {
    "frozenset",
    "iter",
    "list",
    "reversed",
    "set",
    "sorted",
    "tuple",
}
_MAPPING_PAIR_LENGTH = 2


@dataclass(frozen=True)
class _StaticIterableOutcomes:
    ordered: tuple[ast.AST | None, ...]

    @property
    def nodes(self) -> tuple[ast.AST, ...]:
        return tuple(node for node in self.ordered if node is not None)

    @property
    def may_be_empty(self) -> bool:
        return any(node is None for node in self.ordered)


def _target_requires_unpacking(node: ast.AST | None) -> bool:
    """Return whether binding ``node`` starts with structural sequence unpacking."""
    return isinstance(node, ast.List | ast.Tuple)


def _target_names(node: ast.AST | None) -> set[str]:
    if isinstance(node, ast.Name):
        return {node.id}
    if isinstance(node, ast.Starred):
        return _target_names(node.value)
    if isinstance(node, ast.List | ast.Tuple):
        names: set[str] = set()
        for element in node.elts:
            names.update(_target_names(element))
        return names
    return set()


def _argument_names(args: ast.arguments) -> set[str]:
    names = {arg.arg for arg in [*args.posonlyargs, *args.args, *args.kwonlyargs]}
    if args.vararg is not None:
        names.add(args.vararg.arg)
    if args.kwarg is not None:
        names.add(args.kwarg.arg)
    return names


def _argument_annotations(args: ast.arguments) -> list[ast.expr]:
    annotations = [
        arg.annotation for arg in [*args.posonlyargs, *args.args] if arg.annotation is not None
    ]
    if args.vararg is not None and args.vararg.annotation is not None:
        annotations.append(args.vararg.annotation)
    annotations.extend(arg.annotation for arg in args.kwonlyargs if arg.annotation is not None)
    if args.kwarg is not None and args.kwarg.annotation is not None:
        annotations.append(args.kwarg.annotation)
    return annotations


def _static_first_call_argument_nodes(args: list[ast.expr]) -> list[ast.AST]:
    """Return static nodes that can occupy a call's first positional argument."""
    return list(_static_first_call_argument_outcomes(args).nodes)


def _static_first_call_argument_outcomes(args: list[ast.expr]) -> _StaticIterableOutcomes:
    return _static_ordered_sequence_first_outcomes(args)


def _deduplicate_static_nodes(nodes: list[ast.AST]) -> list[ast.AST]:
    result: list[ast.AST] = []
    seen_node_ids: set[int] = set()
    for node in nodes:
        node_id = id(node)
        if node_id in seen_node_ids:
            continue
        seen_node_ids.add(node_id)
        result.append(node)
    return result


def _deduplicate_ordered_outcomes(
    outcomes: list[ast.AST | None],
) -> list[ast.AST | None]:
    result: list[ast.AST | None] = []
    seen_node_ids: set[int] = set()
    has_empty_outcome = False
    for outcome in outcomes:
        if outcome is None:
            if has_empty_outcome:
                continue
            has_empty_outcome = True
        else:
            node_id = id(outcome)
            if node_id in seen_node_ids:
                continue
            seen_node_ids.add(node_id)
        result.append(outcome)
    return result


def _static_outcomes(
    nodes: list[ast.AST] | tuple[ast.AST, ...], *, may_be_empty: bool
) -> _StaticIterableOutcomes:
    ordered: list[ast.AST | None] = [*_deduplicate_static_nodes(list(nodes))]
    if may_be_empty:
        ordered.append(None)
    return _StaticIterableOutcomes(tuple(ordered))


def _merge_static_alternatives(
    outcomes: list[_StaticIterableOutcomes],
) -> _StaticIterableOutcomes:
    return _StaticIterableOutcomes(
        tuple(
            _deduplicate_ordered_outcomes(
                [node for outcome in outcomes for node in outcome.ordered]
            )
        )
    )


def _static_iterable_first_outcomes(node: ast.AST) -> _StaticIterableOutcomes:
    """Return static first nodes and whether the iterable may be empty."""
    if isinstance(node, ast.NamedExpr):
        return _static_iterable_first_outcomes(node.value)
    if isinstance(node, ast.IfExp):
        return _merge_static_alternatives(
            [
                _static_iterable_first_outcomes(node.body),
                _static_iterable_first_outcomes(node.orelse),
            ]
        )
    if isinstance(node, ast.BoolOp):
        return _merge_static_alternatives(
            [_static_iterable_first_outcomes(value) for value in node.values]
        )
    if isinstance(node, ast.Dict | ast.DictComp):
        return _static_mapping_first_key_outcomes(node)
    if isinstance(node, ast.Set):
        return _static_set_outcomes(node)
    if isinstance(node, ast.SetComp):
        return _static_outcomes((node.elt,), may_be_empty=True)
    if isinstance(node, ast.Call):
        if _is_static_mapping_expression(node):
            return _static_mapping_first_key_outcomes(node)
        if _is_unbound_dict_keys_call(node):
            return _static_unbound_mapping_outcomes(node, include_all=False)
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "keys"
            and not node.args
            and not node.keywords
        ):
            return _static_mapping_first_key_outcomes(node.func.value)
        if (
            isinstance(node.func, ast.Name)
            and node.func.id in {"iter", "list", "tuple"}
            and len(node.args) == 1
            and not node.keywords
        ):
            return _merge_static_alternatives(
                [
                    _static_iterable_first_outcomes(argument)
                    if argument is not None
                    else _static_outcomes((), may_be_empty=True)
                    for argument in _static_first_call_argument_outcomes(node.args).ordered
                ]
            )
    if not isinstance(node, ast.List | ast.Tuple):
        return _static_outcomes((), may_be_empty=True)
    return _static_ordered_sequence_first_outcomes(node.elts)


def _static_ordered_sequence_first_outcomes(
    elements: list[ast.expr],
) -> _StaticIterableOutcomes:
    outcomes: list[ast.AST | None] = [None]
    for element in elements:
        if not any(outcome is None for outcome in outcomes):
            break
        if isinstance(element, ast.Starred):
            element_outcomes = _static_iterable_first_outcomes(element.value).ordered
        else:
            element_outcomes = (element,)
        next_outcomes: list[ast.AST | None] = []
        for outcome in outcomes:
            if outcome is None:
                next_outcomes.extend(element_outcomes)
            else:
                next_outcomes.append(outcome)
        outcomes = _deduplicate_ordered_outcomes(next_outcomes)
    return _StaticIterableOutcomes(tuple(outcomes))


def _static_set_outcomes(node: ast.Set) -> _StaticIterableOutcomes:
    result: list[ast.AST] = []
    may_be_empty = True
    for element in node.elts:
        if isinstance(element, ast.Starred):
            outcomes = _static_iterable_element_outcomes(element.value)
        else:
            outcomes = _static_outcomes((element,), may_be_empty=False)
        result.extend(outcomes.nodes)
        may_be_empty = may_be_empty and outcomes.may_be_empty
    return _static_outcomes(result, may_be_empty=may_be_empty)


def _static_iterable_element_outcomes(node: ast.AST) -> _StaticIterableOutcomes:
    """Return statically visible iterable elements without imposing an order."""
    if isinstance(node, ast.NamedExpr):
        return _static_iterable_element_outcomes(node.value)
    if isinstance(node, ast.IfExp):
        return _merge_static_alternatives(
            [
                _static_iterable_element_outcomes(node.body),
                _static_iterable_element_outcomes(node.orelse),
            ]
        )
    if isinstance(node, ast.BoolOp):
        return _merge_static_alternatives(
            [_static_iterable_element_outcomes(value) for value in node.values]
        )
    if isinstance(node, ast.Dict | ast.DictComp):
        return _static_mapping_key_outcomes(node)
    if isinstance(node, ast.ListComp | ast.SetComp | ast.GeneratorExp):
        return _static_outcomes((node.elt,), may_be_empty=True)
    if isinstance(node, ast.List | ast.Tuple | ast.Set):
        result: list[ast.AST] = []
        may_be_empty = True
        for element in node.elts:
            if isinstance(element, ast.Starred):
                outcomes = _static_iterable_element_outcomes(element.value)
            else:
                outcomes = _static_outcomes((element,), may_be_empty=False)
            result.extend(outcomes.nodes)
            may_be_empty = may_be_empty and outcomes.may_be_empty
        return _static_outcomes(result, may_be_empty=may_be_empty)
    if isinstance(node, ast.Call):
        if _is_static_mapping_expression(node):
            return _static_mapping_key_outcomes(node)
        if _is_unbound_dict_keys_call(node):
            return _static_unbound_mapping_outcomes(node, include_all=True)
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr == "keys"
            and not node.args
            and not node.keywords
        ):
            return _static_mapping_key_outcomes(node.func.value)
        if isinstance(node.func, ast.Name) and node.func.id in _STATIC_ITERABLE_WRAPPER_CALLS:
            argument_outcomes = _static_first_call_argument_outcomes(node.args)
            element_outcomes = [
                _static_iterable_element_outcomes(argument) for argument in argument_outcomes.nodes
            ]
            return _static_outcomes(
                [item for outcome in element_outcomes for item in outcome.nodes],
                may_be_empty=argument_outcomes.may_be_empty
                or any(outcome.may_be_empty for outcome in element_outcomes),
            )
    return _static_outcomes((), may_be_empty=True)


def _static_mapping_first_key_outcomes(node: ast.AST) -> _StaticIterableOutcomes:
    if isinstance(node, ast.NamedExpr):
        return _static_mapping_first_key_outcomes(node.value)
    if isinstance(node, ast.IfExp):
        return _merge_static_alternatives(
            [
                _static_mapping_first_key_outcomes(node.body),
                _static_mapping_first_key_outcomes(node.orelse),
            ]
        )
    if isinstance(node, ast.BoolOp):
        return _merge_static_alternatives(
            [_static_mapping_first_key_outcomes(value) for value in node.values]
        )
    if isinstance(node, ast.Dict):
        outcomes: list[ast.AST | None] = [None]
        for key, value in zip(node.keys, node.values, strict=True):
            if not any(outcome is None for outcome in outcomes):
                break
            if key is None:
                key_outcomes = _static_mapping_first_key_outcomes(value).ordered
            else:
                key_outcomes = (key,)
            next_outcomes: list[ast.AST | None] = []
            for outcome in outcomes:
                if outcome is None:
                    next_outcomes.extend(key_outcomes)
                else:
                    next_outcomes.append(outcome)
            outcomes = _deduplicate_ordered_outcomes(next_outcomes)
        return _StaticIterableOutcomes(tuple(outcomes))
    if isinstance(node, ast.DictComp):
        return _static_outcomes((node.key,), may_be_empty=True)
    if not isinstance(node, ast.Call):
        return _static_outcomes((), may_be_empty=True)
    if isinstance(node.func, ast.Attribute) and _is_mapping_copy_call(node):
        return _static_mapping_first_key_outcomes(node.func.value)
    if _is_unbound_dict_copy_call(node):
        return _static_unbound_mapping_outcomes(node, include_all=False)
    if _is_dict_fromkeys_call(node):
        return _static_fromkeys_outcomes(node, include_all=False)
    if _is_dict_constructor_call(node):
        return _static_dict_constructor_outcomes(node, include_all=False)
    return _static_outcomes((), may_be_empty=True)


def _static_mapping_key_outcomes(node: ast.AST) -> _StaticIterableOutcomes:
    if isinstance(node, ast.NamedExpr):
        return _static_mapping_key_outcomes(node.value)
    if isinstance(node, ast.IfExp):
        return _merge_static_alternatives(
            [
                _static_mapping_key_outcomes(node.body),
                _static_mapping_key_outcomes(node.orelse),
            ]
        )
    if isinstance(node, ast.BoolOp):
        return _merge_static_alternatives(
            [_static_mapping_key_outcomes(value) for value in node.values]
        )
    if isinstance(node, ast.Dict):
        result: list[ast.AST] = []
        may_be_empty = True
        for key, value in zip(node.keys, node.values, strict=True):
            if key is None:
                outcomes = _static_mapping_key_outcomes(value)
            else:
                outcomes = _static_outcomes((key,), may_be_empty=False)
            result.extend(outcomes.nodes)
            may_be_empty = may_be_empty and outcomes.may_be_empty
        return _static_outcomes(result, may_be_empty=may_be_empty)
    if isinstance(node, ast.DictComp):
        return _static_outcomes((node.key,), may_be_empty=True)
    if not isinstance(node, ast.Call):
        return _static_outcomes((), may_be_empty=True)
    if isinstance(node.func, ast.Attribute) and _is_mapping_copy_call(node):
        return _static_mapping_key_outcomes(node.func.value)
    if _is_unbound_dict_copy_call(node):
        return _static_unbound_mapping_outcomes(node, include_all=True)
    if _is_dict_fromkeys_call(node):
        return _static_fromkeys_outcomes(node, include_all=True)
    if _is_dict_constructor_call(node):
        return _static_dict_constructor_outcomes(node, include_all=True)
    return _static_outcomes((), may_be_empty=True)


def _static_fromkeys_outcomes(node: ast.Call, *, include_all: bool) -> _StaticIterableOutcomes:
    argument_outcomes = _static_first_call_argument_outcomes(node.args)
    key_outcomes = [
        (
            _static_iterable_element_outcomes(argument)
            if include_all
            else _static_iterable_first_outcomes(argument)
        )
        for argument in argument_outcomes.nodes
    ]
    return _static_outcomes(
        [key for outcome in key_outcomes for key in outcome.nodes],
        may_be_empty=argument_outcomes.may_be_empty
        or any(outcome.may_be_empty for outcome in key_outcomes),
    )


def _static_unbound_mapping_outcomes(
    node: ast.Call, *, include_all: bool
) -> _StaticIterableOutcomes:
    argument_outcomes = _static_first_call_argument_outcomes(node.args)
    mapping_outcomes = [
        (
            _static_mapping_key_outcomes(argument)
            if include_all
            else _static_mapping_first_key_outcomes(argument)
        )
        for argument in argument_outcomes.nodes
    ]
    return _static_outcomes(
        [key for outcome in mapping_outcomes for key in outcome.nodes],
        may_be_empty=argument_outcomes.may_be_empty
        or any(outcome.may_be_empty for outcome in mapping_outcomes),
    )


def _static_dict_constructor_outcomes(
    node: ast.Call, *, include_all: bool
) -> _StaticIterableOutcomes:
    argument_outcomes = _static_first_call_argument_outcomes(node.args)
    input_outcomes = [
        _static_mapping_input_key_outcomes(argument, include_all=include_all)
        for argument in argument_outcomes.nodes
    ]
    positional_may_be_empty = argument_outcomes.may_be_empty or any(
        outcome.may_be_empty for outcome in input_outcomes
    )
    keyword_outcomes = _static_mapping_keyword_outcomes(node.keywords, include_all=include_all)
    nodes = [key for outcome in input_outcomes for key in outcome.nodes]
    if include_all or positional_may_be_empty:
        nodes.extend(keyword_outcomes.nodes)
    return _static_outcomes(
        nodes,
        may_be_empty=positional_may_be_empty and keyword_outcomes.may_be_empty,
    )


def _static_mapping_input_key_outcomes(
    node: ast.AST, *, include_all: bool
) -> _StaticIterableOutcomes:
    if isinstance(node, ast.NamedExpr):
        return _static_mapping_input_key_outcomes(node.value, include_all=include_all)
    if isinstance(node, ast.IfExp):
        return _merge_static_alternatives(
            [
                _static_mapping_input_key_outcomes(node.body, include_all=include_all),
                _static_mapping_input_key_outcomes(node.orelse, include_all=include_all),
            ]
        )
    if isinstance(node, ast.BoolOp):
        return _merge_static_alternatives(
            [
                _static_mapping_input_key_outcomes(value, include_all=include_all)
                for value in node.values
            ]
        )
    if _is_static_mapping_expression(node):
        if include_all:
            return _static_mapping_key_outcomes(node)
        return _static_mapping_first_key_outcomes(node)
    entry_outcomes = (
        _static_iterable_element_outcomes(node)
        if include_all
        else _static_iterable_first_outcomes(node)
    )
    return _static_outcomes(
        [key for entry in entry_outcomes.nodes for key in _static_pair_key_nodes(entry)],
        may_be_empty=entry_outcomes.may_be_empty,
    )


def _static_pair_key_nodes(node: ast.AST) -> list[ast.AST]:
    if isinstance(node, ast.NamedExpr):
        return _static_pair_key_nodes(node.value)
    if isinstance(node, ast.IfExp):
        return _deduplicate_static_nodes(
            [*_static_pair_key_nodes(node.body), *_static_pair_key_nodes(node.orelse)]
        )
    if isinstance(node, ast.BoolOp):
        return _deduplicate_static_nodes(
            [key for value in node.values for key in _static_pair_key_nodes(value)]
        )
    if not isinstance(node, ast.List | ast.Tuple) or len(node.elts) != _MAPPING_PAIR_LENGTH:
        return []
    return [node.elts[0]]


def _static_mapping_keyword_outcomes(
    keywords: list[ast.keyword], *, include_all: bool
) -> _StaticIterableOutcomes:
    result: list[ast.AST] = []
    may_be_empty = True
    for keyword in keywords:
        if not include_all and not may_be_empty:
            break
        if keyword.arg is None:
            outcomes = (
                _static_mapping_key_outcomes(keyword.value)
                if include_all
                else _static_mapping_first_key_outcomes(keyword.value)
            )
        else:
            outcomes = _static_outcomes((keyword,), may_be_empty=False)
        result.extend(outcomes.nodes)
        if include_all:
            may_be_empty = may_be_empty and outcomes.may_be_empty
        else:
            may_be_empty = outcomes.may_be_empty
    return _static_outcomes(result, may_be_empty=may_be_empty)


def _is_dict_constructor_call(node: ast.Call) -> bool:
    return isinstance(node.func, ast.Name) and node.func.id == "dict"


def _is_dict_fromkeys_call(node: ast.Call) -> bool:
    return (
        isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "dict"
        and node.func.attr == "fromkeys"
    )


def _is_mapping_copy_call(node: ast.Call) -> bool:
    return (
        isinstance(node.func, ast.Attribute)
        and node.func.attr == "copy"
        and not node.args
        and not node.keywords
    )


def _is_unbound_dict_keys_call(node: ast.Call) -> bool:
    return _is_unbound_dict_method_call(node, "keys")


def _is_unbound_dict_copy_call(node: ast.Call) -> bool:
    return _is_unbound_dict_method_call(node, "copy")


def _is_unbound_dict_method_call(node: ast.Call, method_name: str) -> bool:
    return (
        isinstance(node.func, ast.Attribute)
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "dict"
        and node.func.attr == method_name
        and len(node.args) == 1
        and not node.keywords
    )


def _is_static_mapping_expression(node: ast.AST) -> bool:
    if isinstance(node, ast.NamedExpr):
        return _is_static_mapping_expression(node.value)
    if isinstance(node, ast.IfExp):
        return _is_static_mapping_expression(node.body) and _is_static_mapping_expression(
            node.orelse
        )
    if isinstance(node, ast.BoolOp):
        return all(_is_static_mapping_expression(value) for value in node.values)
    return isinstance(node, ast.Dict | ast.DictComp) or (
        isinstance(node, ast.Call)
        and (
            _is_dict_constructor_call(node)
            or _is_dict_fromkeys_call(node)
            or _is_mapping_copy_call(node)
            or _is_unbound_dict_copy_call(node)
        )
    )


def _type_params(node: ast.AST) -> list[ast.AST]:
    for field_name, value in ast.iter_fields(node):
        if field_name == "type_params" and isinstance(value, list):
            return [item for item in value if isinstance(item, ast.AST)]
    return []


def _type_param_names(node: ast.AST) -> set[str]:
    names: set[str] = set()
    for type_param in _type_params(node):
        for field_name, value in ast.iter_fields(type_param):
            if field_name == "name" and isinstance(value, str):
                names.add(value)
    return names


def _type_alias_target_names(node: ast.AST) -> set[str]:
    for field_name, value in ast.iter_fields(node):
        if field_name == "name" and isinstance(value, ast.AST):
            return _target_names(value)
    return set()


def _type_alias_value(node: ast.AST) -> ast.AST | None:
    for field_name, value in ast.iter_fields(node):
        if field_name == "value" and isinstance(value, ast.AST):
            return value
    return None


class _ScopeBoundNameVisitor(ast.NodeVisitor):
    def __init__(self) -> None:
        self.bound_names: set[str] = set()
        self.global_names: set[str] = set()
        self.nonlocal_names: set[str] = set()

    @property
    def local_names(self) -> set[str]:
        return self.bound_names - self.global_names - self.nonlocal_names

    def visit_Global(self, node: ast.Global) -> None:
        self.global_names.update(node.names)

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.nonlocal_names.update(node.names)

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.bound_names.add(node.name)
        self._visit_function_definition_expressions(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.bound_names.add(node.name)
        self._visit_function_definition_expressions(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        self.bound_names.add(node.name)
        for decorator in node.decorator_list:
            self.visit(decorator)
        for type_param in _type_params(node):
            self.visit(type_param)
        for base in node.bases:
            self.visit(base)
        for keyword in node.keywords:
            self.visit(keyword)

    def visit_TypeAlias(self, node: ast.AST) -> None:
        self.bound_names.update(_type_alias_target_names(node))

    def visit_Lambda(self, node: ast.Lambda) -> None:
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)

    def visit_Assign(self, node: ast.Assign) -> None:
        self.visit(node.value)
        for target in node.targets:
            self.bound_names.update(_target_names(target))
            self.visit(target)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self.visit(node.value)
        self.visit(node.annotation)
        self.bound_names.update(_target_names(node.target))
        self.visit(node.target)

    def visit_AugAssign(self, node: ast.AugAssign) -> None:
        self.bound_names.update(_target_names(node.target))
        self.visit(node.target)
        self.visit(node.value)

    def _visit_for_statement(self, node: ast.For | ast.AsyncFor) -> None:
        self.visit(node.iter)
        self.bound_names.update(_target_names(node.target))
        self.visit(node.target)
        for statement in [*node.body, *node.orelse]:
            self.visit(statement)

    def visit_For(self, node: ast.For) -> None:
        self._visit_for_statement(node)

    def visit_AsyncFor(self, node: ast.AsyncFor) -> None:
        self._visit_for_statement(node)

    def _visit_with_statement(self, node: ast.With | ast.AsyncWith) -> None:
        for item in node.items:
            self.visit(item.context_expr)
            self.bound_names.update(_target_names(item.optional_vars))
            if item.optional_vars is not None:
                self.visit(item.optional_vars)
        for statement in node.body:
            self.visit(statement)

    def visit_With(self, node: ast.With) -> None:
        self._visit_with_statement(node)

    def visit_AsyncWith(self, node: ast.AsyncWith) -> None:
        self._visit_with_statement(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler) -> None:
        if node.type is not None:
            self.visit(node.type)
        if node.name is not None:
            self.bound_names.add(node.name)
        for statement in node.body:
            self.visit(statement)

    def visit_Delete(self, node: ast.Delete) -> None:
        for target in node.targets:
            self.bound_names.update(_target_names(target))
            self.visit(target)

    def visit_NamedExpr(self, node: ast.NamedExpr) -> None:
        self.bound_names.update(_target_names(node.target))
        self.visit(node.value)

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            self.bound_names.add(alias.asname or alias.name.split(".", maxsplit=1)[0])

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        for alias in node.names:
            if alias.name != "*":
                self.bound_names.add(alias.asname or alias.name)

    def visit_Match(self, node: ast.Match) -> None:
        self.visit(node.subject)
        for case in node.cases:
            self.bound_names.update(_pattern_names(case.pattern))
            if case.guard is not None:
                self.visit(case.guard)
            for statement in case.body:
                self.visit(statement)

    def visit_ListComp(self, node: ast.ListComp) -> None:
        self._visit_comprehension_expressions(node.generators, [node.elt])

    def visit_SetComp(self, node: ast.SetComp) -> None:
        self._visit_comprehension_expressions(node.generators, [node.elt])

    def visit_GeneratorExp(self, node: ast.GeneratorExp) -> None:
        self._visit_comprehension_expressions(node.generators, [node.elt])

    def visit_DictComp(self, node: ast.DictComp) -> None:
        self._visit_comprehension_expressions(node.generators, [node.key, node.value])

    def _visit_function_definition_expressions(
        self, node: ast.FunctionDef | ast.AsyncFunctionDef
    ) -> None:
        for decorator in node.decorator_list:
            self.visit(decorator)
        for type_param in _type_params(node):
            self.visit(type_param)
        for default in [*node.args.defaults, *node.args.kw_defaults]:
            if default is not None:
                self.visit(default)
        for annotation in _argument_annotations(node.args):
            self.visit(annotation)
        if node.returns is not None:
            self.visit(node.returns)

    def _visit_comprehension_expressions(
        self, generators: list[ast.comprehension], body_expressions: list[ast.AST]
    ) -> None:
        for generator in generators:
            self.visit(generator.iter)
            for condition in generator.ifs:
                self.visit(condition)
        for expression in body_expressions:
            self.visit(expression)


def _scope_bound_name_visitor(body: list[ast.stmt]) -> _ScopeBoundNameVisitor:
    visitor = _ScopeBoundNameVisitor()
    for statement in body:
        visitor.visit(statement)
    return visitor


def _scope_bound_names(body: list[ast.stmt]) -> set[str]:
    return _scope_bound_name_visitor(body).local_names


def _expression_bound_names(expression: ast.AST) -> set[str]:
    visitor = _ScopeBoundNameVisitor()
    visitor.visit(expression)
    return visitor.local_names


def _pattern_names(pattern: ast.pattern) -> set[str]:
    if isinstance(pattern, ast.MatchAs):
        names = set() if pattern.name is None else {pattern.name}
        if pattern.pattern is not None:
            names.update(_pattern_names(pattern.pattern))
        return names
    if isinstance(pattern, ast.MatchStar):
        return set() if pattern.name is None else {pattern.name}
    if isinstance(pattern, ast.MatchMapping):
        mapping_names: set[str] = set() if pattern.rest is None else {pattern.rest}
        for child_pattern in pattern.patterns:
            mapping_names.update(_pattern_names(child_pattern))
        return mapping_names
    if isinstance(pattern, ast.MatchSequence):
        sequence_names: set[str] = set()
        for child_pattern in pattern.patterns:
            sequence_names.update(_pattern_names(child_pattern))
        return sequence_names
    if isinstance(pattern, ast.MatchClass):
        class_names: set[str] = set()
        for child_pattern in [*pattern.patterns, *pattern.kwd_patterns]:
            class_names.update(_pattern_names(child_pattern))
        return class_names
    if isinstance(pattern, ast.MatchOr):
        or_names: set[str] = set()
        for child_pattern in pattern.patterns:
            or_names.update(_pattern_names(child_pattern))
        return or_names
    return set()


def _pattern_is_exhaustive(pattern: ast.pattern) -> bool:
    if isinstance(pattern, ast.MatchAs):
        return pattern.pattern is None or _pattern_is_exhaustive(pattern.pattern)
    if isinstance(pattern, ast.MatchOr):
        return any(_pattern_is_exhaustive(child_pattern) for child_pattern in pattern.patterns)
    return False


def _comparison_operator_may_raise(operator: ast.cmpop) -> bool:
    """Return whether one comparison step can invoke user code."""
    return not isinstance(operator, (ast.Is, ast.IsNot))


def _is_modeled_implicit_exception_operation(node: ast.AST) -> bool:
    """Return whether evaluating ``node`` performs a modeled fallible operation."""
    if isinstance(node, ast.Compare):
        return any(_comparison_operator_may_raise(operator) for operator in node.ops)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        return _truth_test_may_raise(node.operand)
    return isinstance(
        node,
        (
            ast.Attribute,
            ast.Await,
            ast.BinOp,
            ast.Call,
            ast.FormattedValue,
            ast.Subscript,
            ast.UnaryOp,
            ast.YieldFrom,
        ),
    )


def _truth_test_may_raise(node: ast.AST) -> bool:
    """Return whether truth-testing an evaluated expression may invoke user code."""
    if isinstance(
        node,
        (
            ast.Constant,
            ast.Dict,
            ast.GeneratorExp,
            ast.JoinedStr,
            ast.Lambda,
            ast.List,
            ast.Set,
            ast.Tuple,
        ),
    ):
        return False
    if isinstance(node, ast.NamedExpr):
        return _truth_test_may_raise(node.value)
    if isinstance(node, ast.IfExp):
        return _truth_test_may_raise(node.body) or _truth_test_may_raise(node.orelse)
    if isinstance(node, ast.BoolOp):
        return any(_truth_test_may_raise(value) for value in node.values)
    if isinstance(node, ast.Compare):
        return _comparison_operator_may_raise(node.ops[-1])
    return not (isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not))


def _static_truth_value(node: ast.AST) -> bool | None:
    """Return an expression's statically known truth value, if any."""
    if isinstance(node, ast.Constant):
        return bool(node.value)
    if isinstance(node, (ast.List, ast.Set, ast.Tuple)):
        if not node.elts:
            return False
        return True if any(not isinstance(element, ast.Starred) for element in node.elts) else None
    if isinstance(node, ast.Dict):
        if not node.keys:
            return False
        return True if any(key is not None for key in node.keys) else None
    if isinstance(node, (ast.GeneratorExp, ast.Lambda)):
        return True
    if isinstance(node, ast.NamedExpr):
        return _static_truth_value(node.value)
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not):
        operand_truth = _static_truth_value(node.operand)
        return None if operand_truth is None else not operand_truth
    return None


def _iteration_may_raise(node: ast.AST, *, advances: bool) -> bool:
    """Return whether obtaining and optionally advancing this iterable may invoke user code."""
    if isinstance(node, ast.GeneratorExp):
        return advances
    if isinstance(
        node,
        (
            ast.Dict,
            ast.DictComp,
            ast.JoinedStr,
            ast.List,
            ast.ListComp,
            ast.Set,
            ast.SetComp,
            ast.Tuple,
        ),
    ):
        return False
    return not (isinstance(node, ast.Constant) and isinstance(node.value, (bytes, str)))


def _literal_iteration_limit(node: ast.AST) -> int | None:
    """Bound iteration of direct literals without evaluating or expanding their contents."""
    if isinstance(node, (ast.List, ast.Set, ast.Tuple)) and not any(
        isinstance(element, ast.Starred) for element in node.elts
    ):
        return len(node.elts)
    if isinstance(node, ast.Dict) and all(key is not None for key in node.keys):
        return len(node.keys)
    if isinstance(node, ast.Constant) and isinstance(node.value, (bytes, str)):
        return len(node.value)
    return None


def _iterable_is_statically_empty(node: ast.AST) -> bool:
    if isinstance(node, (ast.List, ast.Set, ast.Tuple)):
        return not node.elts
    if isinstance(node, ast.Dict):
        return not node.keys
    return (
        isinstance(node, ast.Constant) and isinstance(node.value, (bytes, str)) and not node.value
    )
