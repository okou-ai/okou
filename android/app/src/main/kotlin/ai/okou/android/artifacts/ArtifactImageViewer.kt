package ai.okou.android.artifacts

import ai.okou.android.ContentReadFailure
import ai.okou.android.ContentReadFeedbackDelayMillis
import ai.okou.android.R
import ai.okou.android.WorkspaceMenuItem
import ai.okou.android.rememberContentReadFeedbackAfter
import ai.okou.android.state.ArtifactImageViewerState
import ai.okou.android.state.ArtifactImageViewpoint
import ai.okou.android.state.rememberArtifactImageViewerState
import android.graphics.Bitmap
import android.view.WindowManager.LayoutParams.FLAG_DIM_BEHIND
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.Image
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
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
import com.github.panpf.zoomimage.subsampling.fromFile
import com.github.panpf.zoomimage.util.IntSizeCompat
import com.github.panpf.zoomimage.zoom.ContentScaleCompat
import com.github.panpf.zoomimage.zoom.GestureType
import com.github.panpf.zoomimage.zoom.ScalesCalculator
import java.io.File
import kotlin.math.roundToInt
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
    ImageViewerSurface(
        wide,
        viewer.expanded,
        { viewer.expanded = it },
        onBack,
        toolbar = { fullWindow, toggle ->
            ImageViewerToolbar(
                backLabel,
                onBack,
                wide,
                fullWindow,
                toggle,
                saveEnabled,
                onSave,
                onShare,
                sharing,
                onSource,
                links,
                restoreSourceFocus,
                onSourceFocusRestored,
            )
        },
    ) { modifier ->
        ImageViewerPage(
            preview,
            model,
            preview.item?.title,
            zoom,
            viewer,
            modifier,
            saveResult = saveResult,
            shareSnackbar = shareSnackbar,
        )
    }
}

@Composable
internal fun ImageViewerSurface(
    wide: Boolean,
    expanded: Boolean,
    setExpanded: (Boolean) -> Unit,
    onBack: () -> Unit,
    overlayStart: Dp? = null,
    toolbar: @Composable (Boolean, () -> Unit) -> Unit,
    content: @Composable (Modifier) -> Unit,
) {
    val fullWindow = wide && expanded
    val pane: @Composable () -> Unit = {
        Column(
            Modifier.fillMaxSize()
                .background(MaterialTheme.colorScheme.surface)
                .testTag("artifact_preview"),
        ) {
            toolbar(fullWindow) { setExpanded(!fullWindow) }
            content(Modifier.weight(1f))
        }
    }
    if (overlayStart != null || fullWindow) {
        Dialog(
            onDismissRequest = { if (fullWindow) setExpanded(false) else onBack() },
            properties =
                DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
        ) {
            val window = (LocalView.current.parent as? DialogWindowProvider)?.window
            SideEffect { window?.clearFlags(FLAG_DIM_BEHIND) }
            Box(
                Modifier.fillMaxSize()
                    .padding(start = overlayStart?.takeUnless { fullWindow } ?: 0.dp)
                    .background(MaterialTheme.colorScheme.surface)
                    .windowInsetsPadding(WindowInsets.safeDrawing),
            ) {
                pane()
            }
        }
    } else {
        pane()
    }
}

@Composable
internal fun ImageViewerPage(
    preview: ArtifactPreviewState?,
    model: ArtifactCatalogModel?,
    description: String?,
    zoom: ZoomState?,
    viewer: ArtifactImageViewerState?,
    modifier: Modifier,
    localFile: File? = null,
    thumbnail: Bitmap? = null,
    unavailableLocal: Boolean = false,
    keyboardPaging: Boolean = false,
    saveResult: ArtifactSaveResult? = null,
    shareSnackbar: SnackbarHostState? = null,
) {
    val imageSize = rememberConstraintsSizeResolver()
    val adjacent = zoom == null
    val showEarlySkeleton = remember { adjacent }
    val unavailable = unavailableLocal || preview?.problem.isImageUnavailable
    val originalUnavailable = preview?.problem == ArtifactProblem.OriginalUnavailable
    val source = (preview?.content as? ArtifactContent.EncodedImage).takeUnless { unavailable }
    val bitmap = (preview?.content as? ArtifactContent.Image)?.bitmap ?: source?.fallback
    val data =
        (source?.bytes ?: localFile).takeUnless { adjacent || unavailable || originalUnavailable }
    val decoded = data?.let { rememberDecodedViewerImage(it, imageSize) }
    val original = decoded as? AsyncImagePainter.State.Success
    val independentThumbnail =
        preview?.info?.independentThumbnailUrl(preview.access?.url?.toString())
    val thumbnailUrl =
        if (
            bitmap == null &&
                thumbnail == null &&
                original == null &&
                !unavailable &&
                !originalUnavailable
        ) {
            independentThumbnail ?: preview?.info?.thumbnailUrl?.takeIf { preview.access != null }
        } else null
    val readThumbnail =
        thumbnailUrl
            ?.takeIf { model != null }
            ?.let { url ->
                key(model, url) {
                    val cacheOnly = independentThumbnail == null
                    val result by
                        produceState<Bitmap?>(null, cacheOnly) {
                            value = model?.thumbnail(url, cacheOnly)
                        }
                    result
                }
            }
    val fallback =
        (bitmap ?: (thumbnail ?: readThumbnail).takeUnless { originalUnavailable }).takeUnless {
            unavailable
        }
    val fallbackPainter = remember(fallback) { fallback?.let { BitmapPainter(it.asImageBitmap()) } }
    val image = original?.painter ?: fallbackPainter
    val emptyPageFocus =
        if (keyboardPaging && !adjacent && image == null) {
            val focus = remember { FocusRequester() }
            LaunchedEffect(focus) { focus.requestFocus() }
            Modifier.focusRequester(focus).focusable()
        } else Modifier

    val tileSource =
        remember(data) {
            when (data) {
                is ByteArray -> ImageSource.fromByteArray(data)
                is File -> ImageSource.fromFile(data)
                else -> null
            }
        }
    if (zoom != null)
        LaunchedEffect(zoom, data, original) {
            zoom.setSubsamplingImage(tileSource.takeIf { original != null })
            val decodedBitmap = (original?.result?.image as? BitmapImage)?.bitmap
            if (preview != null && source != null && decodedBitmap != null)
                model?.retainDecodedImage(preview.id, source, decodedBitmap)
        }
    val problem =
        when {
            unavailable -> R.string.artifact_image_unavailable
            originalUnavailable ->
                if (image != null) R.string.artifact_image_original_unavailable else null
            preview?.problem != null ||
                preview?.content == ArtifactContent.Unsupported ||
                decoded is AsyncImagePainter.State.Error && (source != null || model == null) ->
                R.string.artifact_image_load_failed
            else -> null
        }
    val loading =
        rememberContentReadFeedbackAfter(
            ContentReadFeedbackDelayMillis.takeIf { !adjacent && image == null && problem == null },
        )
    ImageViewport(
        hasImage = image != null,
        problem = problem,
        skeleton = loading || adjacent || showEarlySkeleton,
        loadingLabel = loading,
        previewOnly = preview?.access?.previewOnly == true,
        saveResult = saveResult,
        shareSnackbar = shareSnackbar,
        modifier = modifier.then(emptyPageFocus),
    ) {
        val viewport = IntSize(constraints.maxWidth, constraints.maxHeight)
        Box(Modifier.fillMaxSize().then(imageSize)) {
            if (image != null && zoom != null && viewer != null) {
                ZoomableArtifactImage(
                    image,
                    description.takeUnless { unavailable },
                    zoom,
                    viewport,
                    viewer,
                )
            } else if (image != null) {
                Image(
                    image,
                    null,
                    Modifier.fillMaxSize().padding(16.dp),
                    contentScale = ContentScale.Fit,
                )
            }
        }
    }
}

internal val ArtifactProblem?.isImageUnavailable: Boolean
    get() =
        this == ArtifactProblem.Denied ||
            this == ArtifactProblem.Missing ||
            this == ArtifactProblem.Unavailable

internal data class ImageViewerPageNumber(val page: Int, val count: Int)

@Composable
internal fun ImageViewerToolbar(
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
    restoreSourceFocus: Boolean = false,
    onSourceFocusRestored: () -> Unit = {},
    pageNumber: ImageViewerPageNumber? = null,
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
        Box(Modifier.width(if (pageNumber != null && wide) 100.dp else 48.dp)) {
            ImageViewerButton(R.drawable.ic_arrow_back, backLabel, onBack)
        }
        Box(
            Modifier.weight(1f),
            contentAlignment = if (pageNumber != null) Alignment.Center else Alignment.CenterEnd,
        ) {
            if (pageNumber != null) {
                val spoken =
                    stringResource(
                        R.string.artifact_image_page_description,
                        pageNumber.page,
                        pageNumber.count,
                    )
                Text(
                    stringResource(
                        R.string.artifact_image_page_number,
                        pageNumber.page,
                        pageNumber.count,
                    ),
                    Modifier.padding(horizontal = 4.dp)
                        .clearAndSetSemantics {
                            contentDescription = spoken
                            liveRegion = LiveRegionMode.Polite
                        }
                        .testTag("image_viewer_page_number"),
                    style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"),
                    color = colors.onSurface,
                    textAlign = TextAlign.Center,
                )
            } else if (sharing) {
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
    IconButton(onClick = onClick) {
        Icon(
            painterResource(icon),
            stringResource(label),
            Modifier.size(24.dp),
            tint = tint,
        )
    }
}

@Composable
private fun rememberDecodedViewerImage(
    data: Any,
    size: ConstraintsSizeResolver,
): AsyncImagePainter.State? {
    val context = LocalContext.current
    val request =
        remember(context, data, size) {
            ImageRequest.Builder(context)
                .data(data)
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
        is AsyncImagePainter.State.Success -> result.takeIf { it.result.request.data == data }
        is AsyncImagePainter.State.Error -> result.takeIf { it.result.request.data == data }
        else -> null
    }
}

internal fun ZoomableState.viewpoint(): ArtifactImageViewpoint? {
    val size = contentSize
    val viewport = containerSize
    if (size == IntSize.Zero || viewport == IntSize.Zero || !isZoomed) return null
    val center = touchPointToContentPointF(Offset(viewport.width / 2f, viewport.height / 2f))
    return ArtifactImageViewpoint(
        transform.scaleX / minScale,
        center.x / size.width,
        center.y / size.height,
    )
}

internal val ZoomableState.isZoomed: Boolean
    get() = transform.scaleX > minScale * 1.001f

private suspend fun ZoomableState.restoreViewpoint(point: ArtifactImageViewpoint) {
    locate(
        Offset(point.centerX * contentSize.width, point.centerY * contentSize.height),
        targetScale = minScale * point.scale,
    )
}

private class InsetFitImageScales(private val inset: Int) :
    ScalesCalculator by ScalesCalculator.Dynamic {
    override fun calculateWithBase(
        containerSize: IntSizeCompat,
        contentSize: IntSizeCompat,
        contentOriginSize: IntSizeCompat,
        contentScale: ContentScaleCompat,
        baseScale: Float,
        initialScale: Float,
    ): ScalesCalculator.Result {
        val fitWidth = (containerSize.width - 2 * inset).coerceAtLeast(1)
        val fitHeight = (containerSize.height - 2 * inset).coerceAtLeast(1)
        val fit =
            minOf(fitWidth / contentSize.width.toFloat(), fitHeight / contentSize.height.toFloat())
        return ScalesCalculator.Dynamic.calculateWithBase(
            containerSize,
            contentSize,
            contentOriginSize,
            contentScale,
            baseScale = fit,
            initialScale = fit,
        )
    }
}

@Composable
private fun ImageViewport(
    hasImage: Boolean,
    @StringRes problem: Int?,
    skeleton: Boolean,
    loadingLabel: Boolean,
    previewOnly: Boolean,
    saveResult: ArtifactSaveResult?,
    shareSnackbar: SnackbarHostState?,
    modifier: Modifier,
    content: @Composable BoxWithConstraintsScope.() -> Unit,
) {
    BoxWithConstraints(
        modifier.fillMaxWidth().clipToBounds().testTag("artifact_preview_surface"),
        contentAlignment = Alignment.Center,
    ) {
        content()
        if (!hasImage && problem != null) {
            ContentReadFailure(problem, Modifier.fillMaxSize())
        } else if (!hasImage && skeleton) {
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
                    if (loadingLabel) Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                    else Modifier.alpha(0f).clearAndSetSemantics {},
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
                    if (hasImage) {
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
        if (shareSnackbar != null)
            SnackbarHost(shareSnackbar, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
private fun ZoomableArtifactImage(
    image: Painter,
    description: String?,
    zoom: ZoomState,
    viewport: IntSize,
    viewer: ArtifactImageViewerState,
) {
    val zoomIn = stringResource(R.string.artifact_image_zoom_in)
    val zoomOut = stringResource(R.string.artifact_image_zoom_out)
    val reset = stringResource(R.string.artifact_image_fit)
    val focus = remember { FocusRequester() }
    val scope = rememberCoroutineScope()
    val zoomable = zoom.zoomable
    val reducedMotion = scope.coroutineContext[MotionDurationScale]?.scaleFactor == 0f
    val zoomed = zoomable.isZoomed
    val inset = with(LocalDensity.current) { 16.dp.roundToPx() }
    val fitScales = remember(inset) { InsetFitImageScales(inset) }
    val imageDimensions =
        with(image.intrinsicSize) {
            if (isSpecified) IntSize(width.roundToInt(), height.roundToInt()) else IntSize.Zero
        }
    val previousPoint =
        remember(zoomable, viewport, imageDimensions, fitScales) {
            viewer.pendingViewpoint ?: zoomable.viewpoint()
        }
    LaunchedEffect(zoomable, viewport, imageDimensions, fitScales) {
        snapshotFlow {
            zoomable.containerSize == viewport && zoomable.contentSize == imageDimensions
        }
            .first { it }
        // Limit the fit scale while letting ZoomImage clip and pan within the full viewport.
        zoomable.setScalesCalculator(fitScales)
        if (previousPoint == null) zoomable.scale(zoomable.minScale)
        else zoomable.restoreViewpoint(previousPoint)
        viewer.pendingViewpoint = null
    }
    fun changeScale(target: Float) {
        scope.launch { zoomable.scale(target, animated = !reducedMotion) }
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
        contentDescription = null,
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
                    role = Role.Image
                    if (description != null) contentDescription = description
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
