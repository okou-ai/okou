package ai.okou.android.artifacts

import ai.okou.android.R
import ai.okou.android.chat.ConfirmedChat
import ai.okou.android.chat.HistoryMarkdown
import ai.okou.android.chat.rememberChatWaitIndicator
import ai.okou.android.state.rememberArtifactWebScroll
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
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
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
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.ProvideTextStyle
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

private const val HostedPreviewAspectRatio = 16f / 9f

/** One preview layout for catalog entries and future chat/search entry points. */
@Composable
internal fun ArtifactPreview(
    preview: ArtifactPreviewState?,
    position: ScrollState,
    wide: Boolean,
    offline: Boolean,
    source: ConfirmedChat?,
    restoreSourceFocus: Boolean,
    onSourceFocusRestored: () -> Unit,
    onSource: (ConfirmedChat) -> Unit,
    saveEnabled: Boolean,
    onSave: (ArtifactSave) -> Unit,
    saveResult: ArtifactSaveResult?,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val dates = rememberArtifactDates()
    val browser = LocalUriHandler.current
    val sourceFocus = remember { FocusRequester() }
    var browserUnavailable by remember { mutableStateOf(false) }
    LaunchedEffect(source?.id, restoreSourceFocus) {
        if (source != null && restoreSourceFocus) {
            sourceFocus.requestFocus()
            onSourceFocusRestored()
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
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
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
                    if (source != null) {
                        val title =
                            source.title?.takeIf { it.isNotBlank() }
                                ?: stringResource(R.string.chat_untitled)
                        Text(
                            stringResource(R.string.artifact_source_name, title),
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                        )
                    }
                }
            }
            val save = preview?.access?.save
            if (source != null || save != null) {
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
                        ArtifactAction(
                            R.string.artifact_save,
                            icon = R.drawable.ic_download,
                            enabled = !offline && saveEnabled,
                        ) {
                            onSave(save)
                        }
                    }
                }
            }
            val browserUrl = preview?.info?.browserUrl
            val open = browserUrl?.takeUnless { offline }
            val feedback =
                when (saveResult) {
                    ArtifactSaveResult.Saving -> R.string.artifact_saving
                    ArtifactSaveResult.Saved -> R.string.artifact_saved
                    ArtifactSaveResult.Denied -> R.string.artifact_save_denied
                    ArtifactSaveResult.Failed -> R.string.artifact_save_failed
                    null -> R.string.artifact_browser_unavailable.takeIf { browserUnavailable }
                }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                PreviewContent(preview, offline)
                if (!offline && preview?.hasReadableContent == true) {
                    preview.problem?.let { PreviewFeedback(it.label()) }
                }
                if (feedback != null) {
                    KeepSpaceWhenHidden(visible = saveResult != null || open != null) {
                        PreviewFeedback(feedback)
                    }
                }
            }
            // Keep the action's space while inline sites wait for preview authorization.
            if (browserUrl != null || preview?.info?.resource is ArtifactResource.Site) {
                KeepSpaceWhenHidden(visible = open != null) {
                    ArtifactAction(
                        R.string.artifact_open_website,
                        icon = R.drawable.ic_open_in_new,
                        enabled = open != null,
                    ) {
                        val destination = open ?: return@ArtifactAction
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
        }
    }
}

@Composable
private fun PreviewFeedback(@StringRes label: Int) {
    Text(
        stringResource(label),
        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Keep the scroll range stable when browser controls disappear on disconnect. */
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
internal fun ArtifactAction(
    @StringRes label: Int,
    modifier: Modifier = Modifier,
    @DrawableRes icon: Int? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    OutlinedButton(
        onClick = onClick,
        modifier = modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp),
        enabled = enabled,
        shape = RoundedCornerShape(12.dp),
        border = BorderStroke(1.dp, colors.outline),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = colors.onSurface),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
    ) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
        ) {
            if (icon != null) Icon(painterResource(icon), null, Modifier.size(18.dp))
            Text(stringResource(label), style = artifactSmallText())
        }
    }
}

@Composable
private fun PreviewContent(preview: ArtifactPreviewState?, offline: Boolean) {
    val content = preview?.content
    val problem = preview?.problem
    val hosted = preview?.isHosted == true
    val waiting = content == null && problem == null && !offline
    val showLoading = rememberChatWaitIndicator(waiting)
    if (!hosted && waiting && !showLoading) return
    val colors = MaterialTheme.colorScheme
    Surface(
        Modifier.fillMaxWidth()
            .then(if (hosted) Modifier.aspectRatio(HostedPreviewAspectRatio) else Modifier)
            .testTag("artifact_preview_surface"),
        shape = RoundedCornerShape(16.dp),
        color = if (hosted) colors.surfaceVariant else colors.surface,
        border = BorderStroke(1.dp, colors.outline),
    ) {
        if (hosted) {
            HostedPreviewContent(content, problem, offline, showLoading)
        } else {
            when (content) {
                is ArtifactContent.Text ->
                    SelectionContainer(Modifier.padding(16.dp)) {
                        ProvideTextStyle(
                            MaterialTheme.typography.bodyLarge.copy(
                                lineHeight = if (content.markdown) 28.sp else 24.sp
                            )
                        ) {
                            if (content.markdown)
                                HistoryMarkdown(content.source, compactLists = true)
                            else Text(content.source)
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
                is ArtifactContent.Media ->
                    if (offline)
                        PreviewStatus(R.string.artifact_online_preview, ratio = content.video)
                    else key(content.url) { MediaArtifactPreview(content) }
                else ->
                    when {
                        offline -> PreviewStatus(R.string.artifact_online_preview)
                        problem != null -> PreviewStatus(problem.label())
                        content == ArtifactContent.Unsupported ->
                            PreviewStatus(R.string.artifact_preview_unsupported)
                        else ->
                            Box(
                                Modifier.fillMaxWidth().heightIn(min = 96.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                PreviewLoading()
                            }
                    }
            }
        }
    }
}

@Composable
private fun HostedPreviewContent(
    content: ArtifactContent?,
    problem: ArtifactProblem?,
    offline: Boolean,
    showLoading: Boolean,
) {
    var siteScroll by rememberArtifactWebScroll()
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val inset = if (maxWidth >= 600.dp) 32.dp else 16.dp
        Box(Modifier.fillMaxSize().padding(inset), contentAlignment = Alignment.Center) {
            when {
                offline -> PreviewStatusText(R.string.artifact_online_preview)
                content is ArtifactContent.Website ->
                    key(content.url) {
                        HostedArtifactPreview(content, siteScroll) { siteScroll = it }
                    }
                problem != null -> PreviewStatusText(problem.label())
                content == ArtifactContent.Unsupported ->
                    PreviewStatusText(R.string.artifact_preview_unsupported)
                showLoading -> PreviewLoading()
            }
        }
    }
}

@Composable
private fun PreviewLoading() {
    CircularProgressIndicator(Modifier.size(24.dp).testTag("artifact_preview_loading"))
}

@Composable
private fun PreviewStatus(@StringRes label: Int, ratio: Boolean = false) {
    Box(
        Modifier.fillMaxWidth()
            .then(
                if (ratio) Modifier.aspectRatio(16f / 9f, matchHeightConstraintsFirst = false)
                else Modifier.heightIn(min = 96.dp)
            )
            .padding(16.dp),
        contentAlignment = Alignment.Center,
    ) {
        PreviewStatusText(label)
    }
}

@Composable
private fun PreviewStatusText(@StringRes label: Int) {
    Text(
        stringResource(label),
        Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        textAlign = TextAlign.Center,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
private fun HostedArtifactPreview(
    content: ArtifactContent.Website,
    scrollY: Int,
    onScroll: (Int) -> Unit,
) {
    var usedRetries by remember { mutableIntStateOf(0) }
    key(usedRetries) {
        var failure by remember { mutableStateOf<HostedLoadFailure?>(null) }
        when {
            failure == null ->
                AndroidView(
                    modifier = Modifier.fillMaxSize(),
                    factory = {
                        val initialScroll = scrollY
                        isolatedPreview(
                            it,
                            content.url,
                            onFailure = { if (failure == null) failure = it },
                            onLoaded = { view ->
                                view.scrollTo(0, initialScroll)
                                view.setOnScrollChangeListener { _, _, y, _, _ -> onScroll(y) }
                            },
                        )
                    },
                    onRelease = { it.destroy() },
                    update = {},
                )
            failure == HostedLoadFailure.Temporary && usedRetries < content.remainingRetries -> {
                val lifecycle = LocalLifecycleOwner.current.lifecycle
                LaunchedEffect(lifecycle) {
                    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                        delay(ArtifactRetryDelayMillis)
                        usedRetries++
                    }
                }
                PreviewLoading()
            }
            else -> PreviewStatusText(R.string.artifact_unavailable)
        }
    }
}

private enum class HostedLoadFailure {
    Temporary,
    Terminal,
}

// Hosted content runs on its server-authorized HTTPS origin. It receives no app token,
// local file access, native bridge, or cross-origin top-level navigation.
@SuppressLint("SetJavaScriptEnabled")
private fun isolatedPreview(
    context: Context,
    url: HttpUrl,
    onFailure: (HostedLoadFailure) -> Unit,
    onLoaded: (WebView) -> Unit,
): WebView =
    WebView(context).apply {
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        settings.javaScriptEnabled = true
        webViewClient =
            object : WebViewClient() {
                private val initialAddress = url.toString().substringBefore('#')
                private var openingDocument = true

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
                    reportFailure(request, temporary)
                }

                override fun onReceivedHttpError(
                    view: WebView,
                    request: WebResourceRequest,
                    response: WebResourceResponse,
                ) {
                    reportFailure(request, isTemporaryArtifactHttpStatus(response.statusCode))
                }

                override fun onRenderProcessGone(
                    view: WebView,
                    detail: RenderProcessGoneDetail,
                ): Boolean {
                    onFailure(HostedLoadFailure.Terminal)
                    return true
                }

                override fun onPageCommitVisible(view: WebView, address: String) {
                    openingDocument = false
                }

                override fun onPageFinished(view: WebView, address: String) {
                    openingDocument = false
                    onLoaded(view)
                }

                private fun reportFailure(request: WebResourceRequest, temporary: Boolean) {
                    if (!request.isForMainFrame) return
                    // Only the app's original GET is safe to replay, before the hosted page is
                    // shown.
                    val retry =
                        temporary &&
                            openingDocument &&
                            request.method == "GET" &&
                            request.url.toString().substringBefore('#') == initialAddress
                    openingDocument = false
                    onFailure(
                        if (retry) HostedLoadFailure.Temporary else HostedLoadFailure.Terminal
                    )
                }
            }
        loadUrl(url.toString())
    }

@Composable
private fun MediaArtifactPreview(content: ArtifactContent.Media) {
    var failed by remember { mutableStateOf(false) }
    var player by remember { mutableStateOf<VideoView?>(null) }
    LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) { player?.pause() }
    if (failed) {
        PreviewStatus(R.string.artifact_unavailable, ratio = content.video)
    } else {
        val playLabel = stringResource(R.string.artifact_play_media)
        AndroidView(
            modifier =
                Modifier.fillMaxWidth()
                    .then(
                        if (content.video) Modifier.aspectRatio(16f / 9f)
                        else Modifier.height(96.dp)
                    ),
            factory = { context ->
                VideoView(context).apply {
                    contentDescription = playLabel
                    setMediaController(MediaController(context))
                    setOnErrorListener { _, _, _ ->
                        failed = true
                        true
                    }
                    setVideoURI(content.url.toString().toUri())
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
