import Foundation

public enum BrowserAddressNavigationTarget: String, Sendable {
    case chrome = "com.google.Chrome"
    case safari = "com.apple.Safari"
}

public struct BrowserAddressFieldAttributes: Sendable {
    public let role: String?
    public let identifier: String?
    public let description: String?
    public let placeholder: String?
    public let title: String?
    public let valueSettable: Bool

    public init(
        role: String?,
        identifier: String?,
        description: String?,
        placeholder: String?,
        title: String?,
        valueSettable: Bool
    ) {
        self.role = role
        self.identifier = identifier
        self.description = description
        self.placeholder = placeholder
        self.title = title
        self.valueSettable = valueSettable
    }
}

public func browserAddressNavigationTarget(bundleId: String) -> BrowserAddressNavigationTarget? {
    let normalized = bundleId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    switch normalized {
    case BrowserAddressNavigationTarget.chrome.rawValue.lowercased():
        return .chrome
    case BrowserAddressNavigationTarget.safari.rawValue.lowercased():
        return .safari
    default:
        return nil
    }
}

public func isBrowserAddressField(
    bundleId: String,
    attributes: BrowserAddressFieldAttributes
) -> Bool {
    guard let target = browserAddressNavigationTarget(bundleId: bundleId),
          attributes.valueSettable,
          attributes.role == "AXTextField"
    else {
        return false
    }

    if attributes.identifier == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" {
        return true
    }

    let searchableText = [
        attributes.description,
        attributes.placeholder,
        attributes.title,
    ]
        .compactMap { $0?.lowercased() }
        .joined(separator: " ")

    switch target {
    case .chrome:
        return searchableText.contains("address and search bar")
            || searchableText.contains("ask google or type a url")
    case .safari:
        return searchableText.contains("smart search field")
            || searchableText.contains("search or enter website name")
    }
}

public func normalizedBrowserNavigationURL(_ value: String) -> String? {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty,
          trimmed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    else {
        return nil
    }

    if let url = URLComponents(string: trimmed),
       let scheme = url.scheme?.lowercased(),
       ["http", "https"].contains(scheme),
       hasNavigableHost(url.host)
    {
        return trimmed
    }

    guard trimmed.range(of: "://") == nil,
          isBareNavigableHost(trimmed)
    else {
        return nil
    }

    let scheme = shouldDefaultBareHostToHTTP(trimmed) ? "http" : "https"
    return "\(scheme)://\(trimmed)"
}

private func hasNavigableHost(_ host: String?) -> Bool {
    guard let host else {
        return false
    }
    return !host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

private func isBareNavigableHost(_ value: String) -> Bool {
    let host = value.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first
        .map(String.init) ?? value
    let hostWithoutPort = host.split(separator: ":", maxSplits: 1).first.map(String.init) ?? host
    guard !hostWithoutPort.isEmpty else {
        return false
    }
    return hostWithoutPort == "localhost"
        || isIPv4Host(hostWithoutPort)
        || hostWithoutPort.contains(".")
}

private func shouldDefaultBareHostToHTTP(_ value: String) -> Bool {
    let host = value.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first
        .map(String.init) ?? value
    let hostWithoutPort = host.split(separator: ":", maxSplits: 1).first.map(String.init) ?? host
    return hostWithoutPort == "localhost" || isIPv4Host(hostWithoutPort)
}

private func isIPv4Host(_ host: String) -> Bool {
    let parts = host.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else {
        return false
    }
    return parts.allSatisfy { part in
        guard !part.isEmpty, let number = Int(part), (0...255).contains(number) else {
            return false
        }
        return String(number) == part || part == "0"
    }
}
