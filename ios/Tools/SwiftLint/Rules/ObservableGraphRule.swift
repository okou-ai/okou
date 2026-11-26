import SwiftLintCore
import SwiftSyntax

/// Observation keeps native interaction state. Business state lives in graph State, which views
/// resolve through CCStateSwiftUI and actions read through their owner's synchronous accessors.
struct ObservableGraphRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_observable_graph", name: "Graph state outside Observation",
    description:
      "Keep CCState signals and Stores out of the stored properties of Observation owners",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let declarations = FileDeclarations(viewMode: .sourceAccurate)
    declarations.walk(file.syntaxTree)
    // Bare names count only where CCState is imported and the file does not declare its own
    // type of that name; `CCState.`-qualified names always count.
    let bareNames =
      declarations.importsCCState ? graphConstructors.subtracting(declarations.types) : []
    let visitor = Visitor(bareNames: bareNames)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    let bareNames: Set<String>
    var positions: [AbsolutePosition] = []

    init(bareNames: Set<String>) {
      self.bareNames = bareNames
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind {
      guard isObservationOwner(node) else { return .visitChildren }
      check(node.memberBlock.members)
      return .visitChildren
    }

    private func check(_ members: MemberBlockItemListSyntax) {
      for member in members {
        if let conditional = member.decl.as(IfConfigDeclSyntax.self) {
          for clause in conditional.clauses {
            if case .decls(let nested)? = clause.elements { check(nested) }
          }
        } else if let variable = member.decl.as(VariableDeclSyntax.self) {
          check(variable.bindings)
        }
      }
    }

    private func check(_ bindings: PatternBindingListSyntax) {
      let list = Array(bindings)
      for (index, binding) in list.enumerated() where binding.accessorBlock == nil {
        // `let a, b: T` attaches the annotation to the last binding only.
        let annotation =
          binding.typeAnnotation
          ?? (binding.initializer == nil
            ? list[(index + 1)...].first { $0.typeAnnotation != nil }?.typeAnnotation : nil)
        let typed = annotation.map { holdsGraph($0.type) } ?? false
        let constructed = binding.initializer.map { constructsGraph($0.value) } ?? false
        if typed || constructed { positions.append(binding.positionAfterSkippingLeadingTrivia) }
      }
    }

    private func holdsGraph(_ type: TypeSyntax) -> Bool {
      containsGraphType(type, names: bareNames)
        || containsQualifiedGraphType(type, names: graphConstructors)
    }

    private func constructsGraph(_ expression: ExprSyntax) -> Bool {
      var value = expression
      while true {
        if let attempt = value.as(TryExprSyntax.self) {
          value = attempt.expression
        } else if let wait = value.as(AwaitExprSyntax.self) {
          value = wait.expression
        } else {
          break
        }
      }
      guard let call = value.as(FunctionCallExprSyntax.self),
        isGraphCall(call, names: graphConstructors)
      else { return false }
      var callee = call.calledExpression
      if let generic = callee.as(GenericSpecializationExprSyntax.self) {
        callee = generic.expression
      }
      return callee.is(MemberAccessExprSyntax.self) || bareNames.contains(callName(callee))
    }
  }
}

/// An `@Observable` class or an `ObservableObject`.
private func isObservationOwner(_ node: ClassDeclSyntax) -> Bool {
  let macro = node.attributes.contains {
    ["@Observable", "@Observation.Observable"].contains($0.trimmedDescription)
  }
  let object =
    node.inheritanceClause?.inheritedTypes.contains {
      ["ObservableObject", "Combine.ObservableObject"].contains($0.type.trimmedDescription)
    } ?? false
  return macro || object
}

private func containsQualifiedGraphType(_ type: TypeSyntax, names: Set<String>) -> Bool {
  let visitor = QualifiedGraphTypes(names: names)
  visitor.walk(type)
  return visitor.found
}

private final class QualifiedGraphTypes: SyntaxVisitor {
  let names: Set<String>
  var found = false

  init(names: Set<String>) {
    self.names = names
    super.init(viewMode: .sourceAccurate)
  }

  override func visit(_ node: MemberTypeSyntax) -> SyntaxVisitorContinueKind {
    if node.baseType.trimmedDescription == "CCState", names.contains(node.name.text) {
      found = true
    }
    return .visitChildren
  }
}

/// Whether the file imports CCState anywhere, including inside `#if`, and the type names it
/// declares, which a bare name then refers to instead.
private final class FileDeclarations: SyntaxVisitor {
  var importsCCState = false
  var types: Set<String> = []

  override func visit(_ node: ImportDeclSyntax) -> SyntaxVisitorContinueKind {
    if node.path.first?.name.text == "CCState" { importsCCState = true }
    return .skipChildren
  }

  override func visit(_ node: StructDeclSyntax) -> SyntaxVisitorContinueKind {
    types.insert(node.name.text)
    return .visitChildren
  }

  override func visit(_ node: ClassDeclSyntax) -> SyntaxVisitorContinueKind {
    types.insert(node.name.text)
    return .visitChildren
  }

  override func visit(_ node: EnumDeclSyntax) -> SyntaxVisitorContinueKind {
    types.insert(node.name.text)
    return .visitChildren
  }

  override func visit(_ node: ActorDeclSyntax) -> SyntaxVisitorContinueKind {
    types.insert(node.name.text)
    return .visitChildren
  }

  override func visit(_ node: TypeAliasDeclSyntax) -> SyntaxVisitorContinueKind {
    types.insert(node.name.text)
    return .visitChildren
  }
}
