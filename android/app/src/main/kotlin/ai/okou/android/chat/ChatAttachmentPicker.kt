package ai.okou.android.chat

import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue

internal class ChatAttachmentPicker(
    val active: Boolean,
    val pick: (photos: Boolean, draftKey: String, source: String, replace: String?) -> Unit,
)

/** Register above the route so a picker result still belongs to the draft that opened it. */
@Composable
internal fun rememberChatAttachmentPicker(model: ChatComposerModel): ChatAttachmentPicker {
    var draftKey by rememberSaveable { mutableStateOf<String?>(null) }
    var source by rememberSaveable { mutableStateOf<String?>(null) }
    var replacement by rememberSaveable { mutableStateOf<String?>(null) }
    fun picked(uris: List<Uri>) {
        val draft = draftKey
        val target = source
        if (draft != null && target != null) model.addAttachments(draft, target, uris, replacement)
        draftKey = null
        source = null
        replacement = null
    }
    val photos = rememberLauncherForActivityResult(PickMultipleVisualMedia(), ::picked)
    val files = rememberLauncherForActivityResult(OpenMultipleDocuments(), ::picked)
    return ChatAttachmentPicker(draftKey != null) { pickPhotos, key, target, replace ->
        if (draftKey == null) {
            draftKey = key
            source = target
            replacement = replace
            try {
                if (pickPhotos) photos.launch(PickVisualMediaRequest(PickVisualMedia.ImageAndVideo))
                else files.launch(arrayOf("*/*"))
            } catch (_: ActivityNotFoundException) {
                picked(emptyList())
            }
        }
    }
}
