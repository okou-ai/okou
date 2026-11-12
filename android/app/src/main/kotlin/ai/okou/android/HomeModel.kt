package ai.okou.android

import androidx.annotation.MainThread
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.TextFieldValue
import androidx.lifecycle.ViewModel

/** Activity-retained presentation owner; this is not durable chat storage. */
class HomeModel : ViewModel() {
    var draft by mutableStateOf(TextFieldValue())
        private set

    private val previews = DraftPreviewStateHolder()
    val preview = previews.preview

    @MainThread
    fun editDraft(value: TextFieldValue) {
        draft = value
    }

    @MainThread fun previewDraft() = previews.previewDraft(draft.text)
}
