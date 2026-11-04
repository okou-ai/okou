"""Read dependency versions inside the official frozen runtime, without network IO."""

import importlib.metadata
import json
import platform
import re
from pathlib import Path

import _cffi_backend
import brotli
import certifi
import cryptography
import h2
import h11
import OpenSSL
import wsproto
from mitmproxy import ctx, version
from mitmproxy.addonmanager import Loader


def load(_loader: Loader) -> None:
    versions: dict[str, str] = {}
    for distribution in importlib.metadata.distributions():
        name = distribution.metadata["Name"]
        if not name:
            raise RuntimeError("Frozen distribution has no package name")
        versions[re.sub(r"[-_.]+", "-", name).lower()] = distribution.version
    # PyInstaller retains only some distribution metadata. Read the native
    # codec, FFI and protocol modules directly as well, without inventing versions.
    versions["mitmproxy"] = version.VERSION
    for name, module in (
        ("cffi", _cffi_backend),
        ("brotli", brotli),
        ("certifi", certifi),
        ("cryptography", cryptography),
        ("h11", h11),
        ("h2", h2),
        ("pyopenssl", OpenSSL),
        ("wsproto", wsproto),
    ):
        module_version = getattr(module, "__version__", None)
        if not isinstance(module_version, str):
            raise TypeError(f"Frozen {name} has no string version")
        versions[name] = module_version
    Path(__file__).with_suffix(".json").write_text(
        json.dumps({"python": platform.python_version(), "versions": versions}), encoding="utf-8"
    )
    ctx.master.shutdown()
