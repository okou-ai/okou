package ai.okou.android.artifacts

import ai.okou.android.ContentReadFeedbackDelayMillis
import ai.okou.android.R
import ai.okou.android.WorkspaceFeedbackHost
import ai.okou.android.api.retryAfter
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.rememberContentReadFeedbackAfter
import ai.okou.android.state.rememberArtifactWebScroll
import ai.okou.android.workspaceSearchFocusOutline
import android.annotation.SuppressLint
import android.content.Context
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.MediaController
import android.widget.VideoView
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.hideFromAccessibility
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.delay
import okhttp3.HttpUrl

private const val PreviewAspectRatio = 16f / 9f
private val AudioPreviewHeight = 96.dp

/** One preview layout for catalog entries and future chat/search entry points. */
@Composable
internal fun ArtifactPreview(
    preview: ArtifactPreviewState?,
    position: ScrollState,
    wide: Boolean,
    source: ConfirmedChat?,
    restoreSourceFocus: Boolean,
    onSourceFocusRestored: () -> Unit,
    onSource: (ConfirmedChat) -> Unit,
    saveEnabled: Boolean,
    onSave: (ArtifactSave) -> Unit,
    saveResult: ArtifactSaveResult?,
    onShare: (() -> Unit)?,
    sharing: Boolean,
    shareSnackbar: SnackbarHostState,
    links: ArtifactLinkActions?,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val dates = rememberArtifactDates()
    val browser = LocalUriHandler.current
    val sourceFocus = remember { FocusRequester() }
    val websiteLinkFocus = remember { FocusRequester() }
    var websiteLinkFocused by remember { mutableStateOf(false) }
    var restoreWebsiteLinkFocus by remember { mutableStateOf(false) }
    var browserUnavailable by remember { mutableStateOf(false) }
    LaunchedEffect(source?.id, restoreSourceFocus) {
        if (source != null && restoreSourceFocus) {
            sourceFocus.requestFocus()
            onSourceFocusRestored()
        }
    }
    LaunchedEffect(links?.panelOpen) {
        if (links?.panelOpen == false && restoreWebsiteLinkFocus) {
            restoreWebsiteLinkFocus = false
            websiteLinkFocus.requestFocus()
        }
    }
    Box(
        modifier.fillMaxSize().testTag("artifact_preview"),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier.widthIn(max = 768.dp)
                .fillMaxWidth()
                .verticalScroll(position)
                .padding(
                    start = if (wide) 32.dp else 20.dp,
                    end = if (wide) 32.dp else 20.dp,
                    top = 16.dp,
                    bottom = 24.dp,
                ),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            val item = preview?.item
            if (item != null) {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(
                            item.title,
                            Modifier.semantics { heading() }.testTag("artifact_preview_title"),
                            style = MaterialTheme.typography.titleLarge,
                            color = colors.onSurface,
                        )
                        val kind = stringResource(item.kind.label())
                        val metadata =
                            item.createdAt?.let {
                                stringResource(
                                    R.string.artifact_metadata,
                                    kind,
                                    dates.timestamp(it, showDay = true),
                                )
                            } ?: kind
                        Text(
                            if (preview.access?.previewOnly == true)
                                stringResource(
                                    R.string.artifact_metadata,
                                    metadata,
                                    stringResource(R.string.artifact_preview_only),
                                )
                            else metadata,
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                        )
                        source
                            ?.title
                            ?.takeIf { it.isNotBlank() }
                            ?.let { title ->
                                Text(
                                    stringResource(R.string.artifact_source_name, title),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = colors.onSurfaceVariant,
                                )
                            }
                    }
                    if (links != null) ArtifactOverflowMenu(R.string.artifact_more_actions, links)
                }
            }
            val save = preview?.access?.save
            val browserUrl = preview?.info?.browserUrl
            val reserveBrowserAction =
                browserUrl != null || preview?.info?.resource is ArtifactResource.Site
            val openWebsiteLink = links?.openWebsiteLink
            if (source != null || save != null || reserveBrowserAction || openWebsiteLink != null) {
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (source != null) {
                        ArtifactAction(
                            R.string.artifact_view_source,
                            icon = R.drawable.ic_chevron_right,
                            modifier = Modifier.focusRequester(sourceFocus),
                        ) {
                            onSource(source)
                        }
                    }
                    if (save != null) {
                        if (onShare != null) {
                            ArtifactAction(
                                R.string.artifact_share_file,
                                icon = R.drawable.ic_share,
                                enabled = saveEnabled,
                                onClick = onShare,
                            )
                        }
                        ArtifactAction(
                            R.string.artifact_save,
                            icon = R.drawable.ic_download,
                            enabled = saveEnabled,
                        ) {
                            onSave(save)
                        }
                    }
                    if (openWebsiteLink != null) {
                        ArtifactAction(
                            R.string.artifact_share_link,
                            icon = R.drawable.ic_share,
                            modifier =
                                Modifier.focusRequester(websiteLinkFocus).onFocusChanged {
                                    websiteLinkFocused = it.isFocused
                                },
                        ) {
                            restoreWebsiteLinkFocus = websiteLinkFocused
                            openWebsiteLink()
                        }
                    }
                    if (reserveBrowserAction) {
                        // Keep the preview in place while access is being checked.
                        KeepSpaceWhenHidden(visible = browserUrl != null) {
                            ArtifactAction(
                                R.string.artifact_open_website,
                                icon = R.drawable.ic_open_in_new,
                                enabled = browserUrl != null,
                            ) {
                                val destination = browserUrl ?: return@ArtifactAction
                                browserUnavailable =
                                    try {
                                        browser.openUri(destination.toString())
                                        false
                                    } catch (_: IllegalArgumentException) {
                                        true
                                    }
                            }
                        }
                    }
                    if (sharing) {
                        PreviewFeedback(
                            R.string.artifact_share_preparing,
                            Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            val feedback =
                when (saveResult) {
                    ArtifactSaveResult.Saving -> R.string.artifact_saving
                    ArtifactSaveResult.Saved -> R.string.artifact_saved
                    ArtifactSaveResult.Denied -> R.string.artifact_save_denied
                    ArtifactSaveResult.Failed -> R.string.artifact_save_failed
                    null -> R.string.artifact_browser_unavailable.takeIf { browserUnavailable }
                }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PreviewContent(preview)
                if (preview?.hasReadableContent == true) {
                    preview.problem?.let { PreviewFeedback(it.previewLabel()) }
                }
                if (feedback != null) {
                    KeepSpaceWhenHidden(visible = saveResult != null || browserUrl != null) {
                        PreviewFeedback(feedback)
                    }
                }
            }
        }
        ArtifactActionFeedback(shareSnackbar, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
internal fun ArtifactActionFeedback(state: SnackbarHostState, modifier: Modifier = Modifier) {
    Box(modifier) {
        WorkspaceFeedbackHost(
            state,
            Modifier.padding(bottom = 8.dp),
            surfaceModifier = Modifier.testTag("artifact_action_feedback"),
        )
    }
}

@Composable
private fun PreviewFeedback(@StringRes label: Int, modifier: Modifier = Modifier) {
    Text(
        stringResource(label),
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Keep the scroll range stable while access to browser controls is being checked. */
@Composable
private fun KeepSpaceWhenHidden(visible: Boolean, content: @Composable () -> Unit) {
    if (visible) {
        content()
    } else {
        Layout(
            content = content,
            modifier = Modifier.clearAndSetSemantics { hideFromAccessibility() },
        ) { measurables, constraints ->
            val child = measurables.single().measure(constraints)
            layout(child.width, child.height) {}
        }
    }
}

@Composable
private fun ArtifactAction(
    @StringRes label: Int,
    @DrawableRes icon: Int,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    OutlinedButton(
        onClick = onClick,
        modifier =
            modifier
                .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                .workspaceSearchFocusOutline(ButtonDefaults.outlinedShape),
        enabled = enabled,
        contentPadding = ButtonDefaults.ButtonWithIconContentPadding,
    ) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(ButtonDefaults.IconSpacing),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(painterResource(icon), null, Modifier.size(ButtonDefaults.IconSize))
            Text(stringResource(label))
        }
    }
}

@Composable
private fun PreviewContent(preview: ArtifactPreviewState?) {
    val content = preview?.content
    val problem = preview?.problem
    val hosted = preview?.isHosted == true
    val imageStatus = preview?.isImage == true && content !is ArtifactContent.Image
    val documentUrl = (content as? ArtifactContent.Website)?.url
    var documentVisible by remember(documentUrl) { mutableStateOf(false) }
    val waitingForDocument = documentUrl != null && !documentVisible
    val waiting = problem == null && (content == null || waitingForDocument)
    val showLoading =
        key(preview?.id.takeIf { imageStatus }) {
            rememberContentReadFeedbackAfter(ContentReadFeedbackDelayMillis.takeIf { waiting })
        }
    if (!hosted && !imageStatus && waiting && !showLoading) return
    val colors = MaterialTheme.colorScheme
    val documentSurface = content is ArtifactContent.Text || content is ArtifactContent.Image
    Surface(
        Modifier.fillMaxWidth()
            .then(if (hosted) Modifier.aspectRatio(PreviewAspectRatio) else Modifier)
            .testTag("artifact_preview_surface"),
        shape = RoundedCornerShape(16.dp),
        color =
            when {
                hosted -> colors.surfaceVariant
                showLoading -> colors.surfaceContainerHigh
                documentSurface -> colors.surface
                else -> colors.surfaceVariant
            },
        border = BorderStroke(1.dp, colors.outlineVariant),
    ) {
        if (hosted) {
            HostedPreviewContent(content, problem, showLoading) { documentVisible = true }
        } else {
            when (content) {
                is ArtifactContent.Text ->
                    SelectionContainer(Modifier.padding(16.dp)) {
                        ProvideTextStyle(
                            MaterialTheme.typography.bodyLarge.copy(
                                lineHeight = if (content.markdown) 28.sp else 24.sp,
                            ),
                        ) {
                            Text(content.rendered)
                        }
                    }
                is ArtifactContent.Image ->
                    Box(
                        Modifier.fillMaxWidth().padding(16.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        val bitmap = remember(content) { content.bitmap.asImageBitmap() }
                        Image(
                            bitmap,
                            preview.item?.title,
                            Modifier.sizeIn(maxWidth = 440.dp, maxHeight = 440.dp),
                            contentScale = ContentScale.Fit,
                        )
                    }
                is ArtifactContent.Media -> key(content.url) { MediaArtifactPreview(content) }
                else ->
                    when {
                        imageStatus -> ImagePreviewStatus(content, problem, showLoading)
                        problem != null -> PreviewStatus(problem.previewLabel())
                        content == ArtifactContent.Unsupported ->
                            PreviewStatus(R.string.artifact_preview_unsupported)
                        else -> PreviewStatusFrame(ratio = true) { PreviewLoading() }
                    }
            }
        }
    }
}

@Composable
private fun ImagePreviewStatus(
    content: ArtifactContent?,
    problem: ArtifactProblem?,
    showLoading: Boolean,
) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        Box(
            Modifier.fillMaxWidth()
                .heightIn(min = maxOf(112.dp, maxWidth / PreviewAspectRatio))
                .padding(horizontal = 16.dp),
            contentAlignment = Alignment.Center,
        ) {
            val label =
                when {
                    problem == ArtifactProblem.Denied || problem == ArtifactProblem.Missing ->
                        R.string.artifact_image_unavailable
                    problem != null || content == ArtifactContent.Unsupported ->
                        R.string.artifact_preview_unavailable
                    showLoading -> R.string.artifact_preview_loading
                    else -> null
                }
            if (label != null) PreviewStatusText(label)
        }
    }
}

@Composable
private fun HostedPreviewContent(
    content: ArtifactContent?,
    problem: ArtifactProblem?,
    showLoading: Boolean,
    onDocumentVisible: () -> Unit,
) {
    var siteScroll by rememberArtifactWebScroll()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val inset = if (maxWidth >= 600.dp) 32.dp else 16.dp
        Box(Modifier.fillMaxSize().padding(inset), contentAlignment = Alignment.Center) {
            when {
                problem != null -> PreviewStatusText(problem.previewLabel())
                content is ArtifactContent.Website ->
                    key(content.url) {
                        HostedArtifactPreview(
                            content,
                            siteScroll,
                            showLoading,
                            onScroll = { siteScroll = it },
                            onVisible = onDocumentVisible,
                        )
                    }
                content == ArtifactContent.Unsupported ->
                    PreviewStatusText(R.string.artifact_preview_unsupported)
                showLoading -> PreviewLoading()
            }
        }
    }
}

@Composable
private fun PreviewLoading() {
    PreviewStatusText(
        R.string.artifact_preview_loading,
        Modifier.testTag("artifact_preview_loading"),
    )
}

@Composable
private fun PreviewStatus(@StringRes label: Int, ratio: Boolean = true) {
    PreviewStatusFrame(ratio) { PreviewStatusText(label) }
}

@Composable
private fun PreviewStatusFrame(ratio: Boolean, content: @Composable BoxScope.() -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val height = if (ratio) maxWidth / PreviewAspectRatio else AudioPreviewHeight
        val inset = if (maxWidth >= 600.dp) 32.dp else 16.dp
        Box(
            Modifier.fillMaxWidth().heightIn(min = height).padding(inset),
            contentAlignment = Alignment.Center,
            content = content,
        )
    }
}

@Composable
private fun PreviewStatusText(@StringRes label: Int, modifier: Modifier = Modifier) {
    Text(
        stringResource(label),
        modifier.semantics { liveRegion = LiveRegionMode.Polite },
        textAlign = TextAlign.Center,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@StringRes
private fun ArtifactProblem.previewLabel(): Int =
    when (this) {
        ArtifactProblem.Denied -> R.string.artifact_access_denied
        ArtifactProblem.Missing -> R.string.artifact_preview_source_unavailable
        ArtifactProblem.OriginalUnavailable -> R.string.artifact_image_original_unavailable
        ArtifactProblem.Unsupported -> R.string.artifact_preview_unsupported
        ArtifactProblem.Temporary,
        ArtifactProblem.Unavailable -> R.string.artifact_preview_unavailable
    }

@Composable
private fun HostedArtifactPreview(
    content: ArtifactContent.Website,
    scrollY: Int,
    showLoading: Boolean,
    onScroll: (Int) -> Unit,
    onVisible: () -> Unit,
) {
    var usedRetries by remember { mutableIntStateOf(0) }
    key(usedRetries) {
        val attempt = remember { HostedDocumentAttempt() }
        val failure = attempt.failure
        val remainingRetries = content.remainingRetries - usedRetries
        when {
            failure == null -> {
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = {
                        val initialScroll = scrollY
                        var scrolled = false
                        isolatedPreview(
                                it,
                                content.url,
                                onFailure = attempt::recordFailure,
                                onVisible = { view ->
                                    if (attempt.active) {
                                        view.alpha = 1f
                                        onVisible()
                                    }
                                },
                                onLoaded = { view ->
                                    if (attempt.active && !scrolled) {
                                        view.scrollTo(0, initialScroll)
                                    }
                                },
                            )
                            .apply {
                                setOnScrollChangeListener { _, _, y, _, previousY ->
                                    if (attempt.active && y != previousY) {
                                        scrolled = true
                                        onScroll(y)
                                    }
                                }
                            }
                    },
                    onRelease = {
                        attempt.release()
                        it.destroy()
                    },
                    update = {},
                )
                if (showLoading) PreviewLoading()
            }
            failure.problem == ArtifactProblem.Temporary && remainingRetries > 0 -> {
                val lifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(lifecycle) {
                    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        delay(artifactRetryDelayMillis(remainingRetries, failure.retryAfterSeconds))
                        usedRetries++
                    }
                }
                if (showLoading) PreviewLoading()
            }
            else -> PreviewStatusText(failure.problem.previewLabel())
        }
    }
}

private data class HostedDocumentFailure(
    val problem: ArtifactProblem,
    val retryAfterSeconds: Long? = null,
)

private class HostedDocumentAttempt {
    var failure by mutableStateOf<HostedDocumentFailure?>(null)
        private set

    private var released = false

    val active: Boolean
        get() = !released && failure == null

    fun recordFailure(failure: HostedDocumentFailure) {
        if (active) this.failure = failure
    }

    fun release() {
        released = true
    }
}

// Hosted content runs on its server-authorized HTTPS origin. It receives no app token,
// local file access, native bridge, or cross-origin top-level navigation.
@SuppressLint("SetJavaScriptEnabled")
private fun isolatedPreview(
    context: Context,
    url: HttpUrl,
    onFailure: (HostedDocumentFailure) -> Unit,
    onVisible: (WebView) -> Unit,
    onLoaded: (WebView) -> Unit,
): WebView =
    WebView(context).apply {
        // Leave the themed frame visible until WebView can draw its first document.
        alpha = 0f
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptEnabled = true
        webViewClient =
            object : WebViewClient() {
                private val initialAddress = url.toString().substringBefore('#')
                private var openingDocument = true
                private var needsScrollRestore = true

                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest,
                ): Boolean {
                    if (request.isForMainFrame && !request.isRedirect) openingDocument = false
                    val next = request.url
                    val port = if (next.port == -1) 443 else next.port
                    return request.isForMainFrame &&
                        (next.scheme != "https" || next.host != url.host || port != url.port)
                }

                override fun onReceivedError(
                    view: WebView,
                    request: WebResourceRequest,
                    error: WebResourceError,
                ) {
                    val temporary =
                        when (error.errorCode) {
                            ERROR_HOST_LOOKUP,
                            ERROR_CONNECT,
                            ERROR_IO,
                            ERROR_TIMEOUT -> true
                            else -> false
                        }
                    reportFailure(
                        request,
                        if (temporary) ArtifactProblem.Temporary else ArtifactProblem.Unavailable,
                    )
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    response: WebResourceResponse,
                ) {
                    val retryAfterHeader =
                        response.responseHeaders
                            ?.entries
                            ?.firstOrNull { it.key.equals("Retry-After", ignoreCase = true) }
                            ?.value
                    reportFailure(
                        request,
                        artifactHttpProblem(response.statusCode),
                        retryAfterHeader,
                    )
                }

                override fun onRenderProcessGone(
                    view: WebView,
                    detail: RenderProcessGoneDetail,
                ): Boolean {
                    onFailure(HostedDocumentFailure(ArtifactProblem.Unavailable))
                    return true
                }

                override fun onPageCommitVisible(view: WebView, address: String) {
                    openingDocument = false
                    onVisible(view)
                }

                override fun onPageFinished(view: WebView, address: String) {
                    openingDocument = false
                    if (needsScrollRestore) {
                        needsScrollRestore = false
                        onLoaded(view)
                    }
                }

                private fun reportFailure(
                    request: WebResourceRequest,
                    problem: ArtifactProblem,
                    retryAfterHeader: String? = null,
                ) {
                    if (!request.isForMainFrame) return
                    // Only the app's original GET is safe to replay, before the hosted page is
                    // shown.
                    val retry =
                        openingDocument &&
                            request.method == "GET" &&
                            request.url.toString().substringBefore('#') == initialAddress
                    openingDocument = false
                    onFailure(
                        if (!retry && problem == ArtifactProblem.Temporary)
                            HostedDocumentFailure(ArtifactProblem.Unavailable)
                        else HostedDocumentFailure(problem, retryAfter(retryAfterHeader)),
                    )
                }
            }
        loadUrl(url.toString())
    }

@Composable
private fun MediaArtifactPreview(content: ArtifactContent.Media) {
    var playRequested by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    if (failed) {
        PreviewStatus(R.string.artifact_preview_unavailable, ratio = content.video)
    } else if (!playRequested) {
        PreviewStatusFrame(ratio = content.video) {
            ArtifactAction(R.string.artifact_play, icon = R.drawable.ic_play_arrow) {
                playRequested = true
            }
        }
    } else {
        var player by remember { mutableStateOf<VideoView?>(null) }
        val lifecycle = LocalLifecycleOwner.current.lifecycle
        LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) { player?.pause() }
        val playbackLabel = stringResource(R.string.artifact_play_media)
        AndroidView(
            modifier =
                Modifier.fillMaxWidth()
                    .then(
                        if (content.video) Modifier.aspectRatio(PreviewAspectRatio)
                        else Modifier.height(AudioPreviewHeight),
                    ),
            factory = { context ->
                VideoView(context).apply {
                    contentDescription = playbackLabel
                    setMediaController(MediaController(context))
                    setOnErrorListener { _, _, _ ->
                        failed = true
                        true
                    }
                    setVideoURI(content.url.toString().toUri())
                    // The Play action may have scheduled this frame before the activity paused.
                    if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) start()
                    player = this
                }
            },
            onRelease = {
                it.stopPlayback()
                player = null
            },
            update = {},
        )
    }
}
