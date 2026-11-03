import ChatData
import Foundation

/// Transport failures get user-facing copy; business rejections retain their specific reason.
enum ChatRequestFailure {
  static func isTransient(_ error: Error) -> Bool {
    if let api = error as? APIClientError {
      return [429, 500, 502, 503, 504].contains(api.statusCode ?? 0)
    }
    guard let transport = error as? URLError else { return false }
    return [
      URLError.Code.timedOut, .notConnectedToInternet, .networkConnectionLost,
      .cannotFindHost, .cannotConnectToHost, .dnsLookupFailed,
    ].contains(transport.code)
  }

  static func message(for error: Error) -> String {
    if (error as? APIClientError)?.statusCode == 429 {
      return String(localized: "Too many requests. Wait a moment before trying again.")
    }
    if isTransient(error) {
      return String(localized: "Unable to complete this request right now. Try again in a moment.")
    }
    return error.localizedDescription
  }

  static func canRetry(_ error: Error) -> Bool {
    if let api = error as? APIClientError {
      if let status = api.statusCode, [401, 403, 404, 410, 426].contains(status) { return false }
      if case .downloadFailed(let status) = api, [401, 404, 410, 426].contains(status) {
        return false
      }
      switch api {
      case .invalidURL, .incompatibleData: return false
      default: break
      }
    }
    return (error as? URLError)?.code != .dataLengthExceedsMaximum
  }
}
