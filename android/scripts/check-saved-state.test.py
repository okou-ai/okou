#!/usr/bin/env python3
"""Exercise source-policy bypasses and the reviewed boundary with real files."""

import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "saved_state_audit", Path(__file__).with_name("check-saved-state.py")
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class SavedStateAuditTest(unittest.TestCase):
    def scan(self, source, relative="app/src/main/kotlin/ai/okou/android/Screen.kt"):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            file = root / relative
            file.parent.mkdir(parents=True)
            file.write_text(source)
            return audit.violations(root)

    def test_raw_alias_wildcard_and_fully_qualified_apis_need_the_boundary(self):
        for source in (
            "import androidx.compose.runtime.saveable.rememberSaveable",
            "import androidx.compose.runtime.saveable.rememberSaveable as restored",
            "import androidx.compose.runtime.saveable.*",
            "val value = androidx . compose . runtime . saveable . rememberSerializable { data }",
            "import androidx.lifecycle.SavedStateHandle as Handle",
            "import androidx.lifecycle.*",
            "import androidx.savedstate.SavedStateRegistry",
            "import androidx.savedstate.*",
            "import androidx.compose.runtime.`saveable`.`rememberSaveable`",
            "owner.savedStateRegistry.registerSavedStateProvider(\"payload\") { state }",
            "handle.setSavedStateProvider(\"payload\") { state }",
            "val registration = owner.savedStateRegistry::registerSavedStateProvider",
        ):
            with self.subTest(source=source):
                self.assertTrue(self.scan(source))

    def test_only_the_actual_reviewed_file_owns_raw_savers(self):
        source = "import androidx.compose.runtime.saveable.rememberSaveable"
        self.assertEqual([], self.scan(source, str(audit.BOUNDARY)))
        self.assertTrue(self.scan(source, "app/src/main/kotlin/other/SavedUiState.kt"))

    def test_documented_api_names_are_not_code_and_line_numbers_survive(self):
        source = '''/* Nested /* androidx.lifecycle.SavedStateHandle */ comment */
// androidx.compose.runtime.saveable.rememberSaveable
val documentation = "androidx.compose.runtime.saveable.rememberSaveable"
val multiline = """androidx.compose.runtime.saveable.Saver"""
import androidx.compose.runtime.saveable.rememberSaveable
'''
        errors = self.scan(source)
        self.assertEqual(1, len(errors))
        self.assertIn("Screen.kt:5:", errors[0])

    def test_framework_scroll_and_approved_metadata_helpers_remain_available(self):
        self.assertEqual(
            [],
            self.scan(
                "import androidx.compose.foundation.lazy.rememberLazyListState\n"
                "import ai.okou.android.state.rememberJournalEditor\n"
                "import ai.okou.android.state.rememberUiTargetId\n"
            ),
        )


if __name__ == "__main__":
    unittest.main()
