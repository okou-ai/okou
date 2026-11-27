package ai.okou.android.artifacts

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.ResponseLimitExceeded
import ai.okou.android.api.finiteReadRetryDelays
import ai.okou.android.api.retryAfterDelayMillis
import ai.okou.android.chat.ChatCacheStore
import ai.okou.android.chat.ChatChanges
import ai.okou.android.chat.ChatImageVisit
import ai.okou.android.contentReadStaleDelayMillis
import android.graphics.Bitmap
import android.util.Log
import android.util.LruCache
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import java.io.OutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal enum class ArtifactProblem {
    Denied,
    Missing,
    Temporary,
    Unavailable,
    OriginalUnavailable,
    Unsupported,
}

internal data class ArtifactPreviewState(
    val id: String,
    val item: ArtifactItem?,
    val info: ArtifactInfo? = null,
    val access: ArtifactAccess? = null,
    val content: ArtifactContent? = null,
    val problem: ArtifactProblem? = null,
) {
    val linkSource: ArtifactLinkSource?
        get() = access?.linkSource ?: info?.linkSource

    val isImage: Boolean
        get() = item?.kind == ArtifactKind.Image || id.startsWith(ExternalImagePreviewPrefix)

    val isHosted: Boolean
        get() =
            info?.resource !is ArtifactResource.File &&
                (item?.kind == ArtifactKind.Website || item?.kind == ArtifactKind.Presentation)

    val hasReadableContent: Boolean
        get() =
            content is ArtifactContent.Text ||
                content is ArtifactContent.Image ||
                content is ArtifactContent.EncodedImage
}

internal enum class ArtifactSaveResult {
    Saving,
    Saved,
    Denied,
    Failed,
}

internal enum class ArtifactCatalogRead {
    Refreshing,
    SyncingStale,
    More,
}

internal enum class ArtifactCatalogFailure {
    Initial,
    Refresh,
    More,
    Denied,
    Missing,
    ChatUnavailable,
}

internal data class ConfirmedArtifactCatalog(val page: ArtifactPage, val confirmedAt: Long)

internal class ArtifactRefreshFailure

internal data class ArtifactCatalogState(
    val query: ArtifactQuery = ArtifactQuery(),
    val catalog: ConfirmedArtifactCatalog? = null,
    val failedRead: ArtifactCatalogFailure? = null,
    val refreshFailure: ArtifactRefreshFailure? = null,
    val reading: ArtifactCatalogRead? = null,
    val initialReadRound: Any? = null,
    val relatedChats: RelatedChatResourcesState = RelatedChatResourcesState(),
    val workflows: WorkflowResourcesState = WorkflowResourcesState(),
    val preview: ArtifactPreviewState? = null,
    val saveResult: Pair<String, ArtifactSaveResult>? = null,
) {
    val page: ArtifactPage?
        get() = catalog?.page

    val saving: Boolean
        get() = saveResult?.second == ArtifactSaveResult.Saving
}

/** One authorized workspace owns the catalog requests and a small in-memory preview cache. */
class ArtifactCatalogModel
internal constructor(
    private val service: ArtifactService,
    private val cache: ChatCacheStore.Lease? = null,
    catalogChanges: Flow<ChatChanges> = emptyFlow(),
    unavailableChat: Flow<String?> = emptyFlow(),
    private val wallMillis: () -> Long = System::currentTimeMillis,
    private val onCatalogDenied: () -> Unit = {},
    private val sessionFailure: (Exception) -> Unit,
) : ViewModel() {
    private val mutable = MutableStateFlow(ArtifactCatalogState())
    internal val state = mutable.asStateFlow()
    internal var chatImageVisit by mutableStateOf<ChatImageVisit?>(null)
        private set

    private val unavailableChatImages = mutableStateMapOf<String, ArtifactProblem>()
    private val catalogs = LinkedHashMap<ArtifactQuery, ConfirmedArtifactCatalog>(8, 0.75f, true)
    private val previews = LinkedHashMap<String, ArtifactPreviewState>(3, 0.75f, true)
    private val thumbnails = LruCache<String, Bitmap>(40)
    internal val inlineImages =
        InlineArtifactImages(service, viewModelScope, cache?.inlineThumbnails) { error ->
            val failure = problem(error)
            if (error is ApiFailure.Unauthenticated) ArtifactProblem.Denied else failure
        }
    private var active = false
    private var catalogVisible = false
    private var catalogJob: Job? = null
    private var catalogWrite: Job? = null
    private var relatedRead: Job? = null
    private var workflowRead: Job? = null
    private var workflowRefreshPending = false
    private var workflowReferences: Pair<String, Set<String>>? = null
    private var previewJob: Job? = null
    private var useImageViewer = false
    private var missingThread: String? = null

    init {
        viewModelScope.launch {
            catalogChanges.collect { changes ->
                if (changes.artifactThreads.isNotEmpty())
                    inlineImages.invalidate(changes.artifactThreads)
                if (changes.resync) inlineImages.revalidate()
                val threadId = mutable.value.query.chatThreadId ?: return@collect
                if (catalogVisible && (changes.resync || threadId in changes.artifactThreads)) {
                    readCatalog()
                    mutable.value.preview?.let { readPreview(it.id) }
                }
                if (changes.resync || changes.list || threadId in changes.messageThreads) {
                    refreshRelatedChats()
                }
                if (changes.resync) refreshWorkflows()
            }
        }
        viewModelScope.launch {
            unavailableChat.collect { threadId ->
                missingThread = threadId
                if (threadId != null) {
                    inlineImages.invalidate(setOf(threadId))
                    evictChatCatalog(threadId)
                }
            }
        }
    }

    internal fun setActive(
        visible: Boolean,
        currentQuery: ArtifactQuery = mutable.value.query,
        showCatalog: Boolean = true,
    ) {
        if (active == visible) return
        active = visible
        catalogVisible = visible && showCatalog
        if (visible) {
            if (catalogVisible) {
                if (currentQuery != mutable.value.query) query(currentQuery, debounce = false)
                else {
                    readCatalog(append = mutable.value.failedRead == ArtifactCatalogFailure.More)
                    refreshRelatedChats()
                    refreshWorkflows()
                }
            }
            mutable.value.preview?.let { readPreview(it.id) }
        } else {
            catalogJob?.cancel()
            previewJob?.cancel()
            relatedRead?.cancel()
            cancelWorkflowRefresh()
            mutable.update {
                it.copy(
                    reading = null,
                    initialReadRound = null,
                    refreshFailure = null,
                    relatedChats = it.relatedChats.copy(syncingStale = false),
                    workflows = it.workflows.copy(checking = false, syncingStale = false),
                )
            }
        }
    }

    internal fun query(next: ArtifactQuery, debounce: Boolean) {
        if (next == mutable.value.query) return
        catalogJob?.cancel()
        relatedRead?.cancel()
        cancelWorkflowRefresh()
        mutable.update {
            it.copy(
                query = next,
                catalog = catalogs[next],
                failedRead = null,
                refreshFailure = null,
                reading = null,
                initialReadRound = null,
                relatedChats = RelatedChatResourcesState(),
                workflows = WorkflowResourcesState(),
            )
        }
        readCatalog(debounce = debounce)
        refreshRelatedChats()
        refreshWorkflows()
    }

    internal fun relatedWorkflowIds(threadId: String, ids: Set<String>) {
        val previous = workflowReferences
        if (previous?.first == threadId && previous.second == ids) return
        workflowReferences = threadId to ids
        cancelWorkflowRefresh()
        if (mutable.value.query.chatThreadId == threadId) {
            mutable.update {
                it.copy(
                    workflows =
                        WorkflowResourcesState(
                            confirmed =
                                it.workflows.confirmed.takeIf {
                                    previous?.first == threadId && ids.isNotEmpty()
                                },
                        ),
                )
            }
        }
        refreshWorkflows()
    }

    internal fun loadNext() {
        val current = mutable.value
        if (
            current.reading != null ||
                current.failedRead != null ||
                current.page?.nextCursor == null
        )
            return
        readCatalog(append = true)
    }

    internal fun select(id: String?, item: ArtifactItem? = null, showImageViewer: Boolean = true) {
        val useImageViewer =
            id != null &&
                showImageViewer &&
                (isGeneratedArtifactPreview(id) ||
                    isChatAttachmentImage(id) ||
                    id.startsWith(ExternalImagePreviewPrefix) && chatImageVisit != null)
        if (mutable.value.preview?.id == id && this.useImageViewer == useImageViewer) return
        previewJob?.cancel()
        this.useImageViewer = useImageViewer
        val initial = id?.let {
            previews[it]
                ?: run {
                    val info = if (item == null) knownMessageSiteInfo(it) else null
                    ArtifactPreviewState(it, item ?: info?.item, info = info)
                }
        }
        mutable.update {
            it.copy(
                preview = initial,
                saveResult = it.saveResult?.takeIf { result -> it.saving || result.first == id },
            )
        }
        if (id != null) readPreview(id)
    }

    internal fun showChatImages(visit: ChatImageVisit?) {
        unavailableChatImages.clear()
        chatImageVisit = visit
    }

    internal fun chatImageProblem(id: String): ArtifactProblem? = unavailableChatImages[id]

    internal fun retainDecodedImage(
        id: String,
        source: ArtifactContent.EncodedImage,
        bitmap: Bitmap,
    ) {
        val preview = mutable.value.preview ?: return
        if (preview.id == id && preview.content === source && preview.access != null) {
            previews.remember(id, preview.copy(content = ArtifactContent.Image(bitmap)), 3)
        }
    }

    internal fun retainedExternalImageId(): String? =
        (chatImageVisit?.initialLink ?: mutable.value.preview?.id)?.takeIf {
            it.startsWith(ExternalImagePreviewPrefix)
        }

    internal suspend fun thumbnail(url: String, cacheOnly: Boolean = false): Bitmap? {
        thumbnails.get(url)?.let {
            return it
        }
        if (cacheOnly) return null
        return try {
            retryArtifactOperation { service.thumbnail(url) }?.also { thumbnails.put(url, it) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }

    internal fun save(id: String, destination: () -> OutputStream) {
        val current = mutable.value
        if (current.saving) return
        val cached = current.preview?.takeIf { it.id == id }?.access?.save
        mutable.update { it.copy(saveResult = id to ArtifactSaveResult.Saving) }
        viewModelScope.launch {
            var destinationStarted = false
            val result =
                try {
                    retryArtifactOperation(canRetry = { !destinationStarted }) {
                        val file =
                            cached
                                ?: service.info(id).let { info ->
                                    (info.resource as? ArtifactResource.File)?.let {
                                        (info.resolvedAccess ?: service.fileAccess(it)).save
                                    }
                                }
                        if (file == null) ArtifactSaveResult.Denied
                        else {
                            service.save(file) {
                                // The provider may have changed the file even if opening it fails.
                                destinationStarted = true
                                destination()
                            }
                            ArtifactSaveResult.Saved
                        }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: ChatAttachmentAccessLost) {
                    withdrawExport(id, saveDenied = true, lostAccess = artifactProblem(error))
                    return@launch
                } catch (error: Exception) {
                    handleSessionFailure(error)
                    if (error is ApiFailure.Http && error.status in 401..404) {
                        ArtifactSaveResult.Denied
                    } else ArtifactSaveResult.Failed
                }
            if (result == ArtifactSaveResult.Denied) {
                withdrawExport(id, saveDenied = true)
            } else {
                mutable.update { it.copy(saveResult = id to result) }
            }
        }
    }

    internal suspend fun prepareOriginalShare(
        id: String,
        original: ArtifactSave,
        destination: () -> OutputStream,
    ): ArtifactSaveResult {
        fun isCurrent() = mutable.value.preview?.takeIf { it.id == id }?.access?.save == original
        if (!isCurrent()) return ArtifactSaveResult.Denied
        return try {
            // The private temporary destination can be replaced on a recoverable retry.
            retryArtifactOperation { service.save(original, destination) }
            if (isCurrent()) ArtifactSaveResult.Saved else ArtifactSaveResult.Denied
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: ChatAttachmentAccessLost) {
            withdrawExport(id, lostAccess = artifactProblem(error))
            ArtifactSaveResult.Denied
        } catch (error: Exception) {
            handleSessionFailure(error)
            if (error is ApiFailure.Http && error.status in 401..404) {
                withdrawExport(id)
                ArtifactSaveResult.Denied
            } else ArtifactSaveResult.Failed
        }
    }

    private fun withdrawExport(
        id: String,
        saveDenied: Boolean = false,
        lostAccess: ArtifactProblem? = null,
    ) {
        if (lostAccess != null) {
            revokeChatImage(id, lostAccess)
            if (mutable.value.preview?.id == id) previewJob?.cancel()
        } else previews[id]?.let { previews[id] = it.withoutSave() }
        mutable.update { current ->
            val preview = current.preview
            current.copy(
                preview =
                    when {
                        preview?.id != id -> preview
                        lostAccess != null -> ArtifactPreviewState(id, null, problem = lostAccess)
                        else -> preview.withoutSave()
                    },
                saveResult =
                    if (saveDenied) id to ArtifactSaveResult.Denied else current.saveResult,
            )
        }
    }

    private fun revokeChatImage(id: String, problem: ArtifactProblem) {
        previews.remove(id)
        inlineImages.revoke(id)
        if (chatImageVisit != null) unavailableChatImages[id] = problem
    }

    private fun refreshRelatedChats() {
        val threadId = mutable.value.query.chatThreadId ?: return
        if (!catalogVisible || threadId == missingThread) return
        relatedRead?.cancel()
        relatedRead = viewModelScope.launch {
            val base = mutable.value.relatedChats.confirmed ?: restoreRelatedChats(threadId)
            currentCoroutineContext().ensureActive()
            val state = RelatedChatResourcesState(confirmed = base, checking = true)
            mutable.update { it.copy(relatedChats = state) }
            val progress =
                base?.oldestConfirmation?.let { confirmedAt ->
                    launch {
                        delay(contentReadStaleDelayMillis(confirmedAt, wallMillis()))
                        mutable.update { it.copy(relatedChats = state.copy(syncingStale = true)) }
                    }
                }
            try {
                val (createdResult, communicatingResult) =
                    coroutineScope {
                        val created = async { readRelatedChats(threadId, communicating = false) }
                        val communicating = async {
                            readRelatedChats(threadId, communicating = true)
                        }
                        created.await() to communicating.await()
                    }
                val updated =
                    ConfirmedRelatedChats(
                            createdResult.getOrNull() ?: base?.created,
                            communicatingResult.getOrNull() ?: base?.communicating,
                        )
                        .takeIf { it.oldestConfirmation != null }
                currentCoroutineContext().ensureActive()
                if (updated != null && updated != base) {
                    cache?.let { lease ->
                        storeCatalog { lease.saveRelatedResources(threadId, updated) }
                    }
                }
                mutable.update {
                    it.copy(
                        relatedChats =
                            RelatedChatResourcesState(
                                confirmed = updated,
                                failure =
                                    RelatedChatReadFailure.Temporary.takeIf {
                                        createdResult.isFailure || communicatingResult.isFailure
                                    },
                            ),
                    )
                }
            } catch (_: RelatedChatAccessLost) {
                currentCoroutineContext().ensureActive()
                cache?.let { lease -> storeCatalog { lease.saveRelatedResources(threadId, null) } }
                mutable.update {
                    it.copy(
                        relatedChats =
                            RelatedChatResourcesState(failure = RelatedChatReadFailure.AccessLost),
                    )
                }
            } finally {
                progress?.cancel()
            }
        }
    }

    private suspend fun readRelatedChats(
        threadId: String,
        communicating: Boolean,
    ): Result<ConfirmedRelatedChatRead> =
        try {
            val rows = retryArtifactOperation { service.relatedChats(threadId, communicating) }
            Result.success(ConfirmedRelatedChatRead(rows, wallMillis()))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            when (problem(error)) {
                ArtifactProblem.Denied,
                ArtifactProblem.Missing -> throw RelatedChatAccessLost()
                else -> Unit
            }
            Result.failure(error)
        }

    private class RelatedChatAccessLost : Exception()

    private suspend fun restoreRelatedChats(threadId: String): ConfirmedRelatedChats? =
        try {
            catalogWrite?.join()
            cache?.loadRelatedResources(threadId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            Log.w("ArtifactCatalog", "Could not read related chat resources")
            null
        }

    private fun refreshWorkflows() {
        val (threadId, ids) = workflowReferences ?: return
        val current = mutable.value
        if (
            !catalogVisible ||
                ids.isEmpty() ||
                threadId != current.query.chatThreadId ||
                threadId == missingThread ||
                current.failedRead == ArtifactCatalogFailure.ChatUnavailable
        )
            return
        if (workflowRead?.isActive == true) {
            workflowRefreshPending = true
            return
        }
        workflowRead = viewModelScope.launch {
            do {
                workflowRefreshPending = false
                readWorkflows(threadId, ids)
            } while (workflowRefreshPending)
        }
    }

    private fun cancelWorkflowRefresh() {
        workflowRead?.cancel()
        workflowRead = null
        workflowRefreshPending = false
    }

    private suspend fun readWorkflows(threadId: String, ids: Set<String>) = coroutineScope {
        val baseline = mutable.value.workflows.confirmed ?: restoreWorkflows(threadId)
        currentCoroutineContext().ensureActive()
        val state = WorkflowResourcesState(confirmed = baseline, checking = true)
        mutable.update { it.copy(workflows = state) }
        val progress =
            baseline?.confirmedAt?.let { confirmedAt ->
                launch {
                    delay(contentReadStaleDelayMillis(confirmedAt, wallMillis()))
                    mutable.update { it.copy(workflows = state.copy(syncingStale = true)) }
                }
            }
        val result =
            try {
                val items = retryArtifactOperation { service.relatedWorkflows(ids) }
                WorkflowResourcesState(ConfirmedWorkflowResources(items, wallMillis()))
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                val status = (error as? ApiFailure.Http)?.status
                if (status == 401) sessionFailure(error) else handleSessionFailure(error)
                if (status == 403)
                    WorkflowResourcesState(ConfirmedWorkflowResources(emptyList(), wallMillis()))
                else WorkflowResourcesState(confirmed = baseline, failed = true)
            } finally {
                progress?.cancelAndJoin()
            }
        currentCoroutineContext().ensureActive()
        val confirmed = result.confirmed
        if (confirmed != null && !result.failed) {
            cache?.let { lease ->
                storeCatalog { lease.saveWorkflowResources(threadId, confirmed) }
            }
        }
        mutable.update { it.copy(workflows = result) }
    }

    private suspend fun restoreWorkflows(threadId: String): ConfirmedWorkflowResources? =
        try {
            catalogWrite?.join()
            cache?.loadWorkflowResources(threadId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            Log.w("ArtifactCatalog", "Could not read workflow resources")
            null
        }

    private fun readCatalog(append: Boolean = false, debounce: Boolean = false) {
        val current = mutable.value
        if (!catalogVisible) return
        val query = current.query
        val cursor = if (append) current.page?.nextCursor ?: return else null
        val threadId = query.chatThreadId
        if (threadId != null && threadId == missingThread) {
            mutable.update {
                it.copy(failedRead = ArtifactCatalogFailure.ChatUnavailable, refreshFailure = null)
            }
            return
        }
        catalogJob?.cancel()
        val initialReadRound = if (current.catalog == null) Any() else null
        mutable.update {
            it.copy(
                failedRead = null,
                reading = catalogRead(append, threadId, current.catalog),
                initialReadRound = initialReadRound,
            )
        }
        catalogJob = viewModelScope.launch {
            if (debounce) delay(250)
            var base = current.catalog
            if (base == null && threadId != null && cache != null) {
                catalogWrite?.join()
                base = restoreCatalog(threadId)
                currentCoroutineContext().ensureActive()
                if (base != null) {
                    catalogs.remember(query, base, 8)
                    mutable.update {
                        it.copy(catalog = base, reading = catalogRead(append, threadId, base))
                    }
                }
            }
            val staleProgress =
                base
                    ?.takeIf {
                        threadId != null && mutable.value.reading == ArtifactCatalogRead.Refreshing
                    }
                    ?.let { snapshot ->
                        launch {
                            delay(contentReadStaleDelayMillis(snapshot.confirmedAt, wallMillis()))
                            mutable.update { it.copy(reading = ArtifactCatalogRead.SyncingStale) }
                        }
                    }
            try {
                val targetSize = if (append) 0 else base?.page?.items?.size ?: 0
                val fresh = loadPages(query, cursor, targetSize)
                val snapshot =
                    if (append) {
                        val confirmed = checkNotNull(base)
                        confirmed.copy(
                            page =
                                ArtifactPage(
                                    (confirmed.page.items + fresh.items).distinctBy { it.id },
                                    fresh.nextCursor,
                                ),
                        )
                    } else ConfirmedArtifactCatalog(fresh, wallMillis())
                currentCoroutineContext().ensureActive()
                if (threadId != null && cache != null) {
                    val appendedTo = base.takeIf { append }
                    storeCatalog { cache.saveArtifactCatalog(threadId, snapshot, appendedTo) }
                }
                catalogs.remember(query, snapshot, 8)
                mutable.update {
                    it.copy(
                        catalog = snapshot,
                        failedRead = null,
                        refreshFailure = null,
                        reading = null,
                        initialReadRound = null,
                    )
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                failCatalog(query, append, problem(error))
            } finally {
                staleProgress?.cancel()
            }
        }
    }

    private fun catalogRead(
        append: Boolean,
        threadId: String?,
        catalog: ConfirmedArtifactCatalog?,
    ) =
        when {
            append -> ArtifactCatalogRead.More
            threadId != null &&
                catalog != null &&
                contentReadStaleDelayMillis(catalog.confirmedAt, wallMillis()) == 0L ->
                ArtifactCatalogRead.SyncingStale
            else -> ArtifactCatalogRead.Refreshing
        }

    private fun failCatalog(query: ArtifactQuery, append: Boolean, problem: ArtifactProblem) {
        if (problem == ArtifactProblem.Denied) {
            evictDeniedCatalogs()
            onCatalogDenied()
            return
        }
        val removed = problem == ArtifactProblem.Missing
        if (removed) {
            query.chatThreadId?.let {
                evictChatCatalog(it, ArtifactCatalogFailure.Missing)
                return
            }
            catalogs.remove(query)
        }
        mutable.update {
            val failure =
                when {
                    removed -> ArtifactCatalogFailure.Missing
                    append -> ArtifactCatalogFailure.More
                    it.catalog == null -> ArtifactCatalogFailure.Initial
                    else -> ArtifactCatalogFailure.Refresh
                }
            it.copy(
                catalog = it.catalog.takeUnless { removed },
                failedRead = failure,
                refreshFailure =
                    if (failure == ArtifactCatalogFailure.Refresh) ArtifactRefreshFailure()
                    else null,
                reading = null,
                initialReadRound = null,
            )
        }
    }

    private fun evictChatCatalog(
        threadId: String,
        failure: ArtifactCatalogFailure = ArtifactCatalogFailure.ChatUnavailable,
    ) {
        val query = ArtifactQuery(chatThreadId = threadId)
        catalogs.remove(query)
        previews.clear()
        cache?.let {
            storeCatalog {
                it.deleteArtifactCatalog(threadId)
                it.deleteRelatedResources(threadId)
            }
        }
        if (mutable.value.query != query) return
        catalogJob?.cancel()
        relatedRead?.cancel()
        cancelWorkflowRefresh()
        if (catalogVisible) previewJob?.cancel()
        mutable.update {
            it.copy(
                catalog = null,
                relatedChats = RelatedChatResourcesState(),
                workflows = WorkflowResourcesState(),
                preview =
                    if (catalogVisible)
                        it.preview?.let { preview ->
                            ArtifactPreviewState(
                                preview.id,
                                null,
                                problem = ArtifactProblem.Missing,
                            )
                        }
                    else it.preview,
                reading = null,
                initialReadRound = null,
                failedRead = failure,
                refreshFailure = null,
            )
        }
    }

    internal fun evictDeniedCatalogs() {
        catalogJob?.cancel()
        relatedRead?.cancel()
        cancelWorkflowRefresh()
        previewJob?.cancel()
        catalogs.clear()
        previews.clear()
        thumbnails.evictAll()
        inlineImages.invalidate()
        cache?.let {
            storeCatalog {
                it.deleteArtifactCatalog()
                it.deleteRelatedResources(null)
            }
        }
        mutable.update {
            it.copy(
                catalog = null,
                relatedChats = RelatedChatResourcesState(),
                workflows = WorkflowResourcesState(),
                preview =
                    it.preview?.let { preview ->
                        ArtifactPreviewState(preview.id, null, problem = ArtifactProblem.Denied)
                    },
                failedRead = ArtifactCatalogFailure.Denied,
                refreshFailure = null,
                reading = null,
                initialReadRound = null,
            )
        }
    }

    private suspend fun restoreCatalog(threadId: String): ConfirmedArtifactCatalog? {
        return try {
            cache?.loadArtifactCatalog(threadId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            Log.w("ArtifactCatalog", "Could not read the confirmed chat artifact catalog")
            null
        }
    }

    private fun storeCatalog(write: suspend () -> Unit) {
        val previous = catalogWrite
        catalogWrite = viewModelScope.launch {
            previous?.join()
            try {
                write()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                Log.w("ArtifactCatalog", "Could not update the confirmed chat artifact catalog")
            }
        }
    }

    private suspend fun loadPages(
        query: ArtifactQuery,
        cursor: String?,
        targetSize: Int,
    ): ArtifactPage {
        val items = LinkedHashMap<String, ArtifactItem>()
        val visited = mutableSetOf<String?>()
        var next = cursor
        do {
            if (!visited.add(next)) throw ApiFailure.IncompatibleResponse()
            val page = retryArtifactOperation { service.page(query, next) }
            page.items.forEach { items.putIfAbsent(it.id, it) }
            next = page.nextCursor
        } while (next != null && items.size < targetSize)
        return ArtifactPage(items.values.toList(), next)
    }

    private fun readPreview(id: String) {
        if (!active) return
        if (
            catalogVisible &&
                missingThread != null &&
                mutable.value.query.chatThreadId == missingThread
        ) {
            mutable.update {
                it.copy(preview = ArtifactPreviewState(id, null, problem = ArtifactProblem.Missing))
            }
            return
        }
        previewJob?.cancel()
        previewJob = viewModelScope.launch {
            // External image metadata describes the URL. Only reading it establishes access.
            val externalImage = id.startsWith(ExternalImagePreviewPrefix)
            var detailAuthorized = false
            var fileAccessAuthorized = false
            try {
                updatePreview(id) { copy(problem = null) }
                retryArtifactOperation { remainingRetries ->
                    detailAuthorized = false
                    fileAccessAuthorized = false
                    val info = service.info(id)
                    detailAuthorized = !externalImage
                    updatePreview(id) {
                        copy(
                            item = info.item,
                            info = info,
                            access = access.takeIf { this.info?.resource == info.resource },
                        )
                    }
                    val content =
                        when (val resource = info.resource) {
                            is ArtifactResource.File -> {
                                val access = info.resolvedAccess ?: service.fileAccess(resource)
                                fileAccessAuthorized = !externalImage
                                updatePreview(id) {
                                    unavailableChatImages.remove(id)
                                    copy(access = access)
                                }
                                service.fileContent(
                                    resource,
                                    access,
                                    keepImageSource =
                                        useImageViewer && info.item.kind == ArtifactKind.Image,
                                )
                            }
                            is ArtifactResource.Site ->
                                ArtifactContent.Website(
                                    service.sitePreviewUrl(resource),
                                    remainingRetries,
                                )
                            is ArtifactResource.ResolvedHtml ->
                                ArtifactContent.Website(resource.url, remainingRetries)
                            ArtifactResource.Unsupported -> ArtifactContent.Unsupported
                        }
                    updatePreview(id) {
                        val browser = (info.resource as? ArtifactResource.Site)?.url
                        copy(
                                info = info.copy(browserUrl = browser ?: info.browserUrl),
                                content =
                                    if (content is ArtifactContent.EncodedImage) {
                                        val fallback =
                                            previews[id]?.content as? ArtifactContent.Image
                                        ArtifactContent.EncodedImage(
                                            content.bytes,
                                            fallback?.bitmap,
                                        )
                                    } else content,
                                problem = null,
                            )
                            .also {
                                when {
                                    content is ArtifactContent.EncodedImage -> Unit
                                    it.hasReadableContent -> previews.remember(id, it, 3)
                                    else -> previews.remove(id)
                                }
                            }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                val errorType = problem(error)
                val failedPreview = mutable.value.preview
                if (
                    useImageViewer &&
                        detailAuthorized &&
                        errorType == ArtifactProblem.Missing &&
                        failedPreview != null &&
                        failedPreview.id == id &&
                        failedPreview.isImage &&
                        failedPreview.info?.thumbnailUrl != null
                ) {
                    updatePreview(id) {
                        previews.remove(id)
                        copy(
                            content = null,
                            access = null,
                            problem = ArtifactProblem.OriginalUnavailable,
                        )
                    }
                    val thumbnail =
                        readThumbnailAfterMissingOriginal(id, failedPreview.access?.url?.toString())
                    if (thumbnail != null) {
                        updatePreview(id) {
                            copy(content = ArtifactContent.Image(thumbnail))
                        }
                        return@launch
                    }
                }
                val revoked =
                    errorType == ArtifactProblem.Denied || errorType == ArtifactProblem.Missing
                val discardContent = revoked || errorType == ArtifactProblem.Unsupported
                updatePreview(id) {
                    if (
                        revoked &&
                            !isChatAttachmentImage(id) &&
                            chatImageVisit?.images?.any { it.source == id } == true
                    )
                        unavailableChatImages[id] = errorType
                    if (revoked && isChatAttachmentImage(id)) {
                        revokeChatImage(id, errorType)
                    } else {
                        if (discardContent) previews.remove(id)
                        if (revoked && !detailAuthorized) {
                            val source =
                                when {
                                    externalImage || chatAttachment(id) != null -> id
                                    else ->
                                        messageArtifactLink(id)?.takeIf {
                                            it.startsWith("/artifacts/")
                                        }
                                }
                            source?.let(inlineImages::revoke)
                        }
                    }
                    copy(
                        item = item.takeUnless { revoked && externalImage },
                        info = info.takeUnless { revoked && !detailAuthorized },
                        content = content.takeIf { hasReadableContent && !discardContent },
                        access =
                            access.takeUnless { revoked && (!fileAccessAuthorized || isImage) },
                        problem =
                            if (revoked && fileAccessAuthorized && !isImage)
                                ArtifactProblem.Unavailable
                            else errorType,
                    )
                }
            }
        }
    }

    private suspend fun readThumbnailAfterMissingOriginal(
        id: String,
        originalUrl: String?,
    ): Bitmap? =
        try {
            // A failed original URL can also mean access was revoked. Recheck the thumbnail path.
            val info = service.info(id)
            if (info.item.kind == ArtifactKind.Image)
                service.thumbnail(info.independentThumbnailUrl(originalUrl))
            else null
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            handleSessionFailure(error)
            null
        }

    private suspend fun updatePreview(
        id: String,
        change: ArtifactPreviewState.() -> ArtifactPreviewState,
    ) {
        currentCoroutineContext().ensureActive()
        val current = mutable.value
        val preview = current.preview?.takeIf { it.id == id } ?: return
        mutable.value = current.copy(preview = preview.change())
    }

    private fun problem(error: Exception): ArtifactProblem {
        handleSessionFailure(error)
        return artifactProblem(error)
    }

    private fun handleSessionFailure(error: Exception) {
        if (error is ApiFailure.Unauthenticated || error is ApiFailure.UpdateRequired)
            sessionFailure(error)
    }

    internal fun linkEditor(source: ArtifactLinkSource) =
        ArtifactLinkEditor(source, service.links, viewModelScope, ::handleSessionFailure)
}

private fun artifactProblem(error: Exception): ArtifactProblem =
    when (error) {
        is ChatAttachmentAccessLost -> artifactHttpProblem(error.rejection.status)
        is ApiFailure.Http -> artifactHttpProblem(error.status)
        is ResponseLimitExceeded -> ArtifactProblem.Unsupported
        is ApiFailure.Network,
        is IOException -> ArtifactProblem.Temporary
        else -> ArtifactProblem.Unavailable
    }

internal fun artifactHttpProblem(status: Int): ArtifactProblem =
    when (status) {
        401,
        402,
        403 -> ArtifactProblem.Denied
        404,
        410 -> ArtifactProblem.Missing
        408,
        429,
        in 500..599 -> ArtifactProblem.Temporary
        else -> ArtifactProblem.Unavailable
    }

internal suspend fun <T> retryArtifactOperation(
    canRetry: () -> Boolean = { true },
    operation: suspend (remainingRetries: Int) -> T,
): T {
    repeat(finiteReadRetryDelays.size) { usedRetries ->
        val remainingRetries = finiteReadRetryDelays.size - usedRetries
        try {
            return operation(remainingRetries)
        } catch (error: Exception) {
            if (
                error is CancellationException ||
                    !canRetry() ||
                    artifactProblem(error) != ArtifactProblem.Temporary
            ) {
                throw error
            }
            delay(
                artifactRetryDelayMillis(
                    remainingRetries,
                    (error as? ApiFailure.Http)?.retryAfterSeconds,
                ),
            )
        }
    }
    return operation(0)
}

internal fun artifactRetryDelayMillis(remainingRetries: Int, retryAfterSeconds: Long?): Long =
    retryAfterDelayMillis(retryAfterSeconds)
        ?: finiteReadRetryDelays[finiteReadRetryDelays.size - remainingRetries]

private fun ArtifactPreviewState.withoutSave(): ArtifactPreviewState =
    copy(access = access?.copy(save = null, previewOnly = true))

private fun <K, V> LinkedHashMap<K, V>.remember(key: K, value: V, capacity: Int) {
    this[key] = value
    if (size > capacity) remove(keys.first())
}
