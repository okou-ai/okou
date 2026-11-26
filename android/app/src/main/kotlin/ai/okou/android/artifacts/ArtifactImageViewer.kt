package ai.okou.android.artifacts

import ai.okou.android.ContentReadFailure
import ai.okou.android.ContentReadFeedbackDelayMillis
import ai.okou.android.R
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.rememberContentReadFeedbackAfter
import ai.okou.android.state.ArtifactImageViewpoint
import ai.okou.android.state.rememberArtifactImageViewerState
import android.graphics.Bitmap
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.BitmapImage
import coil3.compose.AsyncImagePainter
import coil3.compose.ConstraintsSizeResolver
import coil3.compose.rememberAsyncImagePainter
import coil3.compose.rememberConstraintsSizeResolver
import coil3.request.CachePolicy
import coil3.request.ImageRequest
import com.github.panpf.zoomimage.ZoomImage
import com.github.panpf.zoomimage.compose.ZoomState
import com.github.panpf.zoomimage.compose.rememberZoomState
import com.github.panpf.zoomimage.compose.zoom.ZoomableState
import com.github.panpf.zoomimage.compose.zoom.keyZoom
import com.github.panpf.zoomimage.subsampling.ImageSource
import com.github.panpf.zoomimage.subsampling.fromByteArray
import com.github.panpf.zoomimage.zoom.GestureType
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

@Composable
internal fun ArtifactImageViewer(
    preview: ArtifactPreviewState,
    model: ArtifactCatalogModel,
    wide: Boolean,
    @StringRes backLabel: Int,
    onBack: () -> Unit,
    saveEnabled: Boolean,
    onSave: (() -> Unit)?,
    saveResult: ArtifactSaveResult?,
    onShare: (() -> Unit)?,
    sharing: Boolean,
    shareSnackbar: SnackbarHostState,
    links: ArtifactLinkActions?,
    onSource: (() -> Unit)?,
    restoreSourceFocus: Boolean,
    onSourceFocusRestored: () -> Unit,
) {
    val zoom = rememberZoomState()
    val viewer = rememberArtifactImageViewerState(zoom.zoomable::viewpoint)
    val imageSize = rememberConstraintsSizeResolver()
    val unavailable =
        preview.problem == ArtifactProblem.Denied ||
            preview.problem == ArtifactProblem.Missing ||
            preview.problem == ArtifactProblem.Unavailable
    val source = (preview.content as? ArtifactContent.EncodedImage).takeUnless { unavailable }
    val bitmap = (preview.content as? ArtifactContent.Image)?.bitmap ?: source?.fallback
    val thumbnailUrl =
        (preview.info?.thumbnailUrl ?: preview.item?.thumbnail).takeIf {
            bitmap == null && preview.access != null && !unavailable
        }
    val thumbnail = thumbnailUrl?.let { url ->
        key(model, url) {
            val result by
                produceState<Bitmap?>(null) {
                    value = model.thumbnail(url)
                }
            result
        }
    }
    val decoded = source?.let { DecodeArtifactImage(it.bytes, imageSize) }
    val original = decoded as? AsyncImagePainter.State.Success
    val fallback = (bitmap ?: thumbnail).takeUnless { unavailable }
    val fallbackPainter = remember(fallback) { fallback?.let { BitmapPainter(it.asImageBitmap()) } }
    val image = original?.painter ?: fallbackPainter
    val replacedViewpoint =
        remember(original?.painter) {
            if (original != null && fallback != null) zoom.zoomable.viewpoint() else null
        }

    // The same painter and zoom state survive the move between the pane and full-screen dialog.
    SideEffect { zoom.zoomable.setKeepTransformWhenSameAspectRatioContentSizeChanged(true) }
    val tileSource = remember(source) { source?.let { ImageSource.fromByteArray(it.bytes) } }
    LaunchedEffect(zoom, source, original) {
        zoom.setSubsamplingImage(tileSource.takeIf { original != null })
        val decodedBitmap = (original?.result?.image as? BitmapImage)?.bitmap
        if (source != null && decodedBitmap != null)
            model.retainDecodedImage(preview.id, source, decodedBitmap)
        // The library retains the viewpoint for equal aspect ratios. Preserve it when a cover
        // is cropped differently or an oriented original changes the aspect ratio.
        if (replacedViewpoint != null && zoom.zoomable.userTransform.scaleX <= 1f)
            zoom.zoomable.restoreViewpoint(replacedViewpoint)
    }
    LaunchedEffect(viewer, zoom) {
        val point = viewer.pendingViewpoint ?: return@LaunchedEffect
        zoom.zoomable.restoreViewpoint(point)
        viewer.pendingViewpoint = null
    }
    val problem =
        when {
            unavailable -> R.string.artifact_image_unavailable
            preview.problem == ArtifactProblem.OriginalUnavailable ->
                R.string.artifact_image_original_unavailable
            preview.problem != null ||
                preview.content == ArtifactContent.Unsupported ||
                decoded is AsyncImagePainter.State.Error -> R.string.artifact_image_load_failed
            else -> null
        }
    val loading =
        rememberContentReadFeedbackAfter(
            ContentReadFeedbackDelayMillis.takeIf { image == null && problem == null },
        )
    val pane: @Composable (Boolean) -> Unit = { fullWindow ->
        Column(
            Modifier.fillMaxSize()
                .background(MaterialTheme.colorScheme.surface)
                .testTag("artifact_preview"),
        ) {
            ImageViewerToolbar(
                backLabel,
                onBack,
                wide,
                fullWindow,
                { viewer.expanded = !fullWindow },
                saveEnabled,
                onSave,
                onShare,
                sharing,
                onSource,
                links,
                restoreSourceFocus,
                onSourceFocusRestored,
            )
            ImageViewport(
                image,
                preview.item?.title,
                zoom,
                imageSize,
                problem,
                loading,
                preview.access?.previewOnly == true,
                saveResult,
                shareSnackbar,
                Modifier.weight(1f),
            )
        }
    }
    if (wide && viewer.expanded) {
        Dialog(
            onDismissRequest = { viewer.expanded = false },
            properties =
                DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        ) {
            Box(
                Modifier.fillMaxSize()
                    .background(MaterialTheme.colorScheme.surface)
                    .windowInsetsPadding(WindowInsets.safeDrawing),
            ) {
                pane(true)
            }
        }
    } else {
        pane(false)
    }
}

@Composable
private fun ImageViewerToolbar(
    @StringRes backLabel: Int,
    onBack: () -> Unit,
    wide: Boolean,
    expanded: Boolean,
    onExpand: () -> Unit,
    saveEnabled: Boolean,
    onSave: (() -> Unit)?,
    onShare: (() -> Unit)?,
    sharing: Boolean,
    onSource: (() -> Unit)?,
    links: ArtifactLinkActions?,
    restoreSourceFocus: Boolean,
    onSourceFocusRestored: () -> Unit,
) {
    val actionsFocus = remember { FocusRequester() }
    val hasActions = onSave != null || onSource != null || links != null
    val colors = MaterialTheme.colorScheme
    LaunchedEffect(restoreSourceFocus, hasActions) {
        if (restoreSourceFocus && hasActions) {
            actionsFocus.requestFocus()
            onSourceFocusRestored()
        }
    }
    Row(
        Modifier.fillMaxWidth()
            .heightIn(min = 64.dp)
            .padding(horizontal = 12.dp)
            .testTag("artifact_image_toolbar"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ImageViewerButton(R.drawable.ic_arrow_back, backLabel, onBack)
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            if (sharing) {
                Text(
                    stringResource(R.string.artifact_share_preparing),
                    Modifier.padding(horizontal = 8.dp).semantics {
                        liveRegion = LiveRegionMode.Polite
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (wide) {
            ImageViewerButton(
                if (expanded) R.drawable.ic_fullscreen_exit else R.drawable.ic_fullscreen,
                if (expanded) R.string.artifact_image_collapse else R.string.artifact_image_expand,
                onExpand,
                tint = colors.onSurfaceVariant,
            )
            Spacer(Modifier.width(4.dp))
        }
        if (hasActions) {
            val previewItems = buildList {
                if (onShare != null)
                    add(
                        WorkspaceMenuItem(
                            stringResource(R.string.artifact_share_image),
                            R.drawable.ic_share,
                            enabled = saveEnabled,
                            onClick = onShare,
                        ),
                    )
                if (onSave != null)
                    add(
                        WorkspaceMenuItem(
                            stringResource(R.string.artifact_save_image),
                            R.drawable.ic_download,
                            enabled = saveEnabled,
                            onClick = onSave,
                        ),
                    )
                if (onSource != null)
                    add(
                        WorkspaceMenuItem(
                            stringResource(R.string.artifact_view_source),
                            R.drawable.ic_chevron_right,
                            onClick = onSource,
                        ),
                    )
            }
            ArtifactOverflowMenu(
                R.string.artifact_image_actions,
                links,
                focus = actionsFocus,
                previewItems = previewItems,
                iconColor = colors.onSurfaceVariant,
            )
        } else {
            Spacer(Modifier.size(48.dp))
        }
    }
}

@Composable
private fun ImageViewerButton(
    @DrawableRes icon: Int,
    @StringRes label: Int,
    onClick: () -> Unit,
    tint: Color = MaterialTheme.colorScheme.onSurface,
) {
    IconButton(onClick = onClick, modifier = Modifier.size(48.dp)) {
        Icon(
            painterResource(icon),
            stringResource(label),
            Modifier.size(24.dp),
            tint = tint,
        )
    }
}

@Composable
private fun DecodeArtifactImage(
    bytes: ByteArray,
    size: ConstraintsSizeResolver,
): AsyncImagePainter.State? {
    val context = LocalContext.current
    val request =
        remember(context, bytes, size) {
            ImageRequest.Builder(context)
                .data(bytes)
                .size(size)
                .memoryCachePolicy(CachePolicy.DISABLED)
                .diskCachePolicy(CachePolicy.DISABLED)
                .build()
        }
    val state by
        rememberAsyncImagePainter(request, contentScale = ContentScale.Fit)
            .state
            .collectAsStateWithLifecycle()
    return when (val result = state) {
        is AsyncImagePainter.State.Success -> result.takeIf { it.result.request.data === bytes }
        is AsyncImagePainter.State.Error -> result.takeIf { it.result.request.data === bytes }
        else -> null
    }
}

private fun ZoomableState.viewpoint(): ArtifactImageViewpoint? {
    val size = contentSize
    val viewport = containerSize
    if (size == IntSize.Zero || viewport == IntSize.Zero || userTransform.scaleX <= 1f) return null
    val center = touchPointToContentPointF(Offset(viewport.width / 2f, viewport.height / 2f))
    return ArtifactImageViewpoint(
        userTransform.scaleX,
        center.x / size.width,
        center.y / size.height,
    )
}

private suspend fun ZoomableState.restoreViewpoint(point: ArtifactImageViewpoint) {
    val size = snapshotFlow {
        contentSize.takeIf { it != IntSize.Zero && containerSize != IntSize.Zero }
    }
        .filterNotNull()
        .first()
    locate(
        Offset(point.centerX * size.width, point.centerY * size.height),
        targetScale = minScale * point.scale,
    )
}

@Composable
private fun ImageViewport(
    image: Painter?,
    description: String?,
    zoom: ZoomState,
    imageSize: ConstraintsSizeResolver,
    @StringRes problem: Int?,
    loading: Boolean,
    previewOnly: Boolean,
    saveResult: ArtifactSaveResult?,
    shareSnackbar: SnackbarHostState,
    modifier: Modifier,
) {
    BoxWithConstraints(
        modifier.fillMaxWidth().clipToBounds().testTag("artifact_preview_surface"),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.fillMaxSize().padding(16.dp).then(imageSize)) {
            if (image != null) ZoomableArtifactImage(image, description, zoom)
        }
        if (image == null && problem != null) {
            ContentReadFailure(problem, Modifier.fillMaxSize())
        } else if (image == null && loading) {
            val skeletonWidth =
                minOf(
                    260.dp,
                    maxWidth * .75f,
                    maxHeight * .55f,
                    ((maxHeight - 72.dp).coerceAtLeast(0.dp)) * (4f / 3f),
                )
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Spacer(
                    Modifier.width(skeletonWidth)
                        .height(skeletonWidth * .75f)
                        .background(
                            MaterialTheme.colorScheme.surfaceContainerHigh,
                            RoundedCornerShape(8.dp),
                        ),
                )
                Text(
                    stringResource(R.string.artifact_image_loading),
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        val feedback =
            when (saveResult) {
                ArtifactSaveResult.Saving -> R.string.artifact_saving
                ArtifactSaveResult.Saved -> R.string.artifact_saved
                ArtifactSaveResult.Denied -> R.string.artifact_save_denied
                ArtifactSaveResult.Failed -> R.string.artifact_save_failed
                null ->
                    if (image != null) {
                        problem ?: R.string.artifact_preview_only.takeIf { previewOnly }
                    } else null
            }
        if (feedback != null) {
            Surface(
                modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                contentColor = MaterialTheme.colorScheme.onSurface,
                shape = RoundedCornerShape(4.dp),
            ) {
                Text(
                    stringResource(feedback),
                    Modifier.padding(horizontal = 12.dp, vertical = 8.dp).semantics {
                        liveRegion = LiveRegionMode.Polite
                    },
                    textAlign = TextAlign.Center,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
        SnackbarHost(shareSnackbar, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
private fun ZoomableArtifactImage(
    image: Painter,
    description: String?,
    zoom: ZoomState,
) {
    val zoomIn = stringResource(R.string.artifact_image_zoom_in)
    val zoomOut = stringResource(R.string.artifact_image_zoom_out)
    val reset = stringResource(R.string.artifact_image_fit)
    val focus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    val zoomable = zoom.zoomable
    val reducedMotion = scope.coroutineContext[MotionDurationScale]?.scaleFactor == 0f
    val zoomed = zoomable.userTransform.scaleX > 1f
    fun changeScale(target: Float) {
        scope.launch { zoomable.scale(target, animated = true) }
    }
    fun increase() =
        changeScale(
            if (zoomable.transform.scaleX < zoomable.mediumScale) zoomable.mediumScale
            else zoomable.maxScale,
        )
    fun decrease() =
        changeScale(
            if (zoomable.transform.scaleX > zoomable.mediumScale) zoomable.mediumScale
            else zoomable.minScale,
        )
    LaunchedEffect(focus) { focus.requestFocus() }
    ZoomImage(
        painter = image,
        contentDescription = description,
        modifier =
            Modifier.fillMaxSize()
                .focusRequester(focus)
                .testTag("artifact_image_transform")
                .onPreviewKeyEvent { event ->
                    if (event.type != KeyEventType.KeyDown) return@onPreviewKeyEvent false
                    when (event.key) {
                        Key.Plus,
                        Key.Equals,
                        Key.NumPadAdd -> increase()
                        Key.Minus,
                        Key.NumPadSubtract -> decrease()
                        Key.Zero,
                        Key.NumPad0 -> changeScale(zoomable.minScale)
                        else -> return@onPreviewKeyEvent false
                    }
                    true
                }
                .then(if (zoomed) Modifier.keyZoom(zoomable) else Modifier)
                .then(if (reducedMotion) Modifier.suppressImageReleaseFling(zoomable) else Modifier)
                .focusable()
                .semantics {
                    customActions = buildList {
                        if (zoomable.transform.scaleX < zoomable.maxScale) {
                            add(
                                CustomAccessibilityAction(zoomIn) {
                                    increase()
                                    true
                                },
                            )
                        }
                        if (zoomed) {
                            add(
                                CustomAccessibilityAction(zoomOut) {
                                    decrease()
                                    true
                                },
                            )
                            add(
                                CustomAccessibilityAction(reset) {
                                    changeScale(zoomable.minScale)
                                    true
                                },
                            )
                        }
                    }
                },
        zoomState = zoom,
        scrollBar = null,
    )
}

private fun Modifier.suppressImageReleaseFling(zoomable: ZoomableState): Modifier =
    pointerInput(zoomable) {
        val gestures = zoomable.disabledGestureTypes
        try {
            awaitEachGesture {
                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                zoomable.setDisabledGestureTypes(gestures)
                do {
                    val event = awaitPointerEvent(PointerEventPass.Initial)
                } while (event.changes.any { it.pressed })
                // ZoomImage checks drag support again at release before starting its decay.
                zoomable.setDisabledGestureTypes(gestures or GestureType.ONE_FINGER_DRAG)
            }
        } finally {
            zoomable.setDisabledGestureTypes(gestures)
        }
    }
