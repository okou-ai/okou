package ai.okou.android.chat

import ai.okou.android.api.generated.ComposerWorkflowsItem
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ComposerWorkflowMatchingTest {
    @Test
    fun acceptedCommandsUseTheSameUnicodeWhitespaceAsTheEditor() {
        assertEquals(
            setOf("release-check", "review-changes"),
            sentWorkflowNames("run\u00a0/release-check\n/review-changes\t/release-check /"),
        )
        assertEquals(emptySet<String>(), sentWorkflowNames("https://example.com/ordinary"))
    }

    @Test
    fun onlyAnEditableSlashTokenOffersCompletion() {
        assertEquals(
            WorkflowToken(TextRange(5, 8), "发"),
            TextFieldValue("请执行  /发布 后续", TextRange(7)).activeWorkflowToken(),
        )
        for (text in
            listOf("https://", "/a/sub", "docs/path", "请执行/发布", "／发布", "/foo.md", "/foo\n")) {
            assertNull(TextFieldValue(text, TextRange(text.length)).activeWorkflowToken())
        }
        assertNull(TextFieldValue("/draft", TextRange(1, 4)).activeWorkflowToken())
        assertNull(TextFieldValue("/draft", TextRange(6), TextRange(1, 6)).activeWorkflowToken())
        assertNull(TextFieldValue("/usr/bin", TextRange(2)).activeWorkflowToken())
    }

    @Test
    fun insertsTheWholeCommandAndKeepsTheTailAndWhitespace() {
        val draft = TextFieldValue("run /drftp now", TextRange(7))
        val replacement = draft.insertWorkflow("draft", draft.activeWorkflowToken())
        assertEquals("run /draft now", replacement.text)
        assertEquals(TextRange(11), replacement.selection)
        val newline = TextFieldValue("/dr\nnext", TextRange(3))
        assertEquals(
            TextFieldValue("/draft\nnext", TextRange(6)),
            newline.insertWorkflow("draft", newline.activeWorkflowToken()),
        )
        assertEquals(
            TextFieldValue("run /draft ", TextRange(11)),
            TextFieldValue("run ", TextRange(3)).insertWorkflow("draft", null),
        )
    }

    @Test
    fun groupsRecentsAndRanksExactPrefixSubstringAndFuzzyMatches() {
        val items =
            listOf(
                item("release"),
                item("release-check"),
                item("pre-release"),
                item("r-e-l-e-a-s-e"),
                item("v1-x23"),
                item("v123"),
                item("other", "Release documentation"),
            )
        val snapshot =
            ComposerWorkflowSnapshot(
                items,
                listOf("gone", "v1-x23", "pre-release", "other", "release"),
            )
        val unfiltered = snapshot.candidates("")
        assertEquals(
            listOf("v1-x23", "pre-release", "other"),
            unfiltered.recent.map { it.workflow.id },
        )
        assertEquals(
            listOf("r-e-l-e-a-s-e", "release", "release-check", "v123"),
            unfiltered.all.map { it.workflow.id },
        )
        assertEquals(
            listOf("release", "release-check", "pre-release", "other", "r-e-l-e-a-s-e"),
            snapshot.candidates("RELEASE").rows.map { it.workflow.id },
        )
        assertEquals(listOf("v123"), snapshot.candidates("123").rows.map { it.workflow.id })
        assertEquals(
            listOf(0..0, 2..2, 4..4),
            snapshot.candidates("rel").rows.first { it.workflow.name == "r-e-l-e-a-s-e" }.ranges,
        )
    }

    private fun item(name: String, description: String? = null) =
        ComposerWorkflowsItem(id = name, name = name, displayName = null, description = description)
}
