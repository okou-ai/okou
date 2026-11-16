"""Production console diagnostics and native output owners through the real CLI."""

LOGGING_CASES = [
    (
        "production diagnostics use the system logger",
        "ios/Okou/Features/Diagnostics.swift",
        """
        import Foundation
        import OSLog
        func observe() {
          print("workspace changed") // violation
          debugPrint(value) // violation
          dump(value) // violation
          NSLog("Request failed: %@", error) // violation
          os_log("Request failed") // violation
          let log = Logger(subsystem: "ai.okou.ios", category: "ChatSync")
          log.debug("event=chat.sync.started")
          log.info("event=chat.sync.completed")
          log.warning("event=chat.sync.retrying")
          log.error("event=chat.sync.failed error_code=42")
          log.fault("event=chat.sync.invariant.failed")
        }
    """,
    ),
    (
        "qualified primitives and direct references cannot hide console output",
        "ios/Okou/Services/Diagnostics.swift",
        """
        import Foundation
        import OSLog
        func observe() {
          Swift.print("changed") // violation
          Swift.debugPrint(value) // violation
          Swift.dump(value) // violation
          Foundation.NSLog("failed") // violation
          os.os_log("failed") // violation
          OSLog.os_log("failed") // violation
          let output = print // violation
          let debug = Swift.debugPrint // violation
          consume(dump) // violation
          let legacy = Foundation.NSLog // violation
        }
    """,
    ),
    (
        "preview macros keep diagnostics without exempting their source file",
        "ios/Okou/Features/Screen.swift",
        '''
        import SwiftUI
        func load() { print("production") } // violation
        #Preview("Screen") {
          let snapshot = dump(value)
          Button("Inspect") { Swift.print(snapshot) }
        }
        #OtherMacro { print("production") } // violation
        let example = "print(value)"
        let markdown = """
          ```swift
          print("documented example")
          ```
          """
        // print("commented example")
        func refresh() { debugPrint("production") } // violation
    ''',
    ),
    (
        "explicit text streams and business printers keep their output owner",
        "ios/Okou/Features/Export.swift",
        """
        func export(_ document: Document, into stream: inout String) {
          print(document, to: &stream)
          Swift.print(document, separator: ",", terminator: "", to: &stream)
          debugPrint(document, to: &stream)
          Swift.dump(document, to: &stream)
          let render = Swift.print(_:separator:terminator:to:)
          printer.print(document)
          printer.debugPrint(document)
          printer.dump(document)
          print(document: document)
          print(document, separator: ",", terminator: "") // violation
        }
        struct Printer {
          func print(_ job: Job) {}
          func render(_ job: Job) { print(job) }
        }
    """,
    ),
    (
        "lexical bindings do not become standard library diagnostics",
        "ios/Okou/Features/Printing.swift",
        """
        func execute(print: (Job) -> Void, Swift: Printer, Foundation: Printer) {
          print(job)
          Swift.print(job)
          Foundation.NSLog(job)
        }
        func prepare() {
          func debugPrint(_ job: Job) {}
          debugPrint(job)
          let NSLog = printer.render
          NSLog(job)
          let callback = { [dump = printer.render] in dump(job) }
          let other = { (print: (Job) -> Void) in print(job) }
          for print in jobs { print(job) }
          if let dump = renderer { dump(job) }
          guard let print = renderer else { return }
          print(job)
        }
        func other() { print("still production") } // violation
    """,
    ),
    (
        "file declarations remain visible before their textual definition",
        "ios/Okou/Features/Printing.swift",
        """
        func execute() {
          Swift.print(job)
          debugPrint(job)
          print("standard console") // violation
        }
        let Swift = printer
        let debugPrint = printer.render
    """,
    ),
    (
        "diagnostic build flags and test-like filenames retain production scope",
        "ios/Okou/Features/DiagnosticsTests.swift",
        """
        import XCTest
        #if DEBUG
        func debugState() { print(value) } // violation
        #endif
        struct PreviewFixture {
          func inspect() { Swift.dump(value) } // violation
        }
    """,
    ),
]

for filename in [
    "ios/Push/NotificationService.swift",
    "ios/Widgets/StatusWidget.swift",
    "ios/Packages/ChatDomain/Sources/ChatDomain/Projection.swift",
    "ios/Packages/ChatData/Sources/ChatData/APIClient.swift",
]:
    LOGGING_CASES.append(
        (
            "owned production target: " + filename,
            filename,
            'func inspect() { print("value") } // violation\n',
        )
    )

for filename in [
    "ios/OkouTests/Fixture.swift",
    "ios/Packages/ChatDomain/Tests/ChatDomainTests/Fixture.swift",
    "ios/Packages/ChatData/Tests/ChatDataTests/Fixture.swift",
    "ios/Packages/ChatData/Sources/ChatDataTestSupport/Fixture.swift",
    "ios/Tools/SwiftLint/Rules/Fixture.swift",
    "ios/scripts/Inspect.swift",
    "Okou/ios/OkouTests/Fixture.swift",
    "Widgets/ios/Tools/Fixture.swift",
]:
    LOGGING_CASES.append(
        (
            "external diagnostic owner: " + filename,
            filename,
            'func inspect() { print("value"); dump(value) }\n',
        )
    )

LOGGING_CASES.append(
    (
        "checkout names cannot hide a production target",
        "Okou/ios/Push/NotificationService.swift",
        'func inspect() { print("value") } // violation\n',
    )
)
