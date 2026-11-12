package ai.okou.android

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A preview is a snapshot, distinct from the native editor's current text/selection/IME state. */
class DraftPreviewStateHolder {
    private val mutablePreview = MutableStateFlow<String?>(null)
    val preview = mutablePreview.asStateFlow()

    fun previewDraft(text: String) {
        if (text.isNotBlank()) mutablePreview.value = text
    }
}
