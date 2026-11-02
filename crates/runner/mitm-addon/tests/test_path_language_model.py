"""Independent concrete oracle for the bounded path-language library contract."""

import itertools
import json
import re
import urllib.parse
from pathlib import Path

import pytest

from path_automaton import (
    Applicability,
    PathAnalysis,
    PathCompiler,
    SelectionCandidate,
    applicability,
    certifies_selection,
)
from path_language import AnalysisLimitError, InvalidPathError, WorkBudget, request_language

_OPERATORS = {"": "\ue000", "+": "\ue001", "*": "\ue002"}
_HEX = frozenset(b"0123456789abcdefABCDEF")
_UNRESERVED = frozenset("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._~-")
_ESCAPED = frozenset(' "<>[]^`{|}')


def _one_layer(value: bytes) -> set[bytes]:
    outputs = {b""}
    positions: dict[int, set[bytes]] = {0: outputs}
    for index, byte in enumerate(value):
        current = positions.get(index, set())
        positions.setdefault(index + 1, set()).update(x + bytes([byte]) for x in current)
        if (
            byte == 37
            and index + 2 < len(value)
            and all(x in _HEX for x in value[index + 1 : index + 3])
        ):
            decoded = bytes([int(value[index + 1 : index + 3], 16)])
            positions.setdefault(index + 3, set()).update(x + decoded for x in current)
    return positions.get(len(value), set())


def _canonical(value: str) -> str:
    output: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if char == "%" and re.fullmatch(r"[0-9a-fA-F]{2}", value[index + 1 : index + 3]):
            byte = int(value[index + 1 : index + 3], 16)
            if chr(byte) in _UNRESERVED:
                output.append(chr(byte))
                index += 3
                continue
            width = (
                2
                if 194 <= byte <= 223
                else 3
                if 224 <= byte <= 239
                else 4
                if 240 <= byte <= 244
                else 0
            )
            piece = value[index : index + width * 3]
            if width and re.fullmatch(r"(?:%[0-9a-fA-F]{2}){" + str(width) + "}", piece):
                try:
                    decoded = bytes.fromhex(piece.replace("%", "")).decode("utf-8")
                except UnicodeError:
                    decoded = ""
                if len(decoded) == 1:
                    output.append(decoded)
                    index += len(piece)
                    continue
            output.append(f"%{byte:02X}")
            index += 3
            continue
        output.append(urllib.parse.quote(char, safe="") if char in _ESCAPED else char)
        index += 1
    return "".join(output)


def _views(value: str) -> set[str]:
    values = {value.encode("utf-8")}
    for _ in range(5):
        updated = set().union(*(_one_layer(x) for x in values))
        if updated == values:
            break
        values = updated
        assert len(values) <= 4096, "reference domain must remain deliberately small"
    outputs: set[str] = set()
    for raw in values:
        try:
            decoded = raw.decode("utf-8")
        except UnicodeError:
            continue
        outputs.add(_canonical(decoded))
    return outputs


def _source_forms(pattern: str) -> set[str]:
    pieces = re.split(r"(\{[^{}]+\})", pattern)
    alternatives: list[set[str]] = []
    for piece in pieces:
        if piece.startswith("{"):
            name = piece[1:-1]
            alternatives.append({_OPERATORS[name[-1] if name[-1] in "+*" else ""]})
        else:
            alternatives.append(_views(piece))
    return {"".join(parts) for parts in itertools.product(*alternatives)}


def _matches(path: str, form: str) -> bool:
    pieces = form.split("/")[1:]
    if form == "/":
        return path == "/"
    expression = "^"
    for index, segment in enumerate(pieces):
        if segment == _OPERATORS["*"]:
            expression += r"(?:/[\s\S]*)?" if index else r"/[\s\S]*"
        elif segment == _OPERATORS["+"]:
            expression += r"/(?=[\s\S]*[^/])[\s\S]*"
        else:
            expression += "/" + "".join(
                "[^/]+" if char == _OPERATORS[""] else re.escape(char) for char in segment
            )
    return re.fullmatch(expression.removeprefix("^"), path) is not None


def _priority(form: str) -> tuple[int, ...]:
    segments = [] if form == "/" else form.split("/")[1:]
    score = [0, 0, 0, 0, 0, 0, len(segments)]
    for segment in segments:
        literal = "".join(x for x in segment if x not in _OPERATORS.values())
        score[5] += len(literal)
        if literal == segment:
            score[0] += 1
        elif literal:
            score[1] += 1
        elif segment == _OPERATORS["+"]:
            score[3] += 1
        elif segment == _OPERATORS["*"]:
            score[4] -= 1
        else:
            score[2] += 1
    return tuple(score)


@pytest.mark.parametrize(
    "pattern",
    [
        "/files/{id}",
        "/files/{key+}",
        "/files/{key*}",
        "/files/delegations%2Ffoo",
        "/files/{id}%61%62%63",
        "/files/prefix{id}",
        "/files/%7Badmin%7D",
        "/files/%E7%AE%A1",
    ],
)
@pytest.mark.parametrize(
    "path",
    [
        "/files",
        "/files/",
        "/files//",
        "/files/a%2Fb",
        "/files/%2564elegations%2Ffoo",
        "/files/%25%36%34elegations%2Ffoo",
        "/files/prefixx%61%62%63",
        "/files/{admin}",
        "/files/管",
        "/files/%E7%AE%A1",
    ],
)
def test_public_language_proof_matches_independent_concrete_model(pattern: str, path: str):
    forms = _source_forms(pattern)
    paths = _views(path)
    outcomes = [_matches(candidate, form) for form in forms for candidate in paths]
    priorities = [_priority(form) for form in forms if any(_matches(p, form) for p in paths)]
    result = applicability(request_language(path), PathCompiler().compile(pattern))
    assert result.possible == any(outcomes)
    assert result.certain == all(outcomes)
    assert result.minimum == (min(priorities) if priorities else None)
    assert result.maximum == (max(priorities) if priorities else None)


def test_source_form_construction_collapses_equal_uri_spellings_before_enumeration():
    compiler = PathCompiler()
    forms = compiler.compile("/files/" + "%61" * 40)
    assert len(forms) == 1
    assert applicability(request_language("/files/" + "a" * 40), forms).certain


def test_every_product_branch_including_sink_is_inspected():
    graph = request_language("/files/a%2Fb")
    proof = applicability(graph, PathCompiler().compile("/files/{id}"))
    assert proof.possible
    assert not proof.certain


def test_union_of_declaration_aliases_is_not_universal_applicability():
    path = "/files/a%2Fb/x"
    pattern = "/files/a%2Fb/{tail*}"
    forms = _source_forms(pattern)
    views = _views(path)
    assert all(any(_matches(candidate, form) for form in forms) for candidate in views)
    assert not all(_matches(candidate, form) for form in forms for candidate in views)
    proof = applicability(request_language(path), PathCompiler().compile(pattern))
    assert proof.possible
    assert not proof.certain


def test_stable_applicability_cannot_freeze_raw_specificity():
    compiler = PathCompiler()
    path = "/files/prefixx%61%62%63"
    candidates = {
        "grant": SelectionCandidate(
            "owner",
            applicability(request_language(path), compiler.compile("/files/{id}%61%62%63")),
            1,
        ),
        "deny": SelectionCandidate(
            "owner", applicability(request_language(path), compiler.compile("/files/prefix{id}")), 0
        ),
    }
    assert all(x.proof.certain for x in candidates.values())
    assert _priority("/files/" + _OPERATORS[""] + "%61%62%63") > _priority(
        "/files/prefix" + _OPERATORS[""]
    )
    assert not certifies_selection(
        candidates,
        original_owner_sources=frozenset(candidates),
        selected="grant",
        explicit_owner_intent=False,
        budget=WorkBudget(),
    )


@pytest.mark.parametrize(
    ("other_priority", "intent", "expected"),
    [(10, False, True), (20, False, False), (20, True, True), (21, True, False)],
)
def test_owner_certificate_covers_lower_equal_and_higher_competitors(
    other_priority: int, intent: bool, expected: bool
):
    candidates = {
        "winner": SelectionCandidate("chosen", Applicability(True, True, (20,), (20,)), 0),
        "other": SelectionCandidate(
            "other", Applicability(True, False, (1,), (other_priority,)), 0
        ),
    }
    assert (
        certifies_selection(
            candidates,
            original_owner_sources=frozenset({"winner"}),
            selected="winner",
            explicit_owner_intent=intent,
            budget=WorkBudget(),
        )
        == expected
    )


def test_declaration_form_exhaustion_is_explicit_without_truncation():
    with pytest.raises(AnalysisLimitError, match="declaration form limit"):
        PathCompiler().compile("/files/" + "a%2F" * 9)


def test_invalid_full_literal_chain_cannot_be_silently_filtered():
    with pytest.raises(InvalidPathError, match="literal UTF-8"):
        PathCompiler().compile("/files/%C3{id}%A9")
    forms = PathCompiler().compile("/files/%C3%A9{id}")
    assert applicability(request_language("/files/éa"), forms).certain


@pytest.mark.parametrize("kind", ["base", "rule"])
def test_existing_1100_segment_positive_fits_without_a_per_form_dfa(kind: str):
    path = "".join(f"/seg-{index}" for index in range(1100))
    compiler = PathCompiler()
    forms = (
        compiler.compile_api(path, parameterized=False, rule="/")
        if kind == "base"
        else compiler.compile(path)
    )
    proof = applicability(request_language(path), forms)
    assert proof.possible
    assert proof.certain


def test_new_api_tie_cannot_hide_a_binding_conflict_behind_source_order():
    candidates = {
        "winner": SelectionCandidate("owner", Applicability(True, True, (2,), (2,)), 1, (3,)),
        "other": SelectionCandidate("owner", Applicability(True, True, (2,), (2,)), 0, (2,)),
    }
    assert not certifies_selection(
        candidates,
        original_owner_sources=frozenset(candidates),
        selected="winner",
        explicit_owner_intent=False,
        budget=WorkBudget(),
    )


def test_work_exhaustion_is_explicit_not_a_missing_match():
    with pytest.raises(AnalysisLimitError, match="work limit"):
        request_language("/files/%2564elegations%2Ffoo", WorkBudget(10))


@pytest.mark.parametrize(
    "path",
    [
        "/%",
        "/%C0%AF",
        "/%E7%AE",
        "/%00",
        "/%5c",
        "/%2e%2e",
        "/a%2F..",
        "/%253f",
        "/%2523",
        "/﹖",
        "/%252525252561",
        "/\ud800",
    ],
)
def test_raw_or_full_chain_unsafe_input_is_explicitly_invalid(path: str):
    with pytest.raises(InvalidPathError):
        request_language(path)


def test_shared_corpus_is_derived_from_reference_and_matches_python():
    corpus = Path(__file__).resolve().parents[4] / (
        "turbo/packages/connectors/src/__tests__/path-language-model.json"
    )
    for case in json.loads(corpus.read_text()):
        forms = _source_forms(case["pattern"])
        paths = _views(case["path"])
        outcomes = [_matches(path, form) for form in forms for path in paths]
        priorities = [_priority(form) for form in forms if any(_matches(p, form) for p in paths)]
        expected = {
            "possible": any(outcomes),
            "certain": all(outcomes),
            "minimum": list(min(priorities)) if priorities else None,
            "maximum": list(max(priorities)) if priorities else None,
        }
        assert {k: case[k] for k in expected} == expected, case
        result = applicability(
            request_language(case["path"]), PathCompiler().compile(case["pattern"])
        )
        assert result.possible == expected["possible"], case
        assert result.certain == expected["certain"], case
        assert result.minimum == (min(priorities) if priorities else None), case
        assert result.maximum == (max(priorities) if priorities else None), case


def test_exhaustive_small_joint_literal_choices_against_independent_model():
    alphabet = ("a", "%61", "%2561", "%2525252561", "%2F", "%252F", "%25%36%31", "%E7%AE%A1")
    compiler = PathCompiler()
    patterns = [
        "/files/" + left + "{id}" + right for left, right in itertools.product(alphabet, repeat=2)
    ]
    for path in (
        "/files/" + left + "x" + right for left, right in itertools.product(alphabet, repeat=2)
    ):
        views = _views(path)
        analysis = PathAnalysis(request_language(path))
        for pattern in patterns:
            forms = _source_forms(pattern)
            outcomes = [_matches(candidate, form) for form in forms for candidate in views]
            priorities = [
                _priority(form) for form in forms if any(_matches(p, form) for p in views)
            ]
            result = analysis.applicability(compiler.compile(pattern))
            assert result.possible == any(outcomes), (pattern, path)
            assert result.certain == all(outcomes), (pattern, path)
            assert result.minimum == (min(priorities) if priorities else None), (pattern, path)
            assert result.maximum == (max(priorities) if priorities else None), (pattern, path)


def _base_relative(path: str, form: str) -> str | None:
    base = form[:-1] if form.endswith("/") else form
    if not base:
        return path
    if _OPERATORS["+"] in base or _OPERATORS["*"] in base:
        return "/" if _matches(path, base) else None
    expression = "".join("[^/]+" if x == _OPERATORS[""] else re.escape(x) for x in base)
    match = re.match(expression + r"(?=/|$)", path)
    return (path[match.end() :] or "/") if match else None


def _base_priority(form: str) -> int:
    base = form[:-1] if form.endswith("/") else form
    if base in ("", "/"):
        return len(base)
    result = 0
    for segment in base.split("/")[1:]:
        literal = "".join(x for x in segment if x not in _OPERATORS.values())
        if literal == segment:
            result += 1000 + len(literal)
        elif literal:
            result += 100 + len(literal)
        else:
            result += 1 if segment == _OPERATORS["+"] else 0 if segment == _OPERATORS["*"] else 10
    return result


@pytest.mark.parametrize(
    "base",
    [
        "",
        "/",
        "//",
        "/files",
        "/files/",
        "/files%2F",
        "/{tenant}",
        "/files/{key+}",
        "/files/{key*}",
    ],
)
@pytest.mark.parametrize("rule", [None, "/", "/{id}", "/{key*}"])
@pytest.mark.parametrize(
    "path", ["/", "//", "/files", "/files/", "/files/a", "/files%2Fa", "/files//a"]
)
def test_correlated_base_and_route_against_independent_model(
    base: str, rule: str | None, path: str
):
    bases = _source_forms(base)
    routes = {None} if rule is None else _source_forms(rule)
    paths = _views(path)
    outcomes = []
    priorities = []
    for base_form, route in itertools.product(bases, routes):
        priority = (_base_priority(base_form),) + (() if route is None else _priority(route))
        matches = []
        for candidate in paths:
            relative = _base_relative(candidate, base_form)
            matches.append(relative is not None and (route is None or _matches(relative, route)))
        outcomes.extend(matches)
        if any(matches):
            priorities.append(priority)
    result = applicability(
        request_language(path),
        PathCompiler().compile_api(base, parameterized="{" in base, rule=rule),
    )
    assert result.possible == any(outcomes)
    assert result.certain == all(outcomes)
    assert result.minimum == (min(priorities) if priorities else None)
    assert result.maximum == (max(priorities) if priorities else None)
