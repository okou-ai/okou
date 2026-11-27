package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.artifacts.ArtifactSaveResult
import ai.okou.android.artifacts.ImageViewerGroup
import ai.okou.android.artifacts.ImageViewerPage
import ai.okou.android.artifacts.ImageViewerToolbar
import ai.okou.android.artifacts.shareOriginalFile
import ai.okou.android.state.rememberDraftImageSaveTarget
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.io.File
import java.io.IOException
import java.io.OutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

internal data class ChatDraftImageVisit(
    val targetKey: String,
    val draftKey: String,
    val keys: List<String>,
    val start: Int,
    val restoreKeyboard: Boolean,
)

@Composable
internal fun ChatDraftImageViewer(
    model: ChatComposerModel,
    target: ComposerTarget,
    visit: ChatDraftImageVisit,
    attachments: List<DraftChatAttachment>,
    listPaneWidth: Dp?,
    onBack: () -> Unit,
) {
    val pager = rememberPagerState(visit.start) { visit.keys.size }
    val selected = visit.keys[pager.settledPage]
    val byKey = remember(attachments) { attachments.filter { it.staged }.associateBy { it.key } }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var writing by remember { mutableStateOf(false) }
    var sharing by remember { mutableStateOf(false) }
    var pickerKey by rememberDraftImageSaveTarget()
    var result by remember { mutableStateOf<Pair<String, ArtifactSaveResult>?>(null) }
    fun current(key: String): Boolean =
        model.draftImageVisit === visit &&
            model.uiState.value.draftKey(target) == visit.draftKey &&
            model.uiState.value.attachments(target).any { it.key == key && it.staged }

    val save =
        rememberLauncherForActivityResult(StartActivityForResult()) { response ->
            val key = pickerKey
            pickerKey = null
            val uri = response.data?.data
            if (
                key != null && response.resultCode == Activity.RESULT_OK && uri?.scheme == "content"
            ) {
                writing = true
                scope.launch {
                    try {
                        result =
                            key to
                                if (current(key)) {
                                    copyDraftImage(model.attachmentFile(key)) {
                                        context.contentResolver.openOutputStream(uri, "wt")
                                    }
                                } else ArtifactSaveResult.Denied
                    } finally {
                        writing = false
                    }
                }
            }
        }
    val active = byKey[selected]
    val wide = listPaneWidth != null
    ImageViewerGroup(
        pager,
        wide,
        onBack,
        activeUnavailable = active == null,
        overlayStart = listPaneWidth ?: 0.dp,
        toolbar = { number, expanded, toggle ->
            ImageViewerToolbar(
                R.string.back,
                onBack,
                wide,
                expanded,
                toggle,
                saveEnabled = !sharing && !writing && pickerKey == null,
                onSave =
                    active?.let { image ->
                        {
                            if (!sharing && !writing && pickerKey == null && current(image.key)) {
                                pickerKey = image.key
                                result = null
                                try {
                                    save.launch(
                                        Intent(Intent.ACTION_CREATE_DOCUMENT)
                                            .addCategory(Intent.CATEGORY_OPENABLE)
                                            .setType(image.contentType)
                                            .putExtra(Intent.EXTRA_TITLE, image.filename),
                                    )
                                } catch (_: ActivityNotFoundException) {
                                    pickerKey = null
                                    result = image.key to ArtifactSaveResult.Failed
                                }
                            }
                        }
                    },
                onShare =
                    active?.let { image ->
                        {
                            if (!sharing && !writing && pickerKey == null && current(image.key)) {
                                sharing = true
                                result = null
                                scope.launch {
                                    try {
                                        val shared =
                                            shareOriginalFile(
                                                context,
                                                image.filename,
                                                image.contentType,
                                            ) { copy ->
                                                val copied =
                                                    copyDraftImage(
                                                        model.attachmentFile(image.key),
                                                    ) {
                                                        copy.outputStream()
                                                    }
                                                if (current(image.key)) copied
                                                else ArtifactSaveResult.Denied
                                            }
                                        if (shared != ArtifactSaveResult.Saved)
                                            result = image.key to shared
                                    } catch (cancelled: CancellationException) {
                                        throw cancelled
                                    } catch (_: Exception) {
                                        result = image.key to ArtifactSaveResult.Failed
                                    } finally {
                                        sharing = false
                                    }
                                }
                            }
                        }
                    },
                sharing = sharing,
                onSource = null,
                links = null,
                pageNumber = number,
            )
        },
    ) { index, zoom, viewer, modifier ->
        val image = byKey[visit.keys[index]]
        val file = remember(model, image?.key) { image?.let { model.attachmentFile(it.key) } }
        ImageViewerPage(
            preview = null,
            model = null,
            description = image?.filename,
            zoom,
            viewer,
            modifier,
            localFile = file,
            unavailableLocal = image == null,
            keyboardPaging = visit.keys.size > 1,
            saveResult = result?.second?.takeIf { image?.key == result?.first },
        )
    }
}

private suspend fun copyDraftImage(
    file: File,
    destination: () -> OutputStream?,
): ArtifactSaveResult =
    withContext(Dispatchers.IO) {
        try {
            file.inputStream().use { source ->
                val sink = destination() ?: return@withContext ArtifactSaveResult.Failed
                sink.use { output ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val bytes = source.read(buffer)
                        if (bytes < 0) break
                        output.write(buffer, 0, bytes)
                    }
                }
            }
            ArtifactSaveResult.Saved
        } catch (_: IOException) {
            ArtifactSaveResult.Failed
        } catch (_: SecurityException) {
            ArtifactSaveResult.Denied
        }
    }
