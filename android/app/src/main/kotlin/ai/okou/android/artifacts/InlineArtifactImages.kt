package ai.okou.android.artifacts

import android.graphics.Bitmap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

internal const val ExternalImagePreviewPrefix = "external-image:"

internal fun inlineImageSource(destination: String): String? =
    messageArtifactLink(destination)?.takeIf { it.startsWith("/artifacts/") }
        ?: artifactHttpsUrl(destination)?.let { "$ExternalImagePreviewPrefix$it" }

internal data class InlineImageRequest(val threadId: String, val source: String, val width: Int)

internal data class InlineImageGrant(val previewId: String, val filename: String?)

internal enum class InlineImageStatus {
    Loading,
    Ready,
    MissingThumbnail,
    Unavailable,
}

internal data class InlineImageState(
    val status: InlineImageStatus,
    val grant: InlineImageGrant? = null,
    val bitmap: Bitmap? = null,
)

/** The workspace owns in-flight reads and retains offscreen results within a memory budget. */
internal class InlineArtifactImages(
    private val service: ArtifactService,
    private val scope: CoroutineScope,
    private val onFailure: (Exception) -> ArtifactProblem,
) {
    private val entries = MutableStateFlow<Map<InlineImageRequest, InlineImageState>>(emptyMap())
    private val reads = mutableMapOf<InlineImageRequest, Job>()
    private val visibleCounts = mutableMapOf<InlineImageRequest, Int>()

    fun observe(request: InlineImageRequest) = entries.map { it[request] }.distinctUntilChanged()

    fun get(request: InlineImageRequest): InlineImageState? = entries.value[request]

    fun retainVisible(request: InlineImageRequest) {
        visibleCounts[request] = (visibleCounts[request] ?: 0) + 1
    }

    fun releaseVisible(request: InlineImageRequest) {
        val remaining = visibleCounts.getValue(request) - 1
        if (remaining > 0) {
            visibleCounts[request] = remaining
        } else {
            visibleCounts.remove(request)
            entries.value = trim(entries.value)
        }
    }

    fun names(threadId: String) =
        entries
            .map { images ->
                images
                    .asSequence()
                    .filter { it.key.threadId == threadId }
                    .mapNotNull { (request, state) ->
                        state.grant?.filename?.let { request.source to it }
                    }
                    .toMap()
            }
            .distinctUntilChanged()

    fun request(request: InlineImageRequest) {
        if (request !in visibleCounts || request in entries.value) return
        put(request, InlineImageState(InlineImageStatus.Loading))
        val read =
            scope.launch(start = CoroutineStart.LAZY) {
                val job = currentCoroutineContext()[Job]
                var grant: InlineImageGrant? = null
                try {
                    val bitmap =
                        service.readInlineImage(request.source, request.width) { authorized ->
                            job?.ensureActive()
                            grant = authorized
                            put(request, InlineImageState(InlineImageStatus.Loading, authorized))
                        }
                    currentCoroutineContext().ensureActive()
                    put(
                        request,
                        InlineImageState(
                            if (bitmap == null) InlineImageStatus.MissingThumbnail
                            else InlineImageStatus.Ready,
                            grant,
                            bitmap,
                        ),
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    val failure = onFailure(error)
                    if (
                        grant == null &&
                            (failure == ArtifactProblem.Denied ||
                                failure == ArtifactProblem.Missing)
                    ) {
                        revoke(request.source)
                        return@launch
                    }
                    val canShowFallback =
                        failure != ArtifactProblem.Denied &&
                            (grant != null || failure == ArtifactProblem.Temporary)
                    put(
                        request,
                        if (canShowFallback)
                            InlineImageState(InlineImageStatus.MissingThumbnail, grant)
                        else InlineImageState(InlineImageStatus.Unavailable),
                    )
                } finally {
                    if (reads[request] == job) reads.remove(request)
                }
            }
        reads[request] = read
        read.start()
    }

    fun revoke(source: String) {
        val current = entries.value
        val matching = current.keys.filter { it.source == source }
        if (matching.isEmpty()) return
        for (request in matching) reads.remove(request)?.cancel()
        val unavailable = InlineImageState(InlineImageStatus.Unavailable)
        entries.value = current + matching.associateWith { unavailable }
    }

    fun invalidate(threadIds: Set<String>? = null) {
        val removed = entries.value.keys.filter { threadIds == null || it.threadId in threadIds }
        if (removed.isEmpty()) return
        for (request in removed) reads.remove(request)?.cancel()
        entries.value = entries.value - removed.toSet()
    }

    fun revisit(threadId: String) {
        entries.value =
            entries.value.filterNot { (request, state) ->
                request.threadId == threadId &&
                    (state.status == InlineImageStatus.MissingThumbnail ||
                        state.status == InlineImageStatus.Unavailable)
            }
    }

    private fun put(request: InlineImageRequest, result: InlineImageState) {
        entries.value = trim(entries.value + (request to result))
    }

    private fun trim(
        images: Map<InlineImageRequest, InlineImageState>,
    ): Map<InlineImageRequest, InlineImageState> {
        val maxBytes = 16L * 1024 * 1024
        val maxEntries = 24
        var bytes = images.values.sumOf { it.bitmap?.allocationByteCount?.toLong() ?: 0L }
        if (images.size <= maxEntries && bytes <= maxBytes) return images
        val next = images.toMutableMap()
        val older = next.entries.iterator()
        while ((next.size > maxEntries || bytes > maxBytes) && older.hasNext()) {
            val (key, value) = older.next()
            if (key in visibleCounts) continue
            reads.remove(key)?.cancel()
            bytes -= value.bitmap?.allocationByteCount ?: 0
            older.remove()
        }
        return next
    }
}
