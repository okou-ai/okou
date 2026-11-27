package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.artifacts.ArtifactCatalogModel
import ai.okou.android.artifacts.ArtifactPreviewState
import ai.okou.android.artifacts.ImageViewerGroup
import ai.okou.android.artifacts.ImageViewerPage
import ai.okou.android.artifacts.ImageViewerToolbar
import ai.okou.android.artifacts.isImageUnavailable
import ai.okou.android.artifacts.rememberArtifactExportControls
import ai.okou.android.artifacts.rememberArtifactSaveLauncher
import ai.okou.android.state.rememberArtifactPageState
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.File

internal data class ChatImagePage(
    val source: String,
    val description: String,
    val localFile: File? = null,
)

internal data class ChatImageVisit(
    val threadId: String,
    val images: List<ChatImagePage>,
    val start: Int,
) {
    val initialLink = images[start].source
}

@Composable
internal fun ChatImageViewer(
    model: ArtifactCatalogModel,
    visit: ChatImageVisit,
    wide: Boolean,
    onBack: () -> Unit,
) {
    val ids = remember(visit) { visit.images.map { it.source } }
    val pager = rememberPagerState(visit.start) { ids.size }
    val selected = ids[pager.settledPage]
    val state by model.state.collectAsStateWithLifecycle()
    val page = rememberArtifactPageState()
    val saveLauncher = rememberArtifactSaveLauncher(model, page)
    val current = state.preview?.takeIf { it.id == selected }
    val revoked = model.chatImageProblem(selected)
    val original = current?.access?.save.takeIf { revoked == null }
    val export =
        rememberArtifactExportControls(model, state, page, selected, saveLauncher, original)
    LifecycleStartEffect(model, visit) {
        model.select(ids[pager.settledPage])
        model.setActive(true, showCatalog = false)
        onStopOrDispose { model.setActive(false) }
    }
    LaunchedEffect(model, selected) { model.select(selected) }
    BackHandler(onBack = onBack)
    ImageViewerGroup(
        pager,
        wide,
        onBack,
        activeUnavailable = revoked != null || current?.problem.isImageUnavailable,
        toolbar = { number, expanded, toggle ->
            ImageViewerToolbar(
                R.string.back,
                onBack,
                wide,
                expanded,
                toggle,
                export.enabled,
                original?.let { { export.save(it) } },
                export.share,
                export.sharing,
                onSource = null,
                links = null,
                pageNumber = number,
            )
        },
    ) { index, zoom, viewer, modifier ->
        val image = visit.images[index]
        val id = ids[index]
        val active = zoom != null
        val thumbnail by
            remember(model, visit.threadId, id) {
                    model.inlineImages.observeThumbnail(visit.threadId, id)
                }
                .collectAsStateWithLifecycle(model.inlineImages.thumbnail(visit.threadId, id))
        val preview =
            model.chatImageProblem(id)?.let { ArtifactPreviewState(id, null, problem = it) }
                ?: state.preview?.takeIf { active && it.id == id }
        ImageViewerPage(
            preview,
            model,
            image.description.ifBlank {
                preview?.item?.title ?: stringResource(R.string.artifact_image)
            },
            zoom,
            viewer,
            modifier,
            localFile = image.localFile,
            thumbnail = thumbnail,
            keyboardPaging = ids.size > 1,
            saveResult = export.result.takeIf { active },
            shareSnackbar = export.snackbar.takeIf { active },
        )
    }
}
