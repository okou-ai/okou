package ai.okou.android.artifacts

import ai.okou.android.R
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.state.ArtifactPageState
import ai.okou.android.state.rememberArtifactPageState
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.ActivityResultLauncher
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
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
    searchArtifactId: String? = null,
) {
    val state by model.state.collectAsStateWithLifecycle()
    val position = rememberLazyListState()
    val focus = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val input = rememberTextFieldState()
    val page = rememberArtifactPageState()
    val saveLauncher = rememberArtifactSaveLauncher(model, page)
    val selectedId = searchArtifactId ?: page.selectedId

    LifecycleStartEffect(model) {
        model.setActive(
            true,
            ArtifactQuery(page.filter, input.text.toString().trim()),
            showCatalog = searchArtifactId == null,
        )
        onStopOrDispose { model.setActive(false) }
    }
    LaunchedEffect(model, selectedId) { model.select(selectedId) }
    LaunchedEffect(model, input, searchArtifactId) {
        if (searchArtifactId != null) return@LaunchedEffect
        snapshotFlow { input.text.toString().trim() }
            .collect { keyword ->
                if (keyword != model.state.value.query.keyword) {
                    page.restoreRow = null
                    position.requestScrollToItem(0)
                    model.query(
                        ArtifactQuery(page.filter, keyword),
                        debounce = keyword.isNotEmpty(),
                    )
                }
            }
    }

    fun back() {
        focus.clearFocus()
        keyboard?.hide()
        val current = page.selectedId
        if (current == null || searchArtifactId != null) {
            onClose()
        } else {
            page.restoreRow = current
            page.selectedId = null
            model.select(null)
        }
    }

    BackHandler(onBack = ::back)
    val wide = searchArtifactId == null && listWidth != null
    Row(Modifier.fillMaxSize().windowInsetsPadding(WindowInsets.safeDrawing).imePadding()) {
        if (wide || selectedId == null) {
            ArtifactCatalogList(
                model,
                state,
                input,
                page.filter,
                onFilter = { next ->
                    if (page.filter != next) {
                        page.filter = next
                        page.restoreRow = null
                        position.requestScrollToItem(0)
                        model.query(
                            ArtifactQuery(next, input.text.toString().trim()),
                            debounce = false,
                        )
                    }
                },
                position = position,
                selectedId = selectedId,
                restoreRow = page.restoreRow,
                onFocusRestored = { page.restoreRow = null },
                onSelect = { item ->
                    focus.clearFocus()
                    keyboard?.hide()
                    page.selectedId = item.id
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
                    ArtifactToolbar(
                        if (searchArtifactId == null) R.string.artifact_title
                        else R.string.chat_search_artifact_preview,
                        if (searchArtifactId == null) R.string.artifact_return_list
                        else R.string.chat_search_close_artifact_preview,
                        ::back,
                    )
                ArtifactSelectionPreview(
                    model,
                    state,
                    page,
                    selectedId,
                    wide,
                    saveLauncher,
                    threads,
                    onSource,
                )
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

/** Register with the route so a document result can arrive after a preview closes. */
@Composable
internal fun rememberArtifactSaveLauncher(
    model: ArtifactCatalogModel,
    page: ArtifactPageState,
): ActivityResultLauncher<Intent> {
    val context = LocalContext.current
    return rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        result ->
        val id = page.pickerArtifactId
        page.pickerArtifactId = null
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
}

@Composable
internal fun ArtifactSelectionPreview(
    model: ArtifactCatalogModel,
    state: ArtifactCatalogState,
    page: ArtifactPageState,
    selectedId: String,
    wide: Boolean,
    saveLauncher: ActivityResultLauncher<Intent>,
    threads: List<ConfirmedChat> = emptyList(),
    onSource: (ConfirmedChat) -> Unit = {},
) {
    var pickerFailed by remember(selectedId) { mutableStateOf(false) }
    key(selectedId) {
        val id = selectedId
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
            restoreSourceFocus = page.restoreSource,
            onSourceFocusRestored = { page.restoreSource = false },
            onSource = {
                page.restoreSource = true
                onSource(it)
            },
            saveEnabled = !state.saving && page.pickerArtifactId == null,
            onSave = { file ->
                if (page.pickerArtifactId == null && !model.state.value.saving) {
                    page.pickerArtifactId = id
                    pickerFailed = false
                    try {
                        saveLauncher.launch(
                            Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                                addCategory(Intent.CATEGORY_OPENABLE)
                                type =
                                    file.contentType.substringBefore(';').takeIf { '/' in it }
                                        ?: "application/octet-stream"
                                putExtra(Intent.EXTRA_TITLE, file.filename)
                            }
                        )
                    } catch (_: ActivityNotFoundException) {
                        page.pickerArtifactId = null
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
