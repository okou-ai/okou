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

internal data class InlineImageGrant(
    val previewId: String,
    val filename: String,
    val fileId: String? = null,
)

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
    val newlyLoaded: Boolean = false,
)

/** The workspace owns in-flight reads and retains offscreen results within a memory budget. */
internal class InlineArtifactImages(
    private val service: ArtifactService,
    private val scope: CoroutineScope,
    private val disk: ChatThumbnailStore.Workspace?,
    private val onFailure: (Exception) -> ArtifactProblem,
) {
    private val entries = MutableStateFlow<Map<InlineImageRequest, InlineImageState>>(emptyMap())
    private val reads = mutableMapOf<InlineImageRequest, Job>()
    private val visibleCounts = mutableMapOf<InlineImageRequest, Int>()
    // An entry with no job waits until a cached image of this source becomes visible.
    private val accessChecks = mutableMapOf<String, Job?>()

    fun observe(request: InlineImageRequest) = entries.map { it[request] }.distinctUntilChanged()

    fun get(request: InlineImageRequest): InlineImageState? = entries.value[request]

    fun observeThumbnail(threadId: String, source: String) =
        entries.map { it.thumbnail(threadId, source) }.distinctUntilChanged()

    fun thumbnail(threadId: String, source: String): Bitmap? =
        entries.value.thumbnail(threadId, source)

    fun unavailableSources(threadId: String): Set<String> =
        entries.value.entries
            .asSequence()
            .filter { (request, state) ->
                request.threadId == threadId && state.status == InlineImageStatus.Unavailable
            }
            .mapTo(mutableSetOf()) { it.key.source }

    private fun Map<InlineImageRequest, InlineImageState>.thumbnail(
        threadId: String,
        source: String,
    ): Bitmap? = entries.firstNotNullOfOrNull { (request, state) ->
        state.bitmap.takeIf { request.threadId == threadId && request.source == source }
    }

    fun retainVisible(request: InlineImageRequest) {
        visibleCounts[request] = (visibleCounts[request] ?: 0) + 1
        revalidateVisible(request)
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
        entries.map { authorizedNames(threadId, it) }.distinctUntilChanged()

    fun authorizedNames(threadId: String): Map<String, String> =
        authorizedNames(threadId, entries.value)

    private fun authorizedNames(
        threadId: String,
        images: Map<InlineImageRequest, InlineImageState>,
    ): Map<String, String> =
        images
            .asSequence()
            .filter { it.key.threadId == threadId }
            .mapNotNull { (request, state) -> state.grant?.let { request.source to it.filename } }
            .toMap()

    fun request(request: InlineImageRequest) {
        if (request !in visibleCounts || request in entries.value) return
        put(request, InlineImageState(InlineImageStatus.Loading))
        val read =
            scope.launch(start = CoroutineStart.LAZY) {
                val job = currentCoroutineContext()[Job]
                var grant: InlineImageGrant? = null
                var cached: CachedInlineThumbnail? = null
                try {
                    cached =
                        if (request.source.startsWith(ExternalImagePreviewPrefix)) null
                        else disk?.load(request)
                    currentCoroutineContext().ensureActive()
                    cached?.let {
                        put(request, InlineImageState(InlineImageStatus.Ready, it.grant, it.bitmap))
                    }
                    val bitmap =
                        service.readInlineImage(request.source, request.width, cached) { authorized
                            ->
                            job?.ensureActive()
                            grant = authorized
                            if (authorized.fileId != null)
                                applyGrant(request.source, authorized, reading = request)
                            if (cached == null || cached.grant.fileId != authorized.fileId)
                                put(
                                    request,
                                    InlineImageState(InlineImageStatus.Loading, authorized),
                                )
                        }
                    currentCoroutineContext().ensureActive()
                    put(
                        request,
                        InlineImageState(
                            if (bitmap == null) InlineImageStatus.MissingThumbnail
                            else InlineImageStatus.Ready,
                            grant,
                            bitmap,
                            newlyLoaded = bitmap != null && bitmap !== cached?.bitmap,
                        ),
                    )
                    val confirmed = grant
                    if (
                        bitmap != null &&
                            confirmed?.fileId != null &&
                            (cached == null ||
                                cached.bitmap !== bitmap ||
                                cached.grant != confirmed)
                    ) {
                        disk?.save(request, confirmed, bitmap)
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    val failure = onFailure(error)
                    if (grant == null && cached != null && failure == ArtifactProblem.Temporary)
                        return@launch
                    if (
                        grant == null &&
                            (failure == ArtifactProblem.Denied ||
                                failure == ArtifactProblem.Missing ||
                                cached != null)
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
        disk?.removeSource(source)
        accessChecks.remove(source)?.cancel()
        val current = entries.value
        val matching = current.keys.filter { it.source == source }
        if (matching.isEmpty()) return
        for (request in matching) reads.remove(request)?.cancel()
        val unavailable = InlineImageState(InlineImageStatus.Unavailable)
        entries.value = current + matching.associateWith { unavailable }
    }

    fun invalidate(threadIds: Set<String>? = null) {
        disk?.removeThreads(threadIds)
        val removed = entries.value.keys.filter { threadIds == null || it.threadId in threadIds }
        if (removed.isEmpty()) return
        remove(removed)
    }

    fun revalidate() {
        for ((request, state) in entries.value) {
            // The original can be accessible even when its thumbnail is missing.
            if (state.grant?.fileId != null) accessChecks.putIfAbsent(request.source, null)
        }
        for (request in visibleCounts.keys.toList()) revalidateVisible(request)
    }

    private fun revalidateVisible(request: InlineImageRequest) {
        val source = request.source
        if (source !in accessChecks || accessChecks[source] != null) return
        if (entries.value[request]?.grant?.fileId == null) return
        val check =
            scope.launch(start = CoroutineStart.LAZY) {
                val job = currentCoroutineContext()[Job]
                try {
                    val grant = service.revalidateInlineImage(source)
                    currentCoroutineContext().ensureActive()
                    applyGrant(source, grant)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    val failure = onFailure(error)
                    if (failure != ArtifactProblem.Temporary) revoke(source)
                } finally {
                    if (accessChecks[source] == job) accessChecks.remove(source)
                }
            }
        accessChecks[source] = check
        check.start()
    }

    private fun applyGrant(
        source: String,
        grant: InlineImageGrant,
        reading: InlineImageRequest? = null,
    ) {
        val current = entries.value
        val matching = current.filterKeys { it.source == source }
        if (matching.values.any { it.grant != null && it.grant.fileId != grant.fileId }) {
            disk?.removeSource(source)
            remove(matching.keys.filter { it != reading })
            return
        }
        entries.value =
            current +
                matching
                    .filterValues { it.grant != null }
                    .mapValues { it.value.copy(grant = grant) }
    }

    private fun remove(requests: Collection<InlineImageRequest>) {
        for (request in requests) reads.remove(request)?.cancel()
        val next = entries.value - requests.toSet()
        pruneAccessChecks(next)
        entries.value = next
    }

    private fun pruneAccessChecks(images: Map<InlineImageRequest, InlineImageState>) {
        if (accessChecks.isEmpty()) return
        val grantedSources =
            images
                .filterValues { it.grant?.fileId != null }
                .keys
                .mapTo(mutableSetOf()) { it.source }
        for (source in accessChecks.keys - grantedSources) accessChecks.remove(source)?.cancel()
    }

    fun revisit(threadId: String) {
        val unavailable =
            entries.value
                .filter { (request, state) ->
                    request.threadId == threadId &&
                        (state.status == InlineImageStatus.MissingThumbnail ||
                            state.status == InlineImageStatus.Unavailable)
                }
                .keys
        if (unavailable.isNotEmpty()) remove(unavailable)
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
        pruneAccessChecks(next)
        return next
    }
}
