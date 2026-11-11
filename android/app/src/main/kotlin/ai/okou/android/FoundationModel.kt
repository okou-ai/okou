package ai.okou.android

import androidx.lifecycle.ViewModel

/** Retains the local draft for this screen; no network or background operation is started. */
class FoundationModel : ViewModel() {
    private val draft = DraftStateHolder()
    val uiState = draft.uiState

    fun replaceDraft(text: String) = draft.replaceDraft(text)

    fun previewDraft() = draft.previewDraft()
}
