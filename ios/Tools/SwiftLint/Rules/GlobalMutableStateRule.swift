import Foundation
import SwiftLintCore
import SwiftSyntax

struct GlobalMutableStateRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_global_mutable_state", name: "Scoped native mutable state",
    description: "Keep stored mutable state in an explicit owner, not file or type storage",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    // Production owners only; test fixtures and the lint tool retain their own scope.
    guard let path = file.path?.path else { return [] }
    // A checkout directory named Okou must not turn tests or tooling into App sources.
    var source = "/" + path
    if let root = path.range(of: "/ios/", options: .backwards) {
      source = "/" + path[root.upperBound...]
    }
    guard
      [
        "/Okou/", "/Push/", "/Packages/ChatDomain/Sources/ChatDomain/",
        "/Packages/ChatData/Sources/ChatData/",
      ].contains(where: { source.contains($0) })
    else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: VariableDeclSyntax) -> SyntaxVisitorContinueKind {
      guard node.bindingSpecifier.text == "var", globalStorage(node) else {
        return .visitChildren
      }
      for binding in node.bindings where stored(binding) {
        positions.append(binding.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    private func globalStorage(_ node: VariableDeclSyntax) -> Bool {
      for parent in ancestors(of: node) {
        if parent.is(MemberBlockSyntax.self) {
          return node.modifiers.contains { ["static", "class"].contains($0.name.text) }
        }
        if parent.is(CodeBlockSyntax.self) || parent.is(ClosureExprSyntax.self) {
          return false
        }
        if parent.is(SourceFileSyntax.self) { return true }
      }
      return false
    }

    private func stored(_ binding: PatternBindingSyntax) -> Bool {
      guard let accessors = binding.accessorBlock else { return true }
      switch accessors.accessors {
      case .getter: return false
      case .accessors(let declarations):
        return declarations.contains {
          ["didSet", "willSet"].contains($0.accessorSpecifier.text)
        }
      }
    }
  }
}
