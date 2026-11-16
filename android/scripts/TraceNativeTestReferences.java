import com.android.tools.r8.Diagnostic;
import com.android.tools.r8.DiagnosticsHandler;
import com.android.tools.r8.DiagnosticsLevel;
import com.android.tools.r8.diagnostic.MissingDefinitionInfo;
import com.android.tools.r8.diagnostic.MissingDefinitionsDiagnostic;
import com.android.tools.r8.origin.Origin;
import com.android.tools.r8.tracereferences.TraceReferences;
import com.android.tools.r8.tracereferences.TraceReferencesCommand;

/** R8 tracing with warnings only for known SDK-stub/desugaring gaps. */
class TraceNativeTestReferences {
  private static boolean sdkStubGap(MissingDefinitionInfo missing) {
    if (missing.isMissingClass()) {
      String name = missing.asMissingClass().getClassReference().getBinaryName();
      return name.startsWith("android/") || name.equals("java/lang/invoke/StringConcatFactory");
    }
    if (!missing.isMissingMethod()) return false;
    var method = missing.asMissingMethod().getMethodReference();
    String owner = method.getHolderClass().getBinaryName();
    String name = method.getMethodName();
    // Public SDK stubs omit these legacy/hidden inherited platform methods.
    return owner.startsWith("android/")
        || owner.equals("java/lang/invoke/StringConcatFactory")
        || (owner.equals("androidx/test/internal/runner/hidden/ExposedInstrumentationApi")
            && name.equals("execStartActivity"))
        || (owner.equals("androidx/test/uiautomator/UiAutomatorInstrumentationTestRunner")
            && name.equals("getArguments"))
        || (owner.equals("androidx/test/uiautomator/UiAutomatorTestCase")
            && name.equals("getInstrumentation"));
  }

  public static void main(String[] args) throws Exception {
    var diagnostics = new DiagnosticsHandler() {
      @Override
      public DiagnosticsLevel modifyDiagnosticsLevel(DiagnosticsLevel level, Diagnostic diagnostic) {
        if (level == DiagnosticsLevel.ERROR
            && diagnostic instanceof MissingDefinitionsDiagnostic missing
            && missing.getMissingDefinitions().stream().allMatch(TraceNativeTestReferences::sdkStubGap)) {
          return DiagnosticsLevel.WARNING;
        }
        return level;
      }
    };
    TraceReferences.run(TraceReferencesCommand.parse(args, Origin.unknown(), diagnostics).build());
  }
}
