package ai.okou.android.chat

import ai.okou.android.state.AttachmentPickerSelection
import ai.okou.android.state.rememberAttachmentPickerSelection
import android.content.ActivityNotFoundException
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments
import androidx.activity.result.contract.ActivityResultContracts.PickMultipleVisualMedia
import androidx.activity.result.contract.ActivityResultContracts.PickVisualMedia
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.setValue

internal class ChatAttachmentPicker(
    val active: Boolean,
    val pick: (photos: Boolean, draftKey: String, source: String, replace: String?) -> Unit,
)

/** Register above the route so a picker result still belongs to the draft that opened it. */
@Composable
internal fun rememberChatAttachmentPicker(model: ChatComposerModel): ChatAttachmentPicker {
    var selection by rememberAttachmentPickerSelection()
    fun picked(uris: List<Uri>) {
        selection?.let { model.addAttachments(it.draftKey, it.targetKey, uris, it.replacing) }
        selection = null
    }
    val photos = rememberLauncherForActivityResult(PickMultipleVisualMedia(), ::picked)
    val files = rememberLauncherForActivityResult(OpenMultipleDocuments(), ::picked)
    return ChatAttachmentPicker(selection != null) { pickPhotos, key, target, replace ->
        if (selection == null) {
            selection = AttachmentPickerSelection(key, target, replace)
            try {
                if (pickPhotos) photos.launch(PickVisualMediaRequest(PickVisualMedia.ImageAndVideo))
                else files.launch(arrayOf("*/*"))
            } catch (_: ActivityNotFoundException) {
                picked(emptyList())
            }
        }
    }
}
