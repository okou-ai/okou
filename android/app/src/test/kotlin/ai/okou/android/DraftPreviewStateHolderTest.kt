package ai.okou.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class DraftPreviewStateHolderTest {
    @Test
    fun previewPreservesVerbatimTextAndBlankInputCannotReplaceIt() {
        val holder = DraftPreviewStateHolder()
        assertNull(holder.preview.value)
        val text = "  Hello Okou\n你好 👋  "
        holder.previewDraft(text)
        assertEquals(text, holder.preview.value)
        for (blank in listOf("", " ", "\n\t")) {
            holder.previewDraft(blank)
            assertEquals(text, holder.preview.value)
        }
        holder.previewDraft("next snapshot")
        assertEquals("next snapshot", holder.preview.value)
    }

    @Test
    fun ownersAreIndependentWithoutCollectors() {
        val first = DraftPreviewStateHolder()
        val second = DraftPreviewStateHolder()
        first.previewDraft("first")
        second.previewDraft("second")
        assertEquals("first", first.preview.value)
        assertEquals("second", second.preview.value)
    }
}
