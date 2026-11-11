package ai.okou.android

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class DraftStateHolderTest {
    @Test
    fun blankDraftCannotReplaceAnExistingPreview() {
        val owner = DraftStateHolder()
        assertEquals(DraftUiState(), owner.uiState.value)
        owner.replaceDraft("original")
        owner.previewDraft()
        for (blank in listOf("", " ", "\n\t")) {
            owner.replaceDraft(blank)
            assertFalse(owner.uiState.value.canPreview)
            owner.previewDraft()
            assertEquals(DraftUiState(blank, "original"), owner.uiState.value)
        }
    }

    @Test
    fun previewPreservesVerbatimTextAndRemainsASnapshotWhileEditing() {
        val owner = DraftStateHolder()
        val text = "  Hello Okou\n你好 👋  "
        owner.replaceDraft(text)
        assertTrue(owner.uiState.value.canPreview)
        owner.previewDraft()
        val previewed = owner.uiState.value
        assertEquals(DraftUiState(text, text), previewed)
        owner.replaceDraft("next draft")
        assertEquals(DraftUiState("next draft", text), owner.uiState.value)
        assertEquals(text, previewed.text)
        owner.previewDraft()
        assertEquals(DraftUiState("next draft", "next draft"), owner.uiState.value)
    }

    @Test
    fun actionsReadCurrentStateEvenWithoutAnActiveUiCollector() {
        val owner = DraftStateHolder()
        owner.replaceDraft("first")
        owner.replaceDraft("latest")
        owner.previewDraft()
        assertEquals(DraftUiState("latest", "latest"), owner.uiState.value)
    }

    @Test
    fun draftOwnersAreIndependent() {
        val first = DraftStateHolder()
        val second = DraftStateHolder()
        first.replaceDraft("first")
        second.replaceDraft("second")
        first.previewDraft()
        assertEquals(DraftUiState("first", "first"), first.uiState.value)
        assertEquals(DraftUiState("second"), second.uiState.value)
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test
    fun observersSeeCoherentTextAndDerivedValidation() = runTest {
        val owner = DraftStateHolder()
        val seen = mutableListOf<DraftUiState>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            owner.uiState.collect { seen.add(it) }
        }
        owner.replaceDraft("ready")
        owner.previewDraft()
        owner.replaceDraft(" ")
        assertEquals(DraftUiState(" ", "ready"), owner.uiState.value)
        assertTrue(seen.any { it.preview == "ready" })
        for (snapshot in seen) assertEquals(snapshot.text.isNotBlank(), snapshot.canPreview)
    }
}
