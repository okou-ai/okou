import ChatDomain
import Foundation

enum ChatConnectorInputError: LocalizedError {
  case noDefaultAccount
  case settingsChanged

  var errorDescription: String? {
    switch self {
    case .noDefaultAccount:
      "This connector has saved accounts but no default. Choose an account in Connectors settings."
    case .settingsChanged:
      "The connection settings changed. Reopen the form and review the required fields."
    }
  }
}

extension ChatConnectorMethod {
  func manualValues(_ values: [String: String]) -> [String: String] {
    var result: [String: String] = [:]
    for field in manualFields {
      result[field.id] = values[field.id]?.components(separatedBy: .ecmaScriptWhitespace).joined()
    }
    return result
  }

  func deviceOptions(_ values: [String: String]) -> [String: String]? {
    var result: [String: String] = [:]
    for option in startOptions { result[option.id] = values[option.id] ?? option.defaultValue }
    return result.isEmpty ? nil : result
  }

  public func hasRequiredInputs(values: [String: String], options: [String: String]) -> Bool {
    let manual = manualValues(values)
    let selected = deviceOptions(options)
    return manualFields.allSatisfy { !$0.required || manual[$0.id]?.isEmpty == false }
      && startOptions.allSatisfy { !$0.required || selected?[$0.id]?.isEmpty == false }
  }
}

extension ChatCustomConnector {
  struct Value: Encodable {
    let key: String
    let kind: String
    let value: String
  }

  func submittedValues(_ values: [String: String]) -> [Value] {
    fields.compactMap { field in
      guard let input = values[field.key] else { return nil }
      let value =
        field.kind == "variable"
        ? input.trimmingCharacters(in: .ecmaScriptWhitespace)
        : input.components(separatedBy: .ecmaScriptWhitespace).joined()
      guard !value.isEmpty else { return nil }
      return Value(key: field.key, kind: field.kind, value: value)
    }
  }

  public func canSubmit(values: [String: String], account: ChatConnectorAccount?) -> Bool {
    if usesBrowserAuthorization { return true }
    let submitted = Set(submittedValues(values).map(\.key))
    let required = account?.missingRequiredFields ?? fields.filter(\.required).map(\.key)
    return (authMode == "none" || !submitted.isEmpty) && submitted.isSuperset(of: required)
  }
}
