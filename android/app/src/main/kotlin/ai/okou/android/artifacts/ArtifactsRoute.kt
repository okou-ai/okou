package ai.okou.android.artifacts

import ai.okou.android.DirectoryReturnFocus
import ai.okou.android.R
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.committedSearchText
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
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.InputMode
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalInputModeManager
import androidx.compose.ui.platform.LocalResources
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

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
    val inputMode = LocalInputModeManager.current
    val keyboard = LocalSoftwareKeyboardController.current
    val input = rememberTextFieldState()
    val page = rememberArtifactPageState()
    val returnFocus = remember(model, searchArtifactId) { DirectoryReturnFocus() }
    val saveLauncher = rememberArtifactSaveLauncher(model, page)
    val selectedId = searchArtifactId ?: page.selectedId

    fun catalogQuery(filter: ArtifactFilter, previousKeyword: String) =
        ArtifactQuery(filter, input.committedSearchText()?.trim() ?: previousKeyword)

    val visibleQuery = catalogQuery(page.filter, state.query.keyword)
    val refreshSnackbar =
        rememberArtifactRefreshFeedback(
            model,
            visibleQuery,
            state.takeIf { searchArtifactId == null },
        )
    LifecycleStartEffect(model, searchArtifactId) {
        model.setActive(
            true,
            catalogQuery(page.filter, model.state.value.query.keyword),
            showCatalog = searchArtifactId == null,
        )
        onStopOrDispose { model.setActive(false) }
    }
    LaunchedEffect(model, selectedId) { model.select(selectedId) }
    LaunchedEffect(model, input, searchArtifactId) {
        if (searchArtifactId != null) return@LaunchedEffect
        snapshotFlow { input.committedSearchText()?.trim() }
            .filterNotNull()
            .collect { keyword ->
                val query = ArtifactQuery(page.filter, keyword)
                if (query != model.state.value.query) {
                    returnFocus.cancel()
                    position.requestScrollToItem(0)
                    model.query(
                        query,
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
            returnFocus.returningFrom(
                current,
                inputMode.inputMode,
                previousIndex = page.selectedRowIndex,
            )
            page.selectedId = null
            page.selectedRowIndex = null
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
                refreshSnackbar,
                input,
                visibleQuery,
                onFilter = { next ->
                    if (page.filter != next) {
                        page.filter = next
                        returnFocus.cancel()
                        position.requestScrollToItem(0)
                        model.query(
                            catalogQuery(next, model.state.value.query.keyword),
                            debounce = false,
                        )
                    }
                },
                position = position,
                selectedId = selectedId,
                returnFocus = returnFocus,
                onSelect = { item ->
                    returnFocus.cancel()
                    page.selectedRowIndex =
                        position.layoutInfo.visibleItemsInfo
                            .firstOrNull { it.key == item.id }
                            ?.index
                    if (!wide || inputMode.inputMode != InputMode.Keyboard) focus.clearFocus()
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
        if (wide) VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (selectedId != null) {
            Column(Modifier.weight(1f)) {
                val backLabel =
                    if (searchArtifactId == null) R.string.artifact_return_list
                    else R.string.chat_search_close_artifact_preview
                ArtifactSelectionPreview(
                    model,
                    state,
                    page,
                    selectedId,
                    wide,
                    saveLauncher,
                    onBack = ::back,
                    backLabel = backLabel,
                    threads = threads,
                    onSource = onSource,
                ) {
                    if (!wide)
                        ArtifactToolbar(
                            if (searchArtifactId == null) R.string.artifact_title
                            else R.string.chat_search_artifact_preview,
                            backLabel,
                            ::back,
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
    onBack: () -> Unit,
    @androidx.annotation.StringRes backLabel: Int,
    threads: List<ConfirmedChat> = emptyList(),
    onSource: (ConfirmedChat) -> Unit = {},
    showArtifactImageViewer: Boolean = true,
    toolbar: @Composable () -> Unit,
) {
    key(selectedId) {
        val id = selectedId
        val preview = state.preview?.takeIf { it.id == id }
        val original = preview?.access?.save
        val generated = showArtifactImageViewer && isGeneratedArtifactPreview(id)
        val export =
            rememberArtifactExportControls(
                model,
                state,
                page,
                id,
                saveLauncher,
                original.takeIf { generated || chatAttachment(id) != null },
            )
        val source =
            preview?.info?.sourceChatId?.let { sourceId ->
                threads.firstOrNull { it.id == sourceId && it.hidden != true }
            }
        val openSource: (ConfirmedChat) -> Unit = {
            export.cancelShare()
            page.restoreSource = true
            onSource(it)
        }
        val uploadedImage = showArtifactImageViewer && isChatAttachmentImage(id)
        ArtifactLinkControls(
            preview?.linkSource,
            preview?.item?.title.orEmpty(),
            model,
            export.snackbar,
        ) { links ->
            if (uploadedImage || generated && preview?.isImage == true) {
                ArtifactImageViewer(
                    preview = preview ?: ArtifactPreviewState(id, null),
                    model = model,
                    wide = wide,
                    backLabel = backLabel,
                    onBack = onBack,
                    saveEnabled = export.enabled,
                    onSave = original?.let { { export.save(it) } },
                    saveResult = export.result,
                    onShare = export.share,
                    sharing = export.sharing,
                    shareSnackbar = export.snackbar,
                    links = links,
                    onSource = source?.let { { openSource(it) } },
                    restoreSourceFocus = page.restoreSource,
                    onSourceFocusRestored = { page.restoreSource = false },
                )
            } else {
                toolbar()
                ArtifactPreview(
                    preview,
                    rememberScrollState(),
                    wide,
                    source,
                    restoreSourceFocus = page.restoreSource,
                    onSourceFocusRestored = { page.restoreSource = false },
                    onSource = openSource,
                    saveEnabled = export.enabled,
                    onSave = export.save,
                    saveResult = export.result,
                    onShare = export.share,
                    sharing = export.sharing,
                    shareSnackbar = export.snackbar,
                    links = links,
                )
            }
        }
    }
}

internal data class ArtifactExportControls(
    val enabled: Boolean,
    val sharing: Boolean,
    val snackbar: SnackbarHostState,
    val result: ArtifactSaveResult?,
    val save: (ArtifactSave) -> Unit,
    val share: (() -> Unit)?,
    val cancelShare: () -> Unit,
)

@Composable
internal fun rememberArtifactExportControls(
    model: ArtifactCatalogModel,
    state: ArtifactCatalogState,
    page: ArtifactPageState,
    id: String,
    saveLauncher: ActivityResultLauncher<Intent>,
    shareableOriginal: ArtifactSave?,
): ArtifactExportControls =
    key(id) {
        val context = LocalContext.current
        val resources = LocalResources.current
        val scope = rememberCoroutineScope()
        val snackbar = remember { SnackbarHostState() }
        var sharing by remember { mutableStateOf(false) }
        var pickerFailed by remember { mutableStateOf(false) }
        fun canStart() = !sharing && page.pickerArtifactId == null && !model.state.value.saving
        val share: (() -> Unit)? = shareableOriginal?.let { file ->
            {
                if (canStart()) {
                    sharing = true
                    scope.launch {
                        val result =
                            try {
                                shareArtifactOriginal(context, model, id, file)
                            } catch (cancelled: CancellationException) {
                                throw cancelled
                            } catch (_: Exception) {
                                ArtifactSaveResult.Failed
                            } finally {
                                sharing = false
                            }
                        val message =
                            when (result) {
                                ArtifactSaveResult.Denied -> R.string.artifact_share_denied
                                ArtifactSaveResult.Failed -> R.string.artifact_share_failed
                                else -> null
                            }
                        if (message != null) {
                            snackbar.showSnackbar(
                                resources.getString(message),
                                duration = SnackbarDuration.Indefinite,
                            )
                        }
                    }
                }
            }
        }
        ArtifactExportControls(
            enabled = !state.saving && page.pickerArtifactId == null && !sharing,
            sharing = sharing,
            snackbar = snackbar,
            result =
                if (pickerFailed) ArtifactSaveResult.Failed
                else state.saveResult?.takeIf { it.first == id }?.second,
            save = { file ->
                if (canStart()) {
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
                            },
                        )
                    } catch (_: ActivityNotFoundException) {
                        page.pickerArtifactId = null
                        pickerFailed = true
                    }
                }
            },
            share = share,
            cancelShare = { scope.coroutineContext.cancelChildren() },
        )
    }
