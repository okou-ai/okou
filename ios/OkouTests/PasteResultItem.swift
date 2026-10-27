import UIKit
import XCTest

/// Forward the actual native paste through its production delegate and observe resolution.
@MainActor
final class PasteResultObserver: NSObject, UITextPasteDelegate {
  private let delegate: any UITextPasteDelegate
  private let completed: XCTestExpectation

  init(delegate: any UITextPasteDelegate, completed: XCTestExpectation) {
    self.delegate = delegate
    self.completed = completed
    super.init()
  }

  func textPasteConfigurationSupporting(
    _ textPasteConfigurationSupporting: any UITextPasteConfigurationSupporting,
    transform item: any UITextPasteItem
  ) {
    delegate.textPasteConfigurationSupporting?(
      textPasteConfigurationSupporting,
      transform: PasteResultItem(item: item, completed: completed))
  }
}

@MainActor
final class PasteResultItem: NSObject, UITextPasteItem {
  let itemProvider: NSItemProvider
  var localObject: Any?
  var defaultAttributes: [NSAttributedString.Key: Any]
  private let item: any UITextPasteItem
  private let completed: XCTestExpectation

  init(item: any UITextPasteItem, completed: XCTestExpectation) {
    self.item = item
    itemProvider = item.itemProvider
    localObject = item.localObject
    defaultAttributes = item.defaultAttributes
    self.completed = completed
    super.init()
  }

  func setResult(string: String) {
    item.setResult(string: string)
    completed.fulfill()
  }
  func setResult(attributedString: NSAttributedString) {
    item.setResult(attributedString: attributedString)
    completed.fulfill()
  }
  func setResult(attachment: NSTextAttachment) {
    item.setResult(attachment: attachment)
    completed.fulfill()
  }
  func setNoResult() {
    item.setNoResult()
    completed.fulfill()
  }
  func setDefaultResult() {
    item.setDefaultResult()
    completed.fulfill()
  }
}
