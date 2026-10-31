"""One-run native proof only; this driver is excluded from the fix PR."""

import pathlib
import subprocess
import sys


path = pathlib.Path("ios/Packages/ChatData/Tests/ChatDataTests/ChatSyncTests.swift")
test = "testOverlappingHistoryReadsCatchUpFromPriorCommittedCursor"
fixed = path.read_text()
baseline = subprocess.check_output(
    ["git", "show", f"HEAD~2:{path}"], text=True
)
command = [
    "swift", "test", "--package-path", "ios/Packages/ChatData",
    "--scratch-path", sys.argv[1], "--filter", f"ChatDataTests.ChatSyncTests/{test}",
]


def force_second_tail_before_detail(source):
    start = source.index(f"  func {test}()")
    end = source.index("  func testWarmingPersistsUnopenedHistory", start)
    method = source[start:end]
    method = method.replace(
        "    let requests = Mutex<[URLRequest]>([])",
        "    let releaseFirstDetail = SyncResponseGate()\n"
        "    defer { releaseFirstDetail.open() }\n"
        "    let proofTailReads = Mutex(0)\n"
        "    let requests = Mutex<[URLRequest]>([])",
        1,
    )
    method = method.replace(
        "        case 2:\n",
        "        case 2:\n"
        "          let tailRead = proofTailReads.withLock {\n"
        "            $0 += 1\n"
        "            return $0\n"
        "          }\n",
        1,
    )
    if "detailReads" in method:
        method = method.replace(
            "          return detailReads.withLock { $0 == 0 }",
            "          let response = detailReads.withLock { $0 == 0 }",
            1,
        )
    else:
        method = method.replace("          return first\n", "          let response = first\n", 1)
    method = method.replace(
        "        case 4: return syncPage([], cursor: 4)",
        "          if tailRead == 2 { releaseFirstDetail.open() }\n"
        "          return response\n"
        "        case 4: return syncPage([], cursor: 4)",
        1,
    )
    method = method.replace(
        "      case syncPath:\n",
        "      case syncPath:\n        await releaseFirstDetail.wait()\n",
        1,
    )
    assert method.count("await releaseFirstDetail.wait()") == 1
    assert method.count("if tailRead == 2 { releaseFirstDetail.open() }") == 1
    return source[:start] + method + source[end:]


try:
    print("BASELINE: hold thread details until the second tail response is chosen", flush=True)
    path.write_text(force_second_tail_before_detail(baseline))
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout, flush=True)
    assert result.returncode != 0, "Baseline unexpectedly passed the forced failure order"
    assert result.stdout.count("XCTAssertEqual failed") == 3, "Expected the three original assertions"
    assert "Latest answer" in result.stdout, "Expected the missing latest-message failure"
    print("PASS: baseline reproduces all three original assertion failures", flush=True)

    print("FIX: exercise the same forced order with the repaired fixture", flush=True)
    path.write_text(force_second_tail_before_detail(fixed))
    subprocess.run(command, check=True)
    print("PASS: the fix handles the forced failure order", flush=True)
finally:
    path.write_text(fixed)
