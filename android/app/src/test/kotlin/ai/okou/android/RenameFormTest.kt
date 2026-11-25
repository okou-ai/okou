package ai.okou.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RenameFormTest {
    @Test
    fun comparesTheNormalizedInputAgainstTheOpeningAndLatestConfirmedNames() {
        assertFalse(renameForm("  Original  ", "Original", "Remote", true, null).canSave)
        assertFalse(renameForm("  Remote  ", "Original", "Remote", true, null).canSave)

        val input = "  New  name  "
        val form = renameForm(input, "Original", "Remote", true, null)
        assertEquals("New  name", form.name)
        assertTrue(form.canSave)
        assertFalse(renameForm(input, "Original", "Remote", false, null).canSave)
    }

    @Test
    fun validatesTheNormalizedValueAgainstTheResourceLimit() {
        val blank = renameForm("  ", "Original", "Original", true, 10)
        assertEquals(RenameFieldError.Required, blank.error)
        assertFalse(blank.canSave)

        val tooLong = renameForm(" 123456 ", "Old", "Old", true, 5)
        assertEquals(RenameFieldError.TooLong, tooLong.error)
        assertFalse(tooLong.canSave)
        assertTrue(renameForm(" 12345 ", "Old", "Old", true, 5).canSave)
        assertTrue(renameForm(" 123456 ", "Old", "Old", true, null).canSave)
    }
}
