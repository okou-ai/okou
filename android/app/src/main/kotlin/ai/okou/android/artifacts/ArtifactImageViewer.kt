package ai.okou.android.artifacts

import ai.okou.android.ContentReadFailure
import ai.okou.android.ContentReadFeedbackDelayMillis
import ai.okou.android.R
import ai.okou.android.rememberContentReadFeedbackAfter
import ai.okou.android.state.ArtifactImageViewerState
import ai.okou.android.state.rememberArtifactImageViewerState
import androidx.annotation.StringRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.focusable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.key.*
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

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
    onSource: (() -> Unit)?,
    restoreSourceFocus: Boolean,
    onSourceFocusRestored: () -> Unit,
) {
    val transform = rememberArtifactImageViewerState()
    val original = (preview.content as? ArtifactContent.Image)?.bitmap
    val unavailable =
        preview.problem == ArtifactProblem.Denied ||
            preview.problem == ArtifactProblem.Missing ||
            preview.problem == ArtifactProblem.Unavailable
    val thumbnailUrl =
        (preview.item?.thumbnail ?: (preview.info?.resource as? ArtifactResource.File)?.cover)
            .takeIf { original == null && preview.access != null && !unavailable }
    val thumbnail = thumbnailUrl?.let { url ->
        key(model, url) {
            val result by
                produceState<android.graphics.Bitmap?>(null) {
                    value = model.thumbnail(url)
                }
            result
        }
    }
    val bitmap = (original ?: thumbnail).takeUnless { unavailable }
    val image = remember(bitmap) { bitmap?.asImageBitmap() }
    val problem =
        when {
            unavailable -> R.string.artifact_image_unavailable
            preview.problem != null || preview.content == ArtifactContent.Unsupported ->
                R.string.artifact_image_load_failed
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
                { transform.expanded = !fullWindow },
                saveEnabled,
                onSave,
                onSource,
                restoreSourceFocus,
                onSourceFocusRestored,
            )
            ImageViewport(
                image,
                preview.item?.title,
                transform,
                problem,
                loading,
                preview.access?.previewOnly == true,
                saveResult,
                Modifier.weight(1f),
            )
        }
    }
    if (wide && transform.expanded) {
        Dialog(
            onDismissRequest = { transform.expanded = false },
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
    onSource: (() -> Unit)?,
    restoreSourceFocus: Boolean,
    onSourceFocusRestored: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val actionsFocus = remember { FocusRequester() }
    val hasActions = onSave != null || onSource != null
    LaunchedEffect(restoreSourceFocus, hasActions) {
        if (restoreSourceFocus && hasActions) {
            actionsFocus.requestFocus()
            onSourceFocusRestored()
        }
    }
    Row(
        Modifier.fillMaxWidth()
            .height(64.dp)
            .padding(horizontal = 12.dp)
            .testTag("artifact_image_toolbar"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        ImageViewerButton(R.drawable.ic_arrow_back, backLabel, onBack)
        Spacer(Modifier.weight(1f))
        if (wide) {
            ImageViewerButton(
                if (expanded) R.drawable.ic_close_fullscreen else R.drawable.ic_open_in_full,
                if (expanded) R.string.artifact_image_collapse else R.string.artifact_image_expand,
                onExpand,
            )
        }
        Box {
            if (hasActions) {
                ImageViewerButton(
                    R.drawable.ic_more_vert,
                    R.string.artifact_image_actions,
                    { menu = true },
                    Modifier.focusRequester(actionsFocus),
                )
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (onSave != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.artifact_save)) },
                            enabled = saveEnabled,
                            onClick = {
                                menu = false
                                onSave()
                            },
                        )
                    }
                    if (onSource != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.artifact_view_source)) },
                            onClick = {
                                menu = false
                                onSource()
                            },
                        )
                    }
                }
            } else {
                Spacer(Modifier.size(48.dp))
            }
        }
    }
}

@Composable
private fun ImageViewerButton(
    @androidx.annotation.DrawableRes icon: Int,
    @StringRes label: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    IconButton(onClick = onClick, modifier = modifier.size(48.dp)) {
        Icon(
            painterResource(icon),
            stringResource(label),
            Modifier.size(24.dp),
            tint = MaterialTheme.colorScheme.onSurface,
        )
    }
}

@Composable
private fun ImageViewport(
    image: androidx.compose.ui.graphics.ImageBitmap?,
    description: String?,
    transform: ArtifactImageViewerState,
    @StringRes problem: Int?,
    loading: Boolean,
    previewOnly: Boolean,
    saveResult: ArtifactSaveResult?,
    modifier: Modifier,
) {
    BoxWithConstraints(
        modifier.fillMaxWidth().clipToBounds().testTag("artifact_preview_surface"),
        contentAlignment = Alignment.Center,
    ) {
        if (image != null) {
            val density = LocalDensity.current
            val viewport = with(density) { Size(maxWidth.toPx(), maxHeight.toPx()) }
            val available =
                with(density) {
                    Size(
                        (maxWidth - 32.dp).coerceAtLeast(0.dp).toPx(),
                        (maxHeight - 32.dp).coerceAtLeast(0.dp).toPx(),
                    )
                }
            val scale = minOf(available.width / image.width, available.height / image.height)
            if (scale > 0f) {
                ZoomableArtifactImage(
                    image,
                    description,
                    transform,
                    viewport,
                    Size(image.width * scale, image.height * scale),
                )
            }
        } else if (problem != null) {
            ContentReadFailure(problem, Modifier.fillMaxSize())
        } else if (loading) {
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
                            MaterialTheme.colorScheme.surfaceVariant,
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
    }
}

@Composable
private fun ZoomableArtifactImage(
    image: androidx.compose.ui.graphics.ImageBitmap,
    description: String?,
    transform: ArtifactImageViewerState,
    viewport: Size,
    fit: Size,
) {
    val zoomIn = stringResource(R.string.artifact_image_zoom_in)
    val zoomOut = stringResource(R.string.artifact_image_zoom_out)
    val reset = stringResource(R.string.artifact_image_fit)
    val focus = remember { FocusRequester() }
    val center = Offset(viewport.width / 2, viewport.height / 2)
    fun change(zoom: Float, pan: Offset = Offset.Zero, origin: Offset = center) {
        transform.change(zoom, pan, origin, viewport, fit)
    }
    LaunchedEffect(focus) { focus.requestFocus() }
    Box(
        Modifier.fillMaxSize()
            .focusRequester(focus)
            .testTag("artifact_image_transform")
            .onKeyEvent { event ->
                if (event.type != KeyEventType.KeyDown) return@onKeyEvent false
                when (event.key) {
                    Key.Plus,
                    Key.Equals,
                    Key.NumPadAdd -> change(2f)
                    Key.Minus,
                    Key.NumPadSubtract -> change(.5f)
                    Key.Zero,
                    Key.NumPad0 -> change(1f / transform.scale)
                    else -> return@onKeyEvent false
                }
                true
            }
            .focusable()
            .semantics {
                customActions = buildList {
                    if (transform.scale < 8f) {
                        add(
                            CustomAccessibilityAction(zoomIn) {
                                change(2f)
                                true
                            },
                        )
                    }
                    if (transform.scale > 1f) {
                        add(
                            CustomAccessibilityAction(zoomOut) {
                                change(.5f)
                                true
                            },
                        )
                        add(
                            CustomAccessibilityAction(reset) {
                                change(1f / transform.scale)
                                true
                            },
                        )
                    }
                }
            }
            .pointerInput(transform, viewport, fit) {
                detectTapGestures(
                    onDoubleTap = { tap ->
                        val zoom = if (transform.scale > 1f) 1f / transform.scale else 2f
                        change(zoom, origin = tap)
                    },
                )
            }
            .pointerInput(transform, viewport, fit) {
                detectTransformGestures { centroid, pan, zoom, _ -> change(zoom, pan, centroid) }
            },
        contentAlignment = Alignment.Center,
    ) {
        Image(
            image,
            description,
            Modifier.fillMaxSize().padding(16.dp).graphicsLayer {
                val translation = transform.translation(viewport, fit)
                scaleX = transform.scale
                scaleY = transform.scale
                translationX = translation.x
                translationY = translation.y
            },
            contentScale = ContentScale.Fit,
        )
    }
}
