"""Native import contracts verified through public SwiftLint diagnostics."""

IMPORT_CASES = [
    (
        "feature imports retain their SDK owners",
        "Okou/Features/ChatDetail/Screen.swift",
        """
        import Foundation
        import SwiftUI
        import ChatData
        import Ably // violation
        import ClerkKit // violation
        import ClerkKitUI // violation
        @preconcurrency import Ably // violation
        @_exported import ClerkKit // violation
        import class ClerkKit.Clerk // violation
        public import Ably // violation
        import `Ably` // violation
        @preconcurrency
        import ClerkKit // violation
        let text = "import Ably"
        // import ClerkKit
        """,
    ),
    (
        "conditional and scoped imports cannot bypass SDK ownership",
        "Okou/Features/Other/Screen.swift",
        """
        #if canImport(ClerkKit)
        import ClerkKit // violation
        #endif
        #if false
        @testable import Ably // violation
        #endif
        import struct Ably.ClientOptions // violation
        import enum ClerkKit.OAuthProvider // violation
        import enum `ClerkKit`.OAuthProvider // violation
        """,
    ),
    (
        "realtime adapter owns Ably rather than authentication",
        "Okou/Services/RealtimeService.swift",
        """
        import Foundation
        @preconcurrency import Ably
        import ClerkKit // violation
        """,
    ),
    (
        "authentication adapter owns Clerk rather than realtime",
        "Okou/Services/AuthenticationService.swift",
        """
        import Foundation
        import ClerkKit
        import Ably // violation
        import ClerkKitUI // violation
        """,
    ),
    (
        "native authentication presentation keeps the official SDK UI",
        "Okou/Features/SignIn/NativeAuthView.swift",
        """
        import SwiftUI
        import ClerkKit
        import ClerkKitUI
        """,
    ),
    (
        "shared authentication theme owns its SDK customization",
        "Okou/DesignSystem/Foundations/OkouAuthTheme.swift",
        """
        import SwiftUI
        import ClerkKitUI
        import ClerkKit // violation
        """,
    ),
    (
        "notification extension keeps identity separate from SDK UI",
        "Push/NotificationExtensionSession.swift",
        """
        import Foundation
        import ClerkKit
        import ClerkKitUI // violation
        import Ably // violation
        """,
    ),
    (
        "domain remains Foundation only",
        "Packages/ChatDomain/Sources/ChatDomain/Projection.swift",
        """
        import Foundation
        import Swift
        import struct Foundation.UUID
        import ChatData // violation
        import FoundationNetworking // violation
        import SQLite3 // violation
        import SwiftUI // violation
        import CCState // violation
        import Ably // violation
        @testable import ClerkKit // violation
        """,
    ),
    (
        "data retains native transport and storage frameworks",
        "Packages/ChatData/Sources/ChatData/Storage.swift",
        """
        import Foundation
        import ChatDomain
        import Synchronization
        import OSLog
        import CryptoKit
        import SQLite3
        import Network
        import ObjectiveC
        #if canImport(FoundationNetworking)
        import FoundationNetworking
        #endif
        import Okou // violation
        import SwiftUI // violation
        import UIKit // violation
        import AppKit // violation
        import WebKit // violation
        import AuthenticationServices // violation
        import CCState // violation
        import CCStateSwiftUI // violation
        import Ably // violation
        import ClerkKit // violation
        import ClerkKitUI // violation
        """,
    ),
    (
        "source folders named Tests do not relax package boundaries",
        "Packages/ChatDomain/Sources/ChatDomain/Tests/Fixture.swift",
        """
        import Foundation
        import UIKit // violation
        @testable import ChatData // violation
        """,
    ),
    (
        "data test-support transport does not acquire SDK ownership",
        "Packages/ChatData/Sources/ChatDataTestSupport/Fixture.swift",
        """
        import Foundation
        import Network
        import ObjectiveC
        import UIKit // violation
        import ClerkKit // violation
        """,
    ),
    (
        "package test targets can import their real entry and test framework",
        "Packages/ChatDomain/Tests/ChatDomainTests/ProjectionTests.swift",
        """
        import Foundation
        import XCTest
        import Testing
        @testable import ChatDomain
        """,
    ),
    (
        "provider authentication fixture retains the real SDK",
        "OkouTests/AuthenticationHTTPFixture.swift",
        """
        import Foundation
        import XCTest
        @testable import ClerkKit
        import Ably // violation
        """,
    ),
    (
        "provider realtime tests retain the real SDK",
        "OkouTests/RealtimeResourceRecoveryTests.swift",
        """
        import XCTest
        import Ably
        import ClerkKit // violation
        """,
    ),
    (
        "test names do not create arbitrary SDK definition sites",
        "OkouTests/OtherTests.swift",
        """
        import XCTest
        @testable import Okou
        import ClerkKit // violation
        import Ably // violation
        """,
    ),
    (
        "similar owner names do not acquire the SDK",
        "Okou/Features/Services/AuthenticationService.swift",
        """
        import Foundation
        import ClerkKit // violation
        """,
    ),
    (
        "similar package names retain their own dependencies",
        "Packages/ChatDomainExamples/Sources/Example.swift",
        """
        import Foundation
        import ChatData
        import SwiftUI
        import ClerkKit // violation
        """,
    ),
    (
        "package manifests keep their build API",
        "Packages/ChatDomain/Package.swift",
        """
        import PackageDescription
        """,
    ),
    (
        "ordinary features keep native UI and graph APIs",
        "Okou/Features/ChatList/Feature.swift",
        """
        import Foundation
        import SwiftUI
        import UIKit
        import CCState
        import CCStateSwiftUI
        import ChatDomain
        import ChatData
        import AblyMocks
        import ClerkKitMocks
        """,
    ),
]

# Other existing identity entry points have distinct production responsibilities.
IMPORT_CASES += [
    ("identity owner " + path, path, "import ClerkKit\n")
    for path in [
        "Okou/Features/SignIn/NativeAuthFlow.swift",
        "Okou/Features/SignIn/AuthProviderMark.swift",
        "Okou/Features/SignIn/SignInView.swift",
        "Push/PushConfiguration.swift",
        "OkouTests/AuthenticationScopeTests.swift",
        "OkouTests/NativeAuthFlowTests.swift",
    ]
]
