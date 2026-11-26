package ai.okou.android

import androidx.compose.ui.text.TextRange
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RenameFormTest {
    @Test
    fun aReadOnlyRefreshUpdatesTheBaselineWithoutReplacingInput() {
        val draft = RenameDraft("Original")
        assertFalse(draft.receive("Remote", readOnly = true))
        assertEquals("Original", draft.input.text.toString())
        assertTrue(draft.form("Remote", true, null).canSave)

        draft.receive("Original")
        assertFalse(draft.form("Original", true, null).canSave)
        assertTrue(draft.receive("Newest"))
        assertEquals("Newest", draft.input.text.toString())
    }

    @Test
    fun comparesTheNormalizedInputAgainstTheLatestConfirmedName() {
        assertTrue(renameForm("  Original  ", "Remote", true, null).canSave)
        assertFalse(renameForm("  Remote  ", "Remote", true, null).canSave)

        val input = "  New  name  "
        val form = renameForm(input, "Remote", true, null)
        assertEquals("New  name", form.name)
        assertTrue(form.canSave)
        assertFalse(renameForm(input, "Remote", false, null).canSave)
    }

    @Test
    fun confirmedReadsFillPristineNamesAndCompareEditsWithoutChangingTheirSelection() {
        val draft = RenameDraft("Original")
        assertFalse(draft.form("Remote", true, null).canSave)
        draft.receive("Remote")
        assertEquals("Remote", draft.input.text.toString())

        draft.input.edit {
            replace(0, length, "  Original  ")
            selection = TextRange(3, 7)
        }
        draft.receive("Different")
        assertEquals("  Original  ", draft.input.text.toString())
        assertEquals(TextRange(3, 7), draft.input.selection)
        assertTrue(draft.form("Different", true, null).canSave)

        draft.receive("Original")
        assertEquals(TextRange(3, 7), draft.input.selection)
        assertFalse(draft.form("Original", true, null).canSave)
        draft.receive("Newest")
        assertEquals("Newest", draft.input.text.toString())
    }

    @Test
    fun validatesTheNormalizedValueAgainstTheResourceLimit() {
        val blank = renameForm("  ", "Original", true, 10)
        assertEquals(RenameFieldError.Required, blank.error)
        assertFalse(blank.canSave)

        val tooLong = renameForm(" 123456 ", "Old", true, 5)
        assertEquals(RenameFieldError.TooLong, tooLong.error)
        assertFalse(tooLong.canSave)
        assertTrue(renameForm(" 12345 ", "Old", true, 5).canSave)
        assertTrue(renameForm(" 123456 ", "Old", true, null).canSave)
    }
}
