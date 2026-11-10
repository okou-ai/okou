import SwiftLintCore
import SwiftSyntax

struct StableGraphRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_stable_graph", name: "Stable native graph",
    description:
      "Construct graph definitions at their owner, not during a graph callback or UI action",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    guard hasCCState(file) else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
      guard isGraphCall(node, names: graphConstructors) else { return .visitChildren }
      for parent in ancestors(of: node) {
        if parent.is(InitializerDeclSyntax.self) { break }
        if let function = parent.as(FunctionDeclSyntax.self) {
          let result = function.signature.returnClause?.type.trimmedDescription
          let graphResult =
            result.map { result in
              graphConstructors.union(["Signal"]).contains {
                result.hasPrefix($0 + "<") || result == $0 || result.hasPrefix("CCState." + $0)
              }
            } ?? false
          let ownerFactory =
            result != nil && !["Void", "()"].contains(result)
            && ["make", "create"].contains { function.name.text.hasPrefix($0) }
          let factory = graphResult || ownerFactory
          let testAttribute = function.attributes.contains {
            $0.trimmedDescription.hasPrefix("@Test")
          }
          let testOwner = ancestors(of: function).contains {
            $0.as(ClassDeclSyntax.self)?.inheritanceClause?.inheritedTypes.contains {
              $0.type.trimmedDescription == "XCTestCase"
            } == true
          }
          // A test invocation is itself a fresh owner, as is a returning
          // factory. Ordinary owner methods must reuse their graph definitions.
          if !factory && !testAttribute && !testOwner {
            positions.append(node.positionAfterSkippingLeadingTrivia)
          }
          break
        }
        if let closure = parent.as(ClosureExprSyntax.self) {
          let graphCallback =
            closureCall(closure).map { isGraphCall($0.0, names: graphCallbacks) } ?? false
          if graphCallback || isDeferred(closure) {
            positions.append(node.positionAfterSkippingLeadingTrivia)
            break
          }
        }
      }
      return .visitChildren
    }
  }
}
