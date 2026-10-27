"""Exercise the real parallel-job predicates and aggregate gate at CI boundaries."""

import ast
import itertools
import json
import os
import re
import subprocess
import sys

workflow = json.load(sys.stdin)
jobs = workflow["jobs"]
lanes = ("check", "check-docs", "check-guest-production", "check-ably-smoke")
gate = jobs["ci-gate-crates"]
gate_step = next(step for step in gate["steps"] if step.get("name") == "Validate CI results")
assert gate["if"] == "always()" and all(name in gate["needs"] for name in lanes)

for name in lanes:
    job = jobs[name]
    assert job["needs"] == ["detect"], f"{name}: must start at the common detect boundary"
    cache = next(step for step in job["steps"] if step.get("uses", "").startswith("Swatinem/rust-cache@"))
    assert cache["with"]["shared-key"] == "check"
    assert cache["with"]["save-if"] == ("${{ github.ref == 'refs/heads/main' }}" if name == "check" else False)
    # Once a lane is selected, its Cargo checks must run.
    assert not any("if" in step for step in job["steps"] if "cargo " in step.get("run", "")), name

secret_steps = [(name, step) for name in lanes for step in jobs[name]["steps"]
                if "secrets.ABLY_API_KEY" in str(step)]
assert len(secret_steps) == 1 and secret_steps[0][0] == "check-ably-smoke"
assert secret_steps[0][1]["env"]["ABLY_API_KEY"] == "${{ secrets.ABLY_API_KEY }}"


def condition_value(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (str, bool)):
        return node.value
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            return all(condition_value(value) for value in node.values)
        if isinstance(node.op, ast.Or):
            return any(condition_value(value) for value in node.values)
    if isinstance(node, ast.Compare) and len(node.ops) == 1:
        left = condition_value(node.left)
        right = condition_value(node.comparators[0])
        if isinstance(node.ops[0], ast.Eq):
            return left == right
        if isinstance(node.ops[0], ast.NotEq):
            return left != right
    raise ValueError(f"Unsupported CI condition syntax: {type(node).__name__}")


def expression(text, values):
    text = str(text).strip().removeprefix("${{").removesuffix("}}").strip()
    text = re.sub(r"\b(?:github|needs)\.[\w.-]+", lambda match: repr(values[match[0]]), text)
    text = text.replace("always()", "True").replace("&&", " and ").replace("||", " or ")
    return condition_value(ast.parse("(" + text + ")", mode="eval").body)


def render(text, values):
    def substitute(match):
        value = expression(match[1], values)
        return str(value).lower() if isinstance(value, bool) else value
    return re.sub(r"\$\{\{\s*(.*?)\s*\}\}", substitute, str(text))


def selected(name, values):
    job = jobs[name]
    return all(values[f"needs.{dependency}.result"] == "success" for dependency in job["needs"]) and bool(
        expression(job["if"], values))


def context(event, changed, ci, guest, ably, coverage=None):
    values = {"github.event_name": event,
              "needs.detect-release.outputs.skip": "false",
              "needs.detect.outputs.any-changed": str(changed).lower(),
              "needs.detect.outputs.ci-changed": str(ci).lower(),
              "needs.detect.outputs.coverage-needed": str(changed if coverage is None else coverage).lower(),
              "needs.detect.outputs.guest-control-tests-changed": str(guest).lower(),
              "needs.detect.outputs.ably-subscriber-changed": str(ably).lower(),
              "needs.detect.outputs.native-kerberos-needed": "false",
              "needs.detect.outputs.native-gssapi-peer-needed": "false",
              "needs.detect.outputs.guest-home-cleanup-needed": "false",
              "needs.detect.outputs.runner-firewall-contract-inputs-changed": "false",
              "needs.detect.outputs.metal-job-ref": "",
              "needs.detect.outputs.crates-runner-consumer-needed": "false",
              "needs.detect.outputs.sandbox-firecracker-changed": "false"}
    values.update({f"needs.{name}.result": "success" for name in gate["needs"]})
    return values


cases = 0


def assert_gate(values, expected, label):
    global cases
    assert expression(gate["if"], values), "gate must run after failed/skipped dependencies"
    env = os.environ | {name: render(value, values) for name, value in gate_step["env"].items()}
    result = subprocess.run(["bash", "-euo", "pipefail", "-c", render(gate_step["run"], values)],
                            check=False, env=env, text=True, capture_output=True)
    assert (result.returncode == 0) == expected, f"{label}: {result.stdout}{result.stderr}"
    cases += 1


for event in ("pull_request", "push", "merge_group"):
    for changed, ci, guest, ably, coverage in itertools.product((False, True), repeat=5):
        values = context(event, changed, ci, guest, ably, coverage)
        wanted = {"check": changed, "check-docs": changed,
                  "check-guest-production": changed and (guest or ci),
                  "check-ably-smoke": changed and (ably or ci)}
        for name in lanes:
            assert selected(name, values) == wanted[name], (event, name, changed, ci, guest, ably)
            values[f"needs.{name}.result"] = "success" if wanted[name] else "skipped"
        assert selected("coverage", values) == coverage
        values["needs.coverage.result"] = "success" if coverage else "skipped"
        assert_gate(values, True, f"{event}: valid selection")

    # Generic/native CI work can remain selected independently of coverage.
    for coverage in (False, True):
        values = context(event, True, True, False, False, coverage)
        for result in ("failure", "cancelled", "", "skipped"):
            assert_gate(values | {"needs.coverage.result": result},
                        result == "skipped" and not coverage,
                        f"{event}: coverage={coverage}, result={result!r}")

    # Exercise each independent selection path without crossing failures with
    # every flag combination: outer skip, each inner selector, and CI-only work.
    for changed, ci, guest, ably in (
        (False, False, False, False),
        (True, False, False, False),
        (True, False, True, False),
        (True, False, False, True),
        (True, False, True, True),
        (True, True, False, False),
    ):
        values = context(event, changed, ci, guest, ably)
        wanted = {name: selected(name, values) for name in lanes}
        values.update({
            f"needs.{name}.result": "success" if wanted[name] else "skipped"
            for name in lanes
        })
        for name in lanes:
            for result in ("failure", "cancelled", "") + (("skipped",) if wanted[name] else ()):
                assert_gate(values | {f"needs.{name}.result": result}, False, f"{event}: {name}={result!r}")
    values = context(event, True, True, True, True)
    for output in ("any-changed", "ci-changed", "guest-control-tests-changed", "ably-subscriber-changed", "coverage-needed"):
        for invalid in ("", "TRUE", "unknown"):
            assert_gate(values | {f"needs.detect.outputs.{output}": invalid}, False,
                        f"{event}: invalid {output}={invalid!r}")
    for result in ("failure", "cancelled", "skipped", ""):
        broken = values | {"needs.detect.result": result}
        assert all(not selected(name, broken) for name in lanes), "failed detect must suppress all lanes"
        broken.update({f"needs.{name}.result": "skipped" for name in lanes})
        assert_gate(broken, False, f"{event}: detect={result!r}")
    released = values | {"needs.detect-release.outputs.skip": "true"}
    released.update({f"needs.{name}.result": "skipped" for name in gate["needs"] if name != "detect-release"})
    released.update({key: "" for key in released if key.startswith("needs.detect.outputs.")})
    assert all(not selected(name, released) for name in lanes)
    assert_gate(released, True, f"{event}: classified release")
    for result in ("failure", "cancelled", "skipped", ""):
        assert_gate(released | {"needs.detect-release.result": result}, False,
                    f"{event}: failed release classifier={result!r}")
    for invalid in ("", "TRUE", "unknown"):
        assert_gate(values | {"needs.detect-release.outputs.skip": invalid}, False,
                    f"{event}: invalid release selection={invalid!r}")

print(f"crates-parallel-checks-workflow-test: ok ({cases} gate cases)")
