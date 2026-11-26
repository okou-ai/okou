import SwiftLintCore
import SwiftSyntax

/// Observation keeps native interaction state. Business state lives in graph State, which views
/// resolve through CCStateSwiftUI and actions read through their owner's synchronous accessors.
struct ObservableGraphRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_observable_graph", name: "Graph state outside Observation",
    description:
      "Keep CCState signals and Stores out of the stored properties of @Observable classes",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    guard hasCCState(file) else { return [] }
    let visitor = Visitor(viewMode: .sourceAccurate)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    var positions: [AbsolutePosition] = []

    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind {
      guard isObservable(node.attributes) else { return .visitChildren }
      for member in node.memberBlock.members {
        guard let variable = member.decl.as(VariableDeclSyntax.self) else { continue }
        // Computed properties may return an existing signal for views to resolve.
        for binding in variable.bindings where binding.accessorBlock == nil {
          let typed =
            binding.typeAnnotation.map { containsGraphType($0.type, names: graphConstructors) }
            ?? false
          let constructed =
            binding.initializer?.value.as(FunctionCallExprSyntax.self)
            .map { isGraphCall($0, names: graphConstructors) } ?? false
          if typed || constructed {
            positions.append(binding.positionAfterSkippingLeadingTrivia)
          }
        }
      }
      return .visitChildren
    }
  }
}

private func isObservable(_ attributes: AttributeListSyntax) -> Bool {
  attributes.contains {
    ["@Observable", "@Observation.Observable"].contains($0.trimmedDescription)
  }
}
