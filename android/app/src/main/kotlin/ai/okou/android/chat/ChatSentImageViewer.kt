package ai.okou.android.chat

import ai.okou.android.R
import ai.okou.android.artifacts.ArtifactCatalogModel
import ai.okou.android.artifacts.ArtifactPreviewState
import ai.okou.android.artifacts.ImageViewerGroup
import ai.okou.android.artifacts.ImageViewerPage
import ai.okou.android.artifacts.ImageViewerToolbar
import ai.okou.android.artifacts.attachmentPreviewId
import ai.okou.android.artifacts.rememberArtifactExportControls
import ai.okou.android.artifacts.rememberArtifactSaveLauncher
import ai.okou.android.state.rememberArtifactPageState
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import java.io.File

internal data class ChatSentImageVisit(
    val threadId: String,
    val images: List<ChatAttachmentReference>,
    val start: Int,
    val localFiles: Map<String, File>,
) {
    val initialLink = images[start].attachmentPreviewId()
}

@Composable
internal fun ChatSentImageViewer(
    model: ArtifactCatalogModel,
    visit: ChatSentImageVisit,
    wide: Boolean,
    onBack: () -> Unit,
) {
    val ids = remember(visit) { visit.images.map { it.attachmentPreviewId() } }
    val pager = rememberPagerState(visit.start) { ids.size }
    val selected = ids[pager.settledPage]
    val state by model.state.collectAsStateWithLifecycle()
    val page = rememberArtifactPageState()
    val saveLauncher = rememberArtifactSaveLauncher(model, page)
    val original = state.preview?.takeIf { it.id == selected }?.access?.save
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
        toolbar = { _, number, expanded, toggle ->
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
            state.preview?.takeIf { active && it.id == id }
                ?: model.sentImageProblem(id)?.let { ArtifactPreviewState(id, null, problem = it) }
        ImageViewerPage(
            preview,
            model,
            image.filename,
            zoom,
            viewer,
            modifier,
            localFile = visit.localFiles[image.id],
            thumbnail = thumbnail,
            saveResult = export.result.takeIf { active },
            shareSnackbar = export.snackbar.takeIf { active },
        )
    }
}
