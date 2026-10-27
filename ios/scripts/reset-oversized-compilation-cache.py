#!/usr/bin/env python3
"""Reset inherited simulator compiler history above 2 GiB before a missing-key seed.

Requires RUNNER_TEMP. Owns only okou-ios-ci/DerivedData/CompilationCache.noindex;
missing and smaller caches are retained. Invalid paths and filesystem errors fail.
"""

import os
import shutil
from pathlib import Path

MAX_CACHE_BYTES = 2 * 1024**3

cache = (
    Path(os.environ["RUNNER_TEMP"]).resolve()
    / "okou-ios-ci/DerivedData/CompilationCache.noindex"
)
if cache.resolve() != cache:
    raise ValueError("Compiler cache must not traverse symlinks")
if cache.exists():
    if not cache.is_dir():
        raise ValueError("Compiler cache must be a directory")
    size = sum(
        path.stat().st_size
        for path in cache.rglob("*")
        if not path.is_symlink() and path.is_file()
    )
    if size > MAX_CACHE_BYTES:
        shutil.rmtree(cache)
        print(f"Reset inherited compiler cache: {size} bytes exceeds {MAX_CACHE_BYTES}")
    else:
        print(f"Retained inherited compiler cache: {size} bytes <= {MAX_CACHE_BYTES}")
