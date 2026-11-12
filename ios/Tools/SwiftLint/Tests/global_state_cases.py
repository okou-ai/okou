"""Global mutable state is checked through production-source CLI paths."""

GLOBAL_STATE_CASES = [
    (
        "file storage remains global under access and actor modifiers",
        "Okou/Features/State.swift",
        """
        import Foundation
        var currentWorkspace = "" // violation
        private var names: [String: String] = [:] // violation
        @MainActor var pending: Task<Void, Never>? // violation
        nonisolated(unsafe) var count = 0 // violation
        var first = 0, // violation
          second = 1 // violation
        var (left, right) = (0, 1) // violation
        var observed = 0 { didSet { report(observed) } } // violation
        let constants = ["one", "two"]
        let values: [String: Int] = ["one": 1]
        let shared = ExistingApplicationOwner()
        var title: String { "Okou" }
        var setting: Int {
          get { owner.setting }
          set { owner.setting = newValue }
        }
    """,
    ),
    (
        "static storage includes observers and private setters",
        "Okou/Features/Cache.swift",
        """
        final class Cache {
          private static var values: [String: String] = [:] // violation
          static private(set) var count = 0 // violation
          @MainActor static var pending: Task<Void, Never>? // violation
          static var observed = 0 { willSet { report(newValue) } } // violation
          static var changed = 0 { didSet { report(oldValue) } } // violation
          static var both = 0 { // violation
            willSet { report(newValue) }
            didSet { report(oldValue) }
          }
          static let immutable = ["one": 1]
          static let shared = ExistingApplicationOwner()
          var values: [String: String] = [:]
          var pending: Task<Void, Never>?
        }
        actor Owner {
          static var cache: [String: String] = [:] // violation
          var cache: [String: String] = [:]
        }
        enum Registry {
          static var handlers: [String: () -> Void] = [:] // violation
        }
        extension Cache {
          static var fallback: String? // violation
        }
    """,
    ),
    (
        "native computed properties and protocol requirements have no stored slot",
        "Okou/Views/NativeContracts.swift",
        """
        import SwiftUI
        protocol Contract {
          static var value: Int { get set }
        }
        struct Preference: PreferenceKey {
          static var defaultValue: String? { nil }
          static func reduce(value: inout String?, nextValue: () -> String?) {}
        }
        struct Attachment {
          static var transferRepresentation: some TransferRepresentation {
            FileRepresentation(exportedContentType: .data) { file in file.url }
          }
        }
        class Control {
          class var isAvailable: Bool { true }
          static var current: Int {
            get { source.current }
            set { source.current = newValue }
          }
          static var borrowed: Int {
            _read { yield source.current }
            _modify { yield &source.current }
          }
        }
    """,
    ),
    (
        "conditional compilation does not create a state owner",
        "Okou/App/Conditional.swift",
        """
        #if DEBUG
        private var cache: [String: Int] = [:] // violation
        #else
        private var cache: [String: Int] = [:] // violation
        #endif
        struct Owner {
          #if DEBUG
          static var counter = 0 // violation
          #endif
          var count = 0
        }
        func execute() {
          #if DEBUG
          var local = 0
          #endif
        }
        let factory = {
          var temporary = [String: String]()
          return temporary
        }
        if enabled { var temporary = 0 }
    """,
    ),
    (
        "local values and per-instance storage belong to their owner",
        "Okou/Features/Owner.swift",
        """
        @MainActor final class Owner {
          var value = 0
          private var callbacks: [String: () -> Void] = [:]
          lazy var derived = makeValue()
          func update() {
            var copy = value
            let callback = { var temporary = copy; temporary += 1 }
          }
          static func make() {
            var local = 0
            struct Local {
              static var shared = 0 // violation
              var value = 0
            }
          }
          var computed: Int {
            var temporary = value
            return temporary
          }
        }
        struct View {
          @State private var selected = false
        }
    """,
    ),
    (
        "test-like production filenames remain production",
        "Okou/Features/StateTests.swift",
        """
        import XCTest
        var sharedFixtureName = "" // violation
        struct PreviewFixture { static var value = 0 } // violation
    """,
    ),
]

for name, filename in [
    ("push process", "Push/NotificationService.swift"),
    ("domain model", "Packages/ChatDomain/Sources/ChatDomain/State.swift"),
    ("data service", "Packages/ChatData/Sources/ChatData/State.swift"),
]:
    GLOBAL_STATE_CASES.append(
        (name, filename, "private var shared = 0 // violation\n")
    )

for filename in [
    "OkouTests/Fixture.swift",
    "Packages/ChatDomain/Tests/ChatDomainTests/Fixture.swift",
    "Packages/ChatData/Tests/ChatDataTests/Fixture.swift",
    "Packages/ChatData/Sources/ChatDataTestSupport/Fixture.swift",
    "Tools/SwiftLint/Rules/Fixture.swift",
]:
    GLOBAL_STATE_CASES.append(
        (
            "fixture or lint-tool storage: " + filename,
            filename,
            "var fixture = 0\nstruct Fixture { static var value = 0 }\n",
        )
    )

GLOBAL_STATE_CASES += [
    (
        "checkout names do not change the native test boundary",
        "Okou/ios/OkouTests/Fixture.swift",
        "var fixture = 0\n",
    ),
    (
        "checkout names do not hide production storage",
        "Okou/ios/Push/NotificationService.swift",
        "var shared = 0 // violation\n",
    ),
]
