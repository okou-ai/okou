package ai.okou.android.foundation

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update

data class DraftUiState(val text: String = "", val preview: String? = null) {
    val canPreview: Boolean
        get() = text.isNotBlank()
}

/** An in-memory local draft. The screen owner creates one instance per draft lifetime. */
class DraftStateHolder {
    private val mutableState = MutableStateFlow(DraftUiState())
    val uiState: StateFlow<DraftUiState> = mutableState.asStateFlow()

    fun replaceDraft(text: String) {
        mutableState.update { it.copy(text = text) }
    }

    fun previewDraft() {
        mutableState.update { current ->
            if (current.canPreview) current.copy(preview = current.text) else current
        }
    }
}
