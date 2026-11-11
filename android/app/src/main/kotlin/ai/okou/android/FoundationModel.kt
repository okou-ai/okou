package ai.okou.android

import ai.okou.ccstate.Store
import ai.okou.ccstate.command
import ai.okou.ccstate.computed
import ai.okou.ccstate.state
import androidx.lifecycle.ViewModel

/** An offline consumer of the real graph; no remote writes or simulated conversations. */
class FoundationModel : ViewModel() {
    val store = Store()
    private val text = state("")
    private val preview = state<String?>(null)
    val draft = computed { get, _ -> get.get(text) }
    val canPreview = computed { get, _ -> get.get(text).isNotBlank() }
    val lastPreview = computed { get, _ -> get.get(preview) }
    val replaceDraft = command<String, Unit> { context, value -> context.set(text, value) }
    val previewDraft =
        command<Unit, Unit> { context, _ ->
            val value = context.get(text)
            if (value.isNotBlank()) context.set(preview, value)
        }

    override fun onCleared() {
        store.close()
    }
}
