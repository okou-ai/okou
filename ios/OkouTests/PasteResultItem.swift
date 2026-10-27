import UIKit
import XCTest

/// Observe the result consumed by UIKit through the real production paste delegate.
@MainActor
final class PasteResultItem: NSObject, UITextPasteItem {
  enum Outcome: Equatable { case result, noResult, defaultResult }
  let itemProvider: NSItemProvider
  var localObject: Any?
  var defaultAttributes: [NSAttributedString.Key: Any] = [:]
  private let completed: XCTestExpectation
  private(set) var outcome: Outcome?

  init(provider: NSItemProvider, completed: XCTestExpectation) {
    itemProvider = provider
    self.completed = completed
    super.init()
  }

  func setResult(string: String) { finish(.result) }
  func setResult(attributedString: NSAttributedString) { finish(.result) }
  func setResult(attachment: NSTextAttachment) { finish(.result) }
  func setNoResult() { finish(.noResult) }
  func setDefaultResult() { finish(.defaultResult) }

  private func finish(_ outcome: Outcome) {
    self.outcome = outcome
    completed.fulfill()
  }
}
