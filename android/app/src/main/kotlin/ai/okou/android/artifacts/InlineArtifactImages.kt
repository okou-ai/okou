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

/** The authorized workspace owns in-flight reads and keeps a bounded, memory-only result cache. */
internal class InlineArtifactImages(
    private val service: ArtifactService,
    private val scope: CoroutineScope,
    private val onFailure: (Exception) -> Boolean,
) {
    private val entries = MutableStateFlow<Map<InlineImageRequest, InlineImageState>>(emptyMap())
    private val reads = mutableMapOf<InlineImageRequest, Job>()

    fun observe(request: InlineImageRequest) = entries.map { it[request] }.distinctUntilChanged()

    fun get(request: InlineImageRequest): InlineImageState? = entries.value[request]

    fun names(threadId: String): Map<String, String> =
        entries.value
            .asSequence()
            .filter { it.key.threadId == threadId }
            .mapNotNull { (request, state) -> state.grant?.filename?.let { request.source to it } }
            .toMap()

    fun request(request: InlineImageRequest) {
        if (request in entries.value) return
        put(request, InlineImageState(InlineImageStatus.Loading))
        val read =
            scope.launch(start = CoroutineStart.LAZY) {
                val job = currentCoroutineContext()[Job]
                var grant: InlineImageGrant? = null
                try {
                    val bitmap =
                        service.readInlineImage(request.source, request.width) { authorized ->
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
                    val denied = onFailure(error)
                    put(
                        request,
                        if (denied || grant == null) InlineImageState(InlineImageStatus.Unavailable)
                        else InlineImageState(InlineImageStatus.MissingThumbnail, grant),
                    )
                } finally {
                    if (reads[request] == job) reads.remove(request)
                }
            }
        reads[request] = read
        read.start()
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
        val next = entries.value.toMutableMap()
        next[request] = result
        var bytes = next.values.sumOf { it.bitmap?.allocationByteCount?.toLong() ?: 0L }
        val older = next.entries.iterator()
        while ((next.size > 24 || bytes > 16L * 1024 * 1024) && older.hasNext()) {
            val (key, value) = older.next()
            if (key == request || value.status == InlineImageStatus.Loading) continue
            bytes -= value.bitmap?.allocationByteCount ?: 0
            older.remove()
        }
        entries.value = next
    }
}
