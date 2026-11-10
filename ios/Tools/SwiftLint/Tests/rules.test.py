"""Validate public diagnostics using the compiled SwiftLint CLI, without an App build."""

import json
import os
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path

IOS = Path(__file__).resolve().parents[3]
BINARY = (
    os.environ.get("SWIFTLINT_BIN")
    or subprocess.check_output(
        ["bash", str(IOS / "scripts" / "install-swiftlint.sh"), "--path-only"],
        text=True,
    ).strip()
)

CASES = [
    (
        "typed cancellation cannot become resource data",
        "okou_resource_failures",
        """
        import CCState
        let items = computedTask { get, options in
          do { return try await service.load() }
          catch is CancellationError { return [] } // violation
        }
        let read = Computed { get in
          Task {
            do { return try await service.load() }
            catch let cancelled as CancellationError { // violation
              record(cancelled)
              return nil
            }
          }
        }
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch is _Concurrency.CancellationError { // violation
            if closed { return [:] }
            throw CancellationError()
          }
        }
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch is CancellationError {} // violation
        }
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch let cancelled where cancelled is CancellationError { return [] } // violation
        }
        func makeData() -> Computed<Task<[String], Never>> {
          Computed { get in
            Task {
              do { return try await service.load() }
              catch is CancellationError { return [] } // violation
              catch { return owner.recoveredSnapshot(for: error) }
            }
          }
        }
    """,
    ),
    (
        "cancellation cleanup and native action completion",
        "okou_resource_failures",
        """
        import CCState
        let items = computedTask { get, options in
          do { return try await service.load() }
          catch let cancelled as CancellationError {
            try? await allocated.close()
            let cleanup = { return [] }
            throw cancelled
          }
        }
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch is CancellationError {
            try? await allocated.close()
            throw CancellationError()
          }
          catch is MissingOptionalResource { return [] }
        }
        let action = asyncCommand { context in
          do { try await service.save() }
          catch is CancellationError { return }
        }
        func closePresentation() async {
          do { try await operation.value }
          catch is CancellationError { return }
        }
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch let cancelled where cancelled is CancellationError {
            try? await allocated.close()
            throw cancelled
          }
        }
        func makeCompletion() -> Computed<Task<Void, Never>> {
          Computed { get in
            Task {
              do { try await owner.perform() }
              catch is CancellationError {}
              catch { owner.report(error) }
            }
          }
        }
        let completion: CCState.Computed<Task<(), Never>> = Computed { get in
          Task {
            do { try await owner.perform() }
            catch is CancellationError { return }
            catch { owner.report(error) }
          }
        }
    """,
    ),
    (
        "fixed sleeps in XCTest",
        "okou_test_synchronization",
        """
        import XCTest
        final class FlowTests: XCTestCase {
          func testCompletion() async throws {
            try await Task.sleep(for: .milliseconds(20)) // violation
            try await Task<Never, Never>.sleep(nanoseconds: 1_000) // violation
            try await _Concurrency.Task<Never, Never>.sleep(nanoseconds: 1_000) // violation
            Thread.sleep(forTimeInterval: (0.01)) // violation
            usleep(1_000) // violation
            Darwin.sleep(1) // violation
            let delay = Duration.seconds(1)
            try await Task.sleep(for: delay) // violation
            let nanos = UInt64(10 * 1_000)
            try await Task.sleep(nanoseconds: nanos) // violation
          }
        }
    """,
    ),
    (
        "fixed yield counts in Swift Testing",
        "okou_test_synchronization",
        """
        import Testing
        @Test func completes() async {
          for _ in (0..<100) {
            await Task.yield() // violation
          }
          let attempts = 10
          for _ in 1...attempts {
            await Task.yield() // violation
          }
        }
    """,
    ),
    (
        "observable waits and injected clocks",
        "okou_test_synchronization",
        """
        import XCTest
        final class FlowTests: XCTestCase {
          func testCompletion() async throws {
            await operation.value
            await gate.wait()
            await fulfillment(of: [finished], timeout: 1)
            try await clock.sleep(until: deadline)
            while !owner.complete { await Task.yield() }
            for _ in 0..<10 {
              installCallback { await Task.yield() }
            }
          }
          private func makeOwner(sleep: (Duration) async throws -> Void = {
            try await Task.sleep(for: $0)
          }) {}
          private func forward(_ delay: Duration) async throws {
            try await Task.sleep(for: delay, tolerance: .zero)
          }
        }
        func pollProtocol() async throws {
          try await Task.sleep(for: .seconds(1))
        }
    """,
    ),
    (
        "clock callback parameters shadow constants",
        "okou_test_synchronization",
        """
        import XCTest
        final class FlowTests: XCTestCase {
          func testCompletion() async throws {
            let duration = Duration.seconds(1)
            makeClock { duration in try await Task.sleep(for: duration) }
            let clockStep = { (duration: Duration) in try await Task.sleep(for: duration) }
          }
        }
    """,
    ),
    (
        "throwing Tasks have an explicit result owner",
        "unhandled_throwing_task",
        """
        func start() {
          Task { try await service.load() } // violation
          let task = Task { try await service.load() }
          let read = Read(task: task)
        }
        func read() async throws {
          _ = try await Task { try await service.load() }.value
        }
    """,
    ),
    (
        "native notification observer handles are retained",
        "discarded_notification_center_observer",
        """
        import Foundation
        func observe() {
          center.addObserver(forName: .event, object: nil, queue: nil) { _ in } // violation
          let observer = center.addObserver(forName: .event, object: nil, queue: nil) { _ in }
        }
    """,
    ),
    (
        "SwiftUI owns private view state",
        "private_swiftui_state",
        """
        import SwiftUI
        struct Screen: View {
          @State var expanded = false // violation
          @State private var selected = false
          @Binding var value: String
          var body: some View { Text(value) }
        }
    """,
    ),
    (
        "render effects",
        "okou_render_effects",
        """
        import CCState
        import SwiftUI
        struct Screen: View {
          let store = CCState.Store()
          @State private var count = 0
          @CommandSetter private var save: () -> Void
          var body: some View {
            let _ = Task { await refresh() } // violation
            let _ = Timer.scheduledTimer(withTimeInterval: 1, repeats: false) { _ in } // violation
            DispatchQueue.main.async { refresh() } // violation
            try? store.set(command) // violation
            self.count = 1 // violation
            save() // violation
            return VStack {
              Text("Hello")
              let _ = CCState.State(0) // violation
            }
          }
        }
    """,
    ),
    (
        "deferred actions and eager label",
        "okou_render_effects",
        """
        import CCState
        import SwiftUI
        struct Screen: View {
          let store = CCState.Store()
          var body: some View {
            Button {
              Task { try await store.set(save).value }
            } label: {
              let _ = Task { await refresh() } // violation
              Text("Save")
            }
            .task { await refresh() }
            .onChange(of: value) { _, _ in owner.reload() }
            .signOutConfirmation(isPresented: $confirm) { Task { await signOut() } }
          }
        }
    """,
    ),
    (
        "builder helpers and UIKit graph writes",
        "okou_render_effects",
        """
        import CCState
        import SwiftUI
        struct Screen: View {
          let store = CCState.Store()
          @ViewBuilder func content() -> some View {
            try? store.set(save) // violation
            Text("Hello")
          }
          func updateUIView(_ view: UIView, context: Context) {
            view.backgroundColor = .clear
            try? store.set(save) // violation
          }
        }
    """,
    ),
    (
        "stable owner and factories",
        "okou_stable_graph",
        """
        import CCState
        final class Owner {
          private let input = CCState.State(0)
          let read: Computed<Int>
          let write: Command<Void, Int>
          init() {
            read = Computed { get in try get(input) }
            write = Command { context, value in try context.set(input, value) }
          }
          func makeRead() -> Computed<Int> { Computed { get in try get(input) } }
        }
    """,
    ),
    (
        "nested graph definitions",
        "okou_stable_graph",
        """
        import CCState
        let action = Command { context in
          let child = Command { context in } // violation
          let input = CCState.State(0) // violation
        }
        let read = Computed { get in
          let child = Computed { get in 1 } // violation
          return 1
        }
        struct Screen: View {
          var body: some View {
            Button("Save") {
              let action = Command { context in } // violation
            }
          }
        }
    """,
    ),
    (
        "private atoms and native view state",
        "okou_private_atoms",
        """
        import CCState
        import SwiftUI
        final class Owner {
          private let input = CCState.State(0)
          fileprivate let lifetime = CCState.State(true)
          let read = Computed { get in 1 }
          func makeDraft() { let local = CCState.State(0) }
        }
        private class HiddenOwner { let input = CCState.State(0) }
        struct Screen: View { @State private var selected = false }
    """,
    ),
    (
        "exposed atoms",
        "okou_private_atoms",
        """
        import CCState
        let input = CCState.State(0) // violation
        class Owner {
          let input = CCState.State(0) // violation
          var atom: CCState.State<Int> // violation
          private(set) var readableAtom = CCState.State(0) // violation
          var atoms: [String: CCState.State<Int>] // violation
          func mutableAtom() -> CCState.State<Int> { CCState.State(0) } // violation
        }
    """,
    ),
    (
        "direct graph access and native suspension",
        "okou_accessor_escape",
        """
        import CCState
        let read = computedTask { get, options in
          let task = try get(resource)
          return try await task.value
        }
        let save = asyncCommand { context, value in
          try context.set(input, value)
          await persist()
          try context.set(saved, true)
        }
    """,
    ),
    (
        "escaped graph accessors",
        "okou_accessor_escape",
        """
        import CCState
        let read = Computed { get in
          helper(get) // violation
          return 1
        }
        let save = Command { context in
          stored = context // violation
          helper(context) // violation
        }
        func helper(_ get: Getter) {} // violation
        func helper(_ context: CCState.CommandContext) {} // violation
        func helper(_ payload: [CCState.Getter]) {} // violation
    """,
    ),
    (
        "raw requests and typed services",
        "okou_native_requests",
        """
        import Foundation
        let session: URLSession = .shared
        func load() async throws {
          _ = try await URLSession.shared.data(from: url) // violation
          _ = try await session.data(for: request) // violation
          _ = try await typedService.load()
          let values = store.data
        }
    """,
    ),
    (
        "comments and strings",
        "okou_native_requests",
        """
        // URLSession.shared.data(from: url)
        let description = "URLSession.shared.data(from: url)"
        struct Document { func data(from input: String) {} }
        let document = Document()
        document.data(from: "text")
    """,
    ),
    (
        "resource failures",
        "okou_resource_failures",
        """
        import CCState
        let read = computedTask { get, options in
          try? await service.load() // violation
        }
        let read = Computed { get in
          Task {
            do { return try await service.load() }
            catch { return [] } // violation
          }
        }
        let action = asyncCommand { context in
          do { try await service.save() }
          catch {} // violation
        }
    """,
    ),
    (
        "cancellation and primary-error cleanup",
        "okou_resource_failures",
        """
        import CCState
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch is CancellationError { throw CancellationError() }
          catch {
            try? await allocated.close()
            throw error
          }
        }
        func nativePreview() async {
          _ = try? await webView.takeSnapshot()
        }
    """,
    ),
    (
        "explicit Button action leaves label eager",
        "okou_render_effects",
        """
        import SwiftUI
        struct Screen: View {
          var body: some View {
            Button(action: { Task { await save() } }) {
              let _ = Task { await load() } // violation
              Text("Save")
            }
            .transaction { $0.animation = nil }
          }
        }
    """,
    ),
    (
        "native projection and shared actions",
        "okou_render_effects",
        """
        import CCState
        import SwiftUI
        struct Screen: View {
          @State private var count = 0
          let store = CCState.Store()
          var body: some View {
            OkouLoadErrorRow(message: "Failed") { Task { await retry() } }
            OkouChip(title: Text("All"), isSelected: true) { count += 1 }
            Text("Value").transaction {
              $0.animation = nil
              self.count = 1 // violation
            }
          }
          func updateUIView(_ container: Container, context: Context) {
            let view = container.textView
            let coordinator = context.coordinator
            view.text = text
            coordinator.owner = self
            view.onChange = { Task { await save() } }
            try? store.set(save) // violation
          }
        }
    """,
    ),
    (
        "authorization callbacks preserve eager render checks",
        "okou_render_effects",
        """
        import SwiftUI
        struct Screen: View {
          let store: Owner
          var body: some View {
            ComputerAuthorizationCardContent(
              decide: { decision in Task { await store.decide(decision) } },
              retry: { Task { await store.refresh() } })
            ChatActionCard {
              Text("Authorize")
            } actions: {
              let _ = Task { await store.decide(.approve) } // violation
              Text("Actions")
            }
            UnregisteredView(decide: {
              let _ = Task { await store.decide(.approve) } // violation
              Text("Content")
            })
          }
        }
    """,
    ),
    (
        "authorization callbacks reuse graph definitions",
        "okou_stable_graph",
        """
        import CCState
        import SwiftUI
        struct Screen: View {
          var body: some View {
            ComputerAuthorizationCardContent(
              decide: { decision in
                let command = Command { context in } // violation
              },
              retry: {})
          }
        }
    """,
    ),
    (
        "authorization callbacks cannot capture graph accessors",
        "okou_accessor_escape",
        """
        import CCState
        let read = Computed { get in
          ComputerAuthorizationCardContent(
            decide: { _ in try? get(input) }, // violation
            retry: {})
        }
    """,
    ),
    (
        "semantic methods reuse graph definitions",
        "okou_stable_graph",
        """
        import CCState
        final class Owner {
          func save() { let command = Command { context in } } // violation
          func saveResult() -> Bool { let command = Command { context in }; return true } // violation
          func makeRead() -> Computed<Int> { Computed { get in 1 } }
        }
        final class OwnerTests: XCTestCase {
          func testOwner() { let store = CCState.Store() }
        }
    """,
    ),
    (
        "typed accessor names and deferred captures",
        "okou_accessor_escape",
        """
        import CCState
        func nativeHelper(_ value: NativeGetter, _ other: Custom.Getter) {}
        let read = Computed { get in
          let task = Task { try get(input) } // violation
          return task
        }
        let action = asyncCommand { context in
          let task = Task { try context.set(input, 1) } // violation
        }
    """,
    ),
    (
        "request aliases and method references",
        "okou_native_requests",
        """
        import Foundation
        let session = URLSession.shared
        let alias = session
        let load = alias.data // violation
        let qualified = Foundation.URLSession.shared.data // violation
        let optional: URLSession? = .shared
        func read() async throws { _ = try await optional?.data(from: url) } // violation
    """,
    ),
    (
        "named errors and original failure cleanup",
        "okou_resource_failures",
        """
        import CCState
        let read = computedTask { get, options in
          do { return try await service.load() }
          catch let original {
            try? await allocated.close()
            throw original
          }
        }
        let action = asyncCommand { context in
          do { try await save() }
          catch let failure {} // violation
        }
    """,
    ),
    (
        "computed view helpers and compound assignments",
        "okou_render_effects",
        """
        import SwiftUI
        struct Screen: View {
          @State private var count = 0
          var header: some View {
            count += 1 // violation
            let _ = Task { await load() } // violation
            return Text("Header")
          }
        }
    """,
    ),
    (
        "task-returning commands preserve failure",
        "okou_resource_failures",
        """
        import CCState
        let action = Command { context in
          Task { try? await save() } // violation
        }
    """,
    ),
    (
        "accessor shadowing",
        "okou_accessor_escape",
        """
        import CCState
        let read = Computed { get in
          let values = try get(items)
          return values.map { get in get.name }
        }
    """,
    ),
    (
        "native menu actions and local configurations",
        "okou_render_effects",
        """
        import SwiftUI
        struct Menu: UIViewRepresentable {
          let owner: Owner
          func updateUIView(_ button: UIButton, context: Context) {
            var configuration = UIButton.Configuration.glass()
            configuration.title = "Filter"
            configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
              var attributes = attributes
              attributes.font = font
              return attributes
            }
            button.configuration = configuration
            let action = UIAction(title: "Refresh") { _ in Task { await owner.refresh() } }
            let existing = owner
            existing.title = "Changed" // violation
          }
        }
    """,
    ),
]


class NativeRuleTests(unittest.TestCase):
    def lint(self, root, source, rule, filename="Screen.swift"):
        path = root / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(source)
        config = root / "lint.yml"
        config.write_text(f"only_rules: [{rule}]\ncheck_for_updates: false\n")
        result = subprocess.run(
            [
                BINARY,
                "lint",
                "--strict",
                "--no-cache",
                "--disable-sourcekit",
                "--config",
                str(config),
                "--reporter",
                "json",
                str(path),
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotIn("warning:", result.stderr, result.stderr)
        return result, json.loads(result.stdout)

    def test_native_contracts(self):
        with tempfile.TemporaryDirectory(prefix="native lint cases ") as directory:
            for name, rule, source in CASES:
                with self.subTest(name=name):
                    source = textwrap.dedent(source).lstrip()
                    expected = [
                        i
                        for i, line in enumerate(source.splitlines(), 1)
                        if "// violation" in line
                    ]
                    root = Path(directory) / name
                    root.mkdir()
                    result, diagnostics = self.lint(root, source, rule)
                    self.assertEqual(
                        result.returncode, 2 if expected else 0, result.stderr
                    )
                    self.assertEqual(
                        sorted((d["rule_id"], d["line"]) for d in diagnostics),
                        [(rule, line) for line in expected],
                        result.stdout,
                    )

    def test_transport_definition_site(self):
        with tempfile.TemporaryDirectory(prefix="native transport owner ") as directory:
            source = "import Foundation\nfunc execute() { URLSession.shared.dataTask(with: request) }\n"
            _, findings = self.lint(
                Path(directory),
                source,
                "okou_native_requests",
                "Packages/ChatData/Sources/ChatData/APIClient.swift",
            )
            self.assertEqual(findings, [])

    def test_test_helper_waits(self):
        with tempfile.TemporaryDirectory(prefix="native test helpers ") as directory:
            source = (
                "import Foundation\n"
                "func waitForTurn() async throws { try await Task.sleep(for: .milliseconds(10)) }\n"
                "func forward(_ duration: Duration) async throws { try await Task.sleep(for: duration) }\n"
            )
            result, findings = self.lint(
                Path(directory),
                source,
                "okou_test_synchronization",
                "Tests/Helpers.swift",
            )
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(
                [(f["rule_id"], f["line"]) for f in findings],
                [("okou_test_synchronization", 2)],
            )


if __name__ == "__main__":
    unittest.main()
