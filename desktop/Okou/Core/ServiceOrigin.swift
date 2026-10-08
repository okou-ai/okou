import Foundation

public enum ServiceOrigin {
  /// Mirrors the canonical platform-service-origin contract in packages/core.
  public static func api(for origin: URL) -> URL {
    var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)!
    let host = components.host ?? ""
    if host == "okou.ai" || host.hasSuffix(".okou.ai") {
      components.host = "api.okou.ai"
    } else if host.hasSuffix("-app-okou-app-preview.vm0.workers.dev") {
      components.host = host.replacingOccurrences(
        of: "-app-okou-app-preview.vm0.workers.dev", with: "-api.vm6.ai")
    } else {
      var labels = host.split(separator: ".").map(String.init)
      if labels.count >= 3 {
        let index = labels.count - 3
        for service in ["platform", "app", "www", "api"] {
          if labels[index] == service {
            labels[index] = "api"
            break
          }
          if labels[index].hasSuffix("-" + service) {
            labels[index] = String(labels[index].dropLast(service.count)) + "api"
            break
          }
        }
        let rewritten = labels.joined(separator: ".")
        components.host =
          rewritten.hasSuffix(".omby.ai")
          ? String(rewritten.dropLast(".omby.ai".count)) + ".vm6.ai" : rewritten
      }
    }
    components.path = ""
    components.query = nil
    components.fragment = nil
    return components.url!
  }
}
