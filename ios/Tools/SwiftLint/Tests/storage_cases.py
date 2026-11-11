"""Native preference boundaries exercised through public SwiftLint diagnostics."""

STORAGE_CASES = [
    (
        "features acquire preferences through their owner",
        "Okou/Features/Other/Screen.swift",
        """
        import Foundation
        let value = UserDefaults.standard.string(forKey: "business") // violation
        let defaults = Foundation.UserDefaults.standard // violation
        let alias = defaults
        let suite = UserDefaults(suiteName: "business") // violation
        let make = UserDefaults.init // violation
        let type = UserDefaults.self // violation
        let escaped = `Foundation`.`UserDefaults`.standard // violation
        """,
    ),
    (
        "injection and type aliases do not create new storage owners",
        "Okou/Features/Other/Owner.swift",
        """
        import Foundation
        typealias Preferences = UserDefaults // violation
        typealias Qualified = Foundation.UserDefaults // violation
        struct Owner {
          let defaults: UserDefaults // violation
          let optional: Foundation.UserDefaults? // violation
          let grouped: [String: UserDefaults] // violation
          func read(_ defaults: UserDefaults) {} // violation
          func expose() -> UserDefaults { fatalError() } // violation
        }
        """,
    ),
    (
        "unrelated names and documentation are not defaults access",
        "Okou/Features/Other/Screen.swift",
        """
        import Foundation
        let text = "UserDefaults.standard.set(value, forKey: key)"
        // @AppStorage("business") var value = false
        struct Document { func set(_ value: Bool, forKey key: String) {} }
        let document = Document()
        document.set(true, forKey: "text")
        let custom: Custom.UserDefaults
        let wrapper: Custom.AppStorage<String>
        let value = Custom.UserDefaults.standard
        """,
    ),
    (
        "project disclosure now uses its typed SQLite owner",
        "Okou/Features/ChatList/ChatProjectStore.swift",
        """
        import Foundation
        final class ChatProjectStore {
          let defaults: UserDefaults // violation
          init(defaults: UserDefaults = .standard) { self.defaults = defaults } // violation
          func persist(_ expansion: [String: Bool], key: String) {
            defaults.set(expansion, forKey: key)
          }
        }
        """,
    ),
    (
        "one-way disclosure migration owns legacy defaults access",
        "Packages/ChatData/Sources/ChatData/ProjectDisclosureMigration.swift",
        """
        import Foundation
        let defaults = UserDefaults.standard
        let previous = defaults.dictionary(forKey: legacyKey)
        defaults.removeObject(forKey: legacyKey)
        """,
    ),
    (
        "migration basenames do not give feature code defaults access",
        "Okou/Features/Other/ProjectDisclosureMigration.swift",
        """
        import Foundation
        let defaults = UserDefaults.standard // violation
        """,
    ),
    (
        "notification metadata retains its existing defaults owner",
        "Okou/Services/NotificationService.swift",
        """
        import Foundation
        let defaults: Foundation.UserDefaults = .standard
        let revision = defaults.integer(forKey: "ios-push-revision")
        defaults.set(revision + 1, forKey: "ios-push-revision")
        defaults.removeObject(forKey: "ios-pending-badge-clear-sequence")
        """,
    ),
    (
        "matching owner filenames elsewhere do not acquire persistence",
        "Okou/Features/Other/NotificationService.swift",
        """
        import Foundation
        let defaults = UserDefaults.standard // violation
        """,
    ),
    (
        "package production is not a blanket persistence owner",
        "Packages/ChatData/Sources/ChatData/OtherStorage.swift",
        """
        import Foundation
        let defaults = UserDefaults(suiteName: "business") // violation
        """,
    ),
    (
        "the application appearance modifier owns its theme preference",
        "Okou/App/OkouAppearance.swift",
        """
        import SwiftUI
        struct OkouAppearance: ViewModifier {
          @AppStorage(OkouAppearancePreference.storageKey) private var appearance = "system"
        }
        """,
    ),
    (
        "settings retain their native theme binding",
        "Okou/Features/ChatList/ChatSettingsView.swift",
        """
        import SwiftUI
        struct ChatSettingsView: View {
          @SwiftUI.AppStorage(OkouAppearancePreference.storageKey) private var appearance = "system"
        }
        """,
    ),
    (
        "sidebar disclosure remains a native UI preference",
        "Okou/Features/ChatList/ChatSidebarView.swift",
        """
        import SwiftUI
        struct ChatSidebarView: View {
          @AppStorage("okou.sidebar.pinnedCollapsed") private var collapsed = false
          @SwiftUI.AppStorage(#"okou.sidebar.pinnedCollapsed"#) private var raw = false
        }
        """,
    ),
    (
        "known UI files cannot persist arbitrary business keys",
        "Okou/Features/ChatList/ChatSidebarView.swift",
        """
        import SwiftUI
        @AppStorage("business") private var value = false // violation
        @AppStorage(otherKey) private var other = false // violation
        @AppStorage("okou.sidebar.pinnedCollapsed", store: .standard) private var custom = false // violation
        @AppStorage(OkouAppearancePreference.storageKey) private var theme = "system" // violation
        """,
    ),
    (
        "theme preference contracts do not grant direct defaults access",
        "Okou/App/OkouAppearance.swift",
        """
        import SwiftUI
        @AppStorage("business") private var value = false // violation
        let defaults = UserDefaults.standard // violation
        """,
    ),
    (
        "feature AppStorage cannot bypass the persistence owner",
        "Okou/Features/Other/Screen.swift",
        """
        import SwiftUI
        @AppStorage("business") private var value = false // violation
        @SwiftUI.AppStorage("business") private var qualified = false // violation
        @`SwiftUI`.`AppStorage`("business") private var escaped = false // violation
        @AppStorage(OkouAppearancePreference.storageKey) private var theme = "system" // violation
        @AppStorage("okou.sidebar.pinnedCollapsed") private var collapsed = false // violation
        """,
    ),
    (
        "preference owner basenames are not directory exemptions",
        "Okou/Features/Other/ChatSettingsView.swift",
        """
        import SwiftUI
        @AppStorage(OkouAppearancePreference.storageKey) private var theme = "system" // violation
        """,
    ),
    (
        "raw storage owners do not acquire arbitrary AppStorage bindings",
        "Okou/Services/NotificationService.swift",
        """
        import SwiftUI
        @AppStorage("business") private var value = false // violation
        """,
    ),
    (
        "AppStorage constructors and type aliases cannot bypass declaration checks",
        "Okou/Features/Other/Screen.swift",
        """
        import SwiftUI
        let value = AppStorage(wrappedValue: false, "business") // violation
        let other = SwiftUI.AppStorage(wrappedValue: false, "business") // violation
        let make = SwiftUI.AppStorage<Bool>.init // violation
        typealias Preference = AppStorage<String> // violation
        typealias QualifiedPreference = SwiftUI.AppStorage<String> // violation
        """,
    ),
    (
        "registered view preferences cannot add custom storage constructors",
        "Okou/Features/ChatList/ChatSettingsView.swift",
        """
        import SwiftUI
        let value = AppStorage(wrappedValue: "system", OkouAppearancePreference.storageKey) // violation
        """,
    ),
    (
        "tests construct explicit isolated suites",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        import XCTest
        func testPreferences() throws {
          let suite = "preferences-" + UUID().uuidString
          let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
          defer { defaults.removePersistentDomain(forName: suite) }
          defaults.set(true, forKey: "business")
          let alias = defaults
          let read = alias.bool(forKey:)
          XCTAssertTrue(read("business"))
          let qualified = Foundation.UserDefaults.init(suiteName: suite)
        }
        """,
    ),
    (
        "test path does not permit standard defaults or constructor escape",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        let defaults = UserDefaults.standard // violation
        let read = Foundation.UserDefaults.standard.string // violation
        let unnamed = UserDefaults() // violation
        let initialized = UserDefaults.init() // violation
        let make = UserDefaults.init // violation
        let type = UserDefaults.self // violation
        """,
    ),
    (
        "test suites cannot request the unnamed defaults domain",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        let nilSuite = UserDefaults(suiteName: nil) // violation
        let empty = UserDefaults(suiteName: "") // violation
        let qualified = Foundation.UserDefaults.init(suiteName: nil) // violation
        """,
    ),
    (
        "contextual test construction retains an explicit suite",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        let suite = "preferences-" + UUID().uuidString
        let defaults: UserDefaults? = .init(suiteName: suite)
        let qualified: Foundation.UserDefaults? = .init(suiteName: suite)
        func fixture(suite: String) -> UserDefaults? { .init(suiteName: suite) }
        func unwrap(suite: String) -> UserDefaults { return .init(suiteName: suite)! }
        """,
    ),
    (
        "inferred standard defaults are still shared test state",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        let defaults: UserDefaults = .standard // violation
        let qualified: Foundation.UserDefaults? = .standard // violation
        func helper(defaults: UserDefaults = .standard) {} // violation
        func shared() -> UserDefaults { .standard } // violation
        func returned() -> UserDefaults { return .standard } // violation
        """,
    ),
    (
        "inferred initializers must still name the test suite",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        let defaults: UserDefaults = .init() // violation
        let optional: UserDefaults? = .init(suiteName: nil) // violation
        func helper(defaults: UserDefaults = .init()) {} // violation
        func shared() -> UserDefaults { .init() } // violation
        func empty() -> UserDefaults? { return .init(suiteName: "") } // violation
        """,
    ),
    (
        "test aliases and subclasses cannot hide shared defaults acquisition",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        typealias Preferences = UserDefaults // violation
        typealias Qualified = Foundation.UserDefaults // violation
        class PreferencesSubclass: UserDefaults {} // violation
        """,
    ),
    (
        "test annotations retain typed dependency injection",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        struct Fixture {
          let defaults: UserDefaults
          func read(_ injected: Foundation.UserDefaults) -> Bool {
            injected.bool(forKey: "business")
          }
        }
        """,
    ),
    (
        "package tests retain isolated storage fixtures",
        "Packages/ChatData/Tests/ChatDataTests/PreferenceTests.swift",
        """
        import Foundation
        let suite = "preferences-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let shared = UserDefaults.standard // violation
        """,
    ),
    (
        "domain tests do not acquire a standard domain exemption",
        "Packages/ChatDomain/Tests/ChatDomainTests/PreferenceTests.swift",
        """
        import Foundation
        let suite = "preferences-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let shared = UserDefaults.standard // violation
        """,
    ),
    (
        "shared test support uses named suites too",
        "Packages/ChatData/Sources/ChatDataTestSupport/PreferenceFixture.swift",
        """
        import Foundation
        func fixture(_ suite: String) -> UserDefaults? {
          UserDefaults(suiteName: suite)
        }
        let shared = UserDefaults.standard // violation
        """,
    ),
    (
        "a test-like production filename is not an isolated fixture site",
        "Okou/Features/Other/PreferenceTests.swift",
        """
        import Foundation
        let defaults = UserDefaults(suiteName: "business") // violation
        """,
    ),
    (
        "a production Tests folder is not a native test target",
        "Okou/Features/Tests/PreferenceStore.swift",
        """
        import Foundation
        let defaults = UserDefaults(suiteName: "business") // violation
        """,
    ),
    (
        "tests cannot create arbitrary AppStorage declarations",
        "OkouTests/PreferenceTests.swift",
        """
        import SwiftUI
        @AppStorage("business") private var value = false // violation
        """,
    ),
    (
        "inactive branches and qualified spellings retain the boundary",
        "Okou/Features/Other/Screen.swift",
        """
        import Foundation
        #if false
        let defaults = Foundation.UserDefaults.standard // violation
        #endif
        let escaped = `UserDefaults`.standard // violation
        let type: `Foundation`.`UserDefaults` // violation
        """,
    ),
    (
        "computed fixture properties cannot acquire standard defaults",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        struct Fixture {
          var shared: UserDefaults { .standard } // violation
          var returned: UserDefaults { get { return .standard } } // violation
          var unnamed: UserDefaults { .init() } // violation
          var isolated: UserDefaults? { .init(suiteName: "fixture-" + UUID().uuidString) }
        }
        """,
    ),
    (
        "typed fixture closures cannot acquire an unnamed domain",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        let shared = { () -> UserDefaults in .standard } // violation
        let unnamed = { () -> UserDefaults in return .init() } // violation
        let isolated = { () -> UserDefaults? in .init(suiteName: "fixture-" + UUID().uuidString) }
        """,
    ),
    (
        "parentheses do not turn nil into an isolated suite",
        "OkouTests/PreferenceTests.swift",
        """
        import Foundation
        let unnamed = UserDefaults(suiteName: (nil)) // violation
        let empty = UserDefaults(suiteName: (#""#)) // violation
        let defaults: UserDefaults = (.standard) // violation
        let qualified: Foundation.UserDefaults = (.init()) // violation
        """,
    ),
    (
        "inferred production acquisition reports its raw type boundary once",
        "Okou/Features/Other/Screen.swift",
        """
        import Foundation
        let defaults: UserDefaults = .standard // violation
        let unnamed: Foundation.UserDefaults = .init() // violation
        """,
    ),
    (
        "qualified and escaped registered wrappers retain their preference key",
        "Okou/App/OkouAppearance.swift",
        """
        import SwiftUI
        @`SwiftUI`.`AppStorage`(OkouAppearancePreference.storageKey) private var appearance = "system"
        """,
    ),
    (
        "unrelated standard values do not become defaults",
        "OkouTests/PreferenceTests.swift",
        """
        struct Configuration { static let standard = Configuration() }
        let configuration: Configuration = .standard
        func build() -> Configuration { .init() }
        func wrap() -> UserDefaults? { factory(configuration: .standard) }
        """,
    ),
]
