#!/usr/bin/env python3
"""Read execution owners for existing job-body regressions, without writing YAML.

The actual reusable caller graph and gates are tested independently by the CI
readiness suite. This reader binds data references to their logical job context
so pre-existing step/fixture assertions remain usable after moving an owner.
"""
import copy
import json
from pathlib import Path
import re
import subprocess
import sys
from functools import lru_cache


@lru_cache(maxsize=None)
def raw_workflow(root, name):
    return json.loads(subprocess.check_output(
        ["yq", "-o=json", ".", str(root / f".github/workflows/{name}.yml")], text=True))


def logical(identifier, family):
    prefix = {"crates": "crates-", "runner-image": "image-"}.get(family, "")
    if prefix and identifier.startswith(prefix):
        identifier = identifier[len(prefix):]
    return re.sub(r"-(?:arm64|x86_64)$", "", identifier)


def bind(value, family, arguments):
    if isinstance(value, dict):
        return {k: bind(v, family, arguments) for k, v in value.items()}
    if isinstance(value, list):
        return [bind(v, family, arguments) for v in value]
    if not isinstance(value, str):
        return value
    value = re.sub(r"fromJSON\(inputs\.dependencies\)\.([\w-]+)",
                   lambda m: "needs." + logical(m[1], family), value)
    value = value.replace("fromJSON(inputs.ready).", "needs.runner-test-prepare.outputs.")
    for key, argument in arguments.items():
        if value == "${{ inputs." + key + " }}":
            return bind(argument, family, {})
        value = value.replace("inputs." + key, str(argument).strip().removeprefix("${{").removesuffix("}}").strip())
    if family != 'turbo':
        value = re.sub(r"needs\.([\w-]+)", lambda m: 'needs.' + logical(m[1], family), value)
    return value


def load(root, family):
    if family not in {"turbo", "crates", "runner-image"}:
        return raw_workflow(root, family)
    controller = raw_workflow(root, "ci")
    result = copy.deepcopy(raw_workflow(root, family))
    jobs = result["jobs"] = {}
    seen = set()
    for caller_id, caller in controller["jobs"].items():
        path = caller.get("uses", "")
        if not path.startswith(f"./.github/workflows/ci-{family}-"):
            continue
        if path in seen:
            continue
        seen.add(path)
        owner = raw_workflow(root, Path(path).stem)
        for identifier, body in owner["jobs"].items():
            job = bind(body, family, caller.get("with", {}))
            job["_caller"] = copy.deepcopy(caller)
            if not body.get("needs"):
                if 'if' in body or len(owner['jobs']) > 1:
                    job['needs'] = sorted(set(re.findall(r'needs\.([\w-]+)\.', json.dumps({k: v for k, v in job.items() if k != '_caller'}))))
                else:
                    job["needs"] = [logical(d, family) for d in caller.get("needs", [])
                                    if d not in {'detect-release', 'ci-admission'} and not d.startswith('image-build-')]
                    parent = bind(caller.get("if", "true"), family, {}).strip().removeprefix("${{").removesuffix("}}").strip()
                    surface = {"runner-image": "images"}.get(family, family)
                    parent = parent.replace("inputs.surface", repr(surface))
                    job["if"] = "${{ " + parent + " }}"
            jobs[identifier] = job
    for identifier in ["ci-admission", "detect-release", "detect-turbo-ts-checks", "ci-gate-turbo", "ci-gate-crates"]:
        if family != "turbo" and identifier in {"ci-admission", "detect-turbo-ts-checks", "validate-release", "ci-gate-turbo"}:
            continue
        if family == "turbo" and identifier == "ci-gate-crates":
            continue
        jobs[identifier] = copy.deepcopy(controller["jobs"][identifier])
    if family == 'runner-image':
        jobs['cancel-superseded'] = copy.deepcopy(controller['jobs']['image-cancel-superseded'])
    result["concurrency"] = controller["concurrency"]
    return result


if __name__ == "__main__":
    import tempfile
    read_stdin = sys.argv[1:] == ['--stdin']
    path = Path(sys.stdin.read() if read_stdin else sys.argv[-1]).resolve()
    data = json.dumps(load(path.parents[2], path.stem))
    if len(sys.argv) == 2:
        print(data)
    else:
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as fixture:
            fixture.write(data)
            fixture.flush()
            result = subprocess.run(['yq', *sys.argv[1:-1], fixture.name])
        sys.exit(result.returncode)
