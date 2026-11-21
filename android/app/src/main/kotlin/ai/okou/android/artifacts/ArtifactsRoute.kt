package ai.okou.android.artifacts

import ai.okou.android.state.rememberArtifactFilter
import ai.okou.android.state.rememberArtifactFlag
import ai.okou.android.state.rememberArtifactId
import ai.okou.android.R
import ai.okou.android.chat.ConfirmedChat
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.IOException

@Composable
internal fun ArtifactsRoute(
    model: ArtifactCatalogModel,
    threads: List<ConfirmedChat>,
    listWidth: Int?,
    onClose: () -> Unit,
    onSource: (ConfirmedChat) -> Unit,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val position = rememberLazyListState()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val input = rememberTextFieldState()
    var filter by rememberArtifactFilter()
    var selectedId by rememberArtifactId()
    var restoreRow by rememberArtifactId()
    var restoreSource by rememberArtifactFlag()
    var pendingSaveId by rememberArtifactId()
    var pickerFailed by rememberArtifactFlag()
    val context = LocalContext.current
    val picker =
        rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result
            ->
            val id = pendingSaveId
            pendingSaveId = null
            val destination = result.data?.data
            if (
                id != null &&
                    result.resultCode == Activity.RESULT_OK &&
                    destination?.scheme == "content"
            ) {
                model.save(id) {
                    context.contentResolver.openOutputStream(destination, "wt")
                        ?: throw IOException("Document provider did not open its destination")
                }
            }
        }

    LifecycleStartEffect(model) {
        model.setActive(true, ArtifactQuery(filter, input.text.toString().trim()))
        onStopOrDispose { model.setActive(false) }
    }
    LaunchedEffect(model, selectedId) { model.select(selectedId) }
    LaunchedEffect(model, input) {
        snapshotFlow { input.text.toString().trim() }
            .collect { keyword ->
                if (keyword != model.state.value.query.keyword) {
                    restoreRow = null
                    position.requestScrollToItem(0)
                    model.query(ArtifactQuery(filter, keyword), debounce = keyword.isNotEmpty())
                }
            }
    }

    fun back() {
        focus.clearFocus()
        keyboard?.hide()
        val current = selectedId
        if (current == null) {
            onClose()
        } else {
            restoreRow = current
            selectedId = null
            model.select(null)
        }
    }

    BackHandler(onBack = ::back)
    val wide = listWidth != null
    Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding()) {
        if (wide || selectedId == null) {
            ArtifactCatalogList(
                model,
                state,
                input,
                filter,
                onFilter = { next ->
                    if (filter != next) {
                        filter = next
                        restoreRow = null
                        position.requestScrollToItem(0)
                        model.query(
                            ArtifactQuery(filter, input.text.toString().trim()),
                            debounce = false,
                        )
                    }
                },
                position = position,
                selectedId = selectedId,
                restoreRow = restoreRow,
                onFocusRestored = { restoreRow = null },
                onSelect = { item ->
                    focus.clearFocus()
                    keyboard?.hide()
                    pickerFailed = false
                    selectedId = item.id
                    model.select(item.id, item)
                },
                onClose = {
                    focus.clearFocus()
                    keyboard?.hide()
                    onClose()
                },
                modifier =
                    if (listWidth == null) Modifier.weight(1f)
                    else Modifier.width((listWidth - 1).dp),
            )
        }
        if (wide) VerticalDivider(color = MaterialTheme.colorScheme.outline)
        if (selectedId != null) {
            Column(Modifier.weight(1f)) {
                if (!wide)
                    ArtifactToolbar(R.string.artifact_title, R.string.artifact_return_list, ::back)
                key(selectedId) {
                    val id = checkNotNull(selectedId)
                    val preview = state.preview?.takeIf { it.id == id }
                    val source =
                        preview?.info?.sourceChatId?.let { sourceId ->
                            threads.firstOrNull { it.id == sourceId && it.hidden != true }
                        }
                    ArtifactPreview(
                        preview,
                        rememberScrollState(),
                        wide,
                        state.offline,
                        source,
                        restoreSourceFocus = restoreSource,
                        onSourceFocusRestored = { restoreSource = false },
                        onSource = {
                            restoreSource = true
                            onSource(it)
                        },
                        onSave = { file ->
                            if (pendingSaveId == null) {
                                pendingSaveId = id
                                pickerFailed = false
                                try {
                                    picker.launch(
                                        Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                                            addCategory(Intent.CATEGORY_OPENABLE)
                                            type =
                                                file.contentType.substringBefore(';').takeIf {
                                                    '/' in it
                                                } ?: "application/octet-stream"
                                            putExtra(Intent.EXTRA_TITLE, file.filename)
                                        }
                                    )
                                } catch (_: ActivityNotFoundException) {
                                    pendingSaveId = null
                                    pickerFailed = true
                                }
                            }
                        },
                        saveResult =
                            if (pickerFailed) ArtifactSaveResult.Failed
                            else state.saveResult?.takeIf { it.first == id }?.second,
                    )
                }
            }
        } else if (wide) {
            Box(
                Modifier.weight(1f).fillMaxSize().padding(16.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    stringResource(R.string.artifact_select_prompt),
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
