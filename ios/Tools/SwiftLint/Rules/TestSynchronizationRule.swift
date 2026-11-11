import Foundation
import SwiftLintCore
import SwiftSyntax

struct TestSynchronizationRule: NativeRule {
  var configuration = SeverityConfiguration<Self>(.error)
  static let description = RuleDescription(
    identifier: "okou_test_synchronization", name: "Observable test synchronization",
    description:
      "Await observable completion instead of fixed sleeps or fixed-count yield loops in tests",
    kind: .lint)

  func validate(file: SwiftLintFile) -> [StyleViolation] {
    let testFile =
      file.path?.pathComponents.contains {
        $0 == "Tests" || $0.hasSuffix("Tests")
      } ?? false
    let visitor = Visitor(testFile: testFile)
    visitor.walk(file.syntaxTree)
    return findings(visitor.positions, in: file)
  }

  private final class Visitor: SyntaxVisitor {
    let testFile: Bool
    var positions: [AbsolutePosition] = []
    init(testFile: Bool) {
      self.testFile = testFile
      super.init(viewMode: .sourceAccurate)
    }

    override func visit(_ node: FunctionCallExprSyntax) -> SyntaxVisitorContinueKind {
      guard inTest(node) else { return .visitChildren }
      let name = callName(node.calledExpression)
      let receiver =
        node.calledExpression.as(MemberAccessExprSyntax.self)?.base?.trimmedDescription ?? ""
      let task =
        ["Task", "Swift.Task", "_Concurrency.Task"].contains(receiver)
        || ["Task<", "Swift.Task<", "_Concurrency.Task<"].contains { receiver.hasPrefix($0) }
      let thread = ["Thread", "Foundation.Thread"].contains(receiver)
      let posix = ["", "Darwin", "Glibc"].contains(receiver)
      let sleep = name == "sleep" && (task || thread || posix) || name == "usleep" && posix
      let fixedDuration = node.arguments.contains { argument in
        let label = argument.label?.text
        let duration =
          task && ["for", "nanoseconds"].contains(label ?? "")
          || thread && label == "forTimeInterval"
          || posix && label == nil
        return duration && isConstant(argument.expression)
      }
      if sleep && fixedDuration {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      } else if task && name == "yield" && inFixedYieldLoop(node) {
        positions.append(node.positionAfterSkippingLeadingTrivia)
      }
      return .visitChildren
    }

    private func inFixedYieldLoop(_ node: FunctionCallExprSyntax) -> Bool {
      for parent in ancestors(of: node) {
        if parent.is(ClosureExprSyntax.self) || parent.is(FunctionDeclSyntax.self) { return false }
        guard let loop = parent.as(ForStmtSyntax.self),
          let sequence = unwrapped(loop.sequence).as(SequenceExprSyntax.self),
          sequence.elements.count == 3,
          let first = sequence.elements.first, let last = sequence.elements.last,
          let operation = sequence.elements.dropFirst().first?.as(BinaryOperatorExprSyntax.self)
        else { continue }
        if ["...", "..<"].contains(operation.operator.text)
          && isConstant(first) && isConstant(last)
        {
          return true
        }
      }
      return false
    }

    private func inTest(_ node: some SyntaxProtocol) -> Bool {
      testFile
        || ancestors(of: node).contains {
          if let function = $0.as(FunctionDeclSyntax.self) {
            return function.attributes.contains { attribute in
              attribute.as(AttributeSyntax.self).map {
                ["Test", "Testing.Test"].contains($0.attributeName.trimmedDescription)
              } == true
            }
          }
          return $0.as(ClassDeclSyntax.self)?.inheritanceClause?.inheritedTypes.contains {
            ["XCTestCase", "XCTest.XCTestCase"].contains($0.type.trimmedDescription)
          } == true
        }
    }

    private func isConstant(_ value: ExprSyntax, seen: Set<String> = []) -> Bool {
      let expression = unwrapped(value)
      if expression.id != value.id { return isConstant(expression, seen: seen) }
      if value.is(IntegerLiteralExprSyntax.self) || value.is(FloatLiteralExprSyntax.self) {
        return true
      }
      if let prefix = value.as(PrefixOperatorExprSyntax.self) {
        return ["+", "-"].contains(prefix.operator.text)
          && isConstant(prefix.expression, seen: seen)
      }
      if let member = value.as(MemberAccessExprSyntax.self) {
        return member.declName.baseName.text == "zero"
          && ["", "Duration", "Swift.Duration"].contains(member.base?.trimmedDescription ?? "")
      }
      if let sequence = value.as(SequenceExprSyntax.self) {
        return sequence.elements.allSatisfy {
          if let operation = $0.as(BinaryOperatorExprSyntax.self) {
            return ["+", "-", "*", "/"].contains(operation.operator.text)
          }
          return isConstant($0, seen: seen)
        }
      }
      if let call = value.as(FunctionCallExprSyntax.self) {
        let units = ["seconds", "milliseconds", "microseconds", "nanoseconds"]
        let numbers = [
          "Int", "UInt", "Int32", "UInt32", "Int64", "UInt64", "Double", "TimeInterval",
        ]
        let name = callName(call.calledExpression)
        let receiver =
          call.calledExpression.as(MemberAccessExprSyntax.self)?.base?.trimmedDescription ?? ""
        let known =
          units.contains(name) && call.calledExpression.is(MemberAccessExprSyntax.self)
          && ["", "Duration", "Swift.Duration"].contains(receiver)
          || numbers.contains(name) && ["", "Swift", "Foundation"].contains(receiver)
        return known && !call.arguments.isEmpty
          && call.arguments.allSatisfy { isConstant($0.expression, seen: seen) }
      }
      guard let name = value.as(DeclReferenceExprSyntax.self)?.baseName.text, !seen.contains(name)
      else { return false }
      for parent in ancestors(of: value) {
        if let block = parent.as(CodeBlockItemListSyntax.self) {
          for item in block.reversed() where item.position < value.position {
            guard let declaration = item.item.as(VariableDeclSyntax.self) else { continue }
            for binding in declaration.bindings
            where binding.pattern.as(IdentifierPatternSyntax.self)?.identifier.text == name {
              guard declaration.bindingSpecifier.text == "let",
                let initial = binding.initializer?.value
              else { return false }
              return isConstant(initial, seen: seen.union([name]))
            }
          }
        }
        if let closure = parent.as(ClosureExprSyntax.self),
          closureParameters(closure).contains(name)
        {
          return false
        }
        if let function = parent.as(FunctionDeclSyntax.self),
          function.signature.parameterClause.parameters.contains(where: {
            ($0.secondName ?? $0.firstName).text == name
          })
        {
          return false
        }
      }
      return false
    }

    private func unwrapped(_ value: ExprSyntax) -> ExprSyntax {
      if let tuple = value.as(TupleExprSyntax.self), tuple.elements.count == 1,
        let element = tuple.elements.first, element.label == nil
      {
        return unwrapped(element.expression)
      }
      return value
    }
  }
}
