package ai.okou.android.artifacts

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.ResponseLimitExceeded
import android.graphics.Bitmap
import android.util.LruCache
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import java.io.IOException
import java.io.OutputStream
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

internal enum class ArtifactProblem {
    Denied,
    Missing,
    Temporary,
    Unavailable,
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
    val isHosted: Boolean
        get() =
            info?.resource !is ArtifactResource.File &&
                (item?.kind == ArtifactKind.Website || item?.kind == ArtifactKind.Presentation)
}

internal enum class ArtifactSaveResult {
    Saving,
    Saved,
    Denied,
    Failed,
}

internal enum class ArtifactCatalogRead {
    Refreshing,
    More,
}

internal data class ArtifactCatalogState(
    val query: ArtifactQuery = ArtifactQuery(),
    val page: ArtifactPage? = null,
    val offline: Boolean = false,
    val problem: ArtifactProblem? = null,
    val reading: ArtifactCatalogRead? = null,
    val preview: ArtifactPreviewState? = null,
    val saveResult: Pair<String, ArtifactSaveResult>? = null,
) {
    val saving: Boolean
        get() = saveResult?.second == ArtifactSaveResult.Saving
}

/** One authorized workspace owns the catalog requests and a small in-memory preview cache. */
class ArtifactCatalogModel
internal constructor(
    private val service: ArtifactService,
    connectivity: Flow<Boolean>,
    private val sessionFailure: (Exception) -> Unit,
) : ViewModel() {
    private val mutable = MutableStateFlow(ArtifactCatalogState())
    internal val state = mutable.asStateFlow()
    private val catalogs = LinkedHashMap<ArtifactQuery, ArtifactPage>(8, 0.75f, true)
    private val previews = LinkedHashMap<String, ArtifactPreviewState>(3, 0.75f, true)
    private val thumbnails = LruCache<String, Bitmap>(40)
    private var active = false
    private var catalogVisible = false
    private var catalogJob: Job? = null
    private var previewJob: Job? = null

    init {
        viewModelScope.launch {
            connectivity.collect { online ->
                val current = mutable.value
                if (online == !current.offline) return@collect
                val preview = current.preview
                mutable.value =
                    current.copy(
                        offline = !online,
                        reading = null,
                        page = current.page ?: if (online) null else cachedResults(current.query),
                        preview =
                            if (!online && preview?.isHosted == true)
                                preview.copy(content = null, problem = null)
                            else preview,
                    )
                if (online && active) {
                    readCatalog()
                    mutable.value.preview?.let { readPreview(it.id) }
                } else if (!online) {
                    catalogJob?.cancel()
                    previewJob?.cancel()
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
                else readCatalog()
            }
            mutable.value.preview?.let { readPreview(it.id) }
        } else {
            catalogJob?.cancel()
            previewJob?.cancel()
            mutable.update { it.copy(reading = null) }
        }
    }

    internal fun query(next: ArtifactQuery, debounce: Boolean) {
        if (next == mutable.value.query) return
        catalogJob?.cancel()
        val cached = catalogs[next] ?: if (mutable.value.offline) cachedResults(next) else null
        mutable.update { it.copy(query = next, page = cached, problem = null, reading = null) }
        readCatalog(debounce = debounce)
    }

    internal fun loadNext() {
        val current = mutable.value
        if (current.reading != null || current.problem != null || current.page?.nextCursor == null)
            return
        readCatalog(append = true)
    }

    internal fun select(id: String?, item: ArtifactItem? = null) {
        if (mutable.value.preview?.id == id) return
        previewJob?.cancel()
        val initial =
            id?.let {
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

    internal suspend fun thumbnail(url: String, offline: Boolean): Bitmap? {
        thumbnails.get(url)?.let {
            return it
        }
        if (offline) return null
        return try {
            service.thumbnail(url)?.also { thumbnails.put(url, it) }
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
            val result =
                try {
                    val file =
                        cached
                            ?: service.info(id).let { info ->
                                (info.resource as? ArtifactResource.File)?.let {
                                    (info.resolvedAccess ?: service.fileAccess(it)).save
                                }
                            }
                    if (file == null) ArtifactSaveResult.Denied
                    else {
                        service.save(file, destination)
                        ArtifactSaveResult.Saved
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    handleSessionFailure(error)
                    if (error is ApiFailure.Http && error.status in 401..404) {
                        ArtifactSaveResult.Denied
                    } else ArtifactSaveResult.Failed
                }
            if (result == ArtifactSaveResult.Denied) {
                previews[id]?.let { previews[id] = it.withoutSave() }
            }
            mutable.update {
                val preview = it.preview
                it.copy(
                    saveResult = id to result,
                    preview =
                        if (result == ArtifactSaveResult.Denied && preview?.id == id)
                            preview.withoutSave()
                        else preview,
                )
            }
        }
    }

    private fun readCatalog(append: Boolean = false, debounce: Boolean = false) {
        val current = mutable.value
        if (!catalogVisible || current.offline) return
        catalogJob?.cancel()
        val query = current.query
        val cursor = if (append) current.page?.nextCursor ?: return else null
        mutable.update {
            it.copy(
                problem = null,
                reading = if (append) ArtifactCatalogRead.More else ArtifactCatalogRead.Refreshing,
            )
        }
        catalogJob =
            viewModelScope.launch {
                if (debounce) delay(250)
                retryRead { attempt ->
                    try {
                        val targetSize = if (append) 0 else current.page?.items?.size ?: 0
                        val fresh = loadPages(query, cursor, targetSize)
                        val merged =
                            if (append) {
                                val existing = checkNotNull(current.page)
                                ArtifactPage(
                                    (existing.items + fresh.items).distinctBy { it.id },
                                    fresh.nextCursor,
                                )
                            } else fresh
                        currentCoroutineContext().ensureActive()
                        catalogs.remember(query, merged, 8)
                        mutable.update { it.copy(page = merged, problem = null, reading = null) }
                        false
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        val problem = problem(error)
                        currentCoroutineContext().ensureActive()
                        val denied = problem == ArtifactProblem.Denied
                        if (denied || problem == ArtifactProblem.Missing) {
                            catalogs.clear()
                        }
                        if (denied) {
                            previewJob?.cancel()
                            previews.clear()
                            thumbnails.evictAll()
                        }
                        mutable.update {
                            it.copy(
                                page = if (catalogs.isEmpty()) null else it.page,
                                preview =
                                    if (denied)
                                        it.preview?.let { preview ->
                                            ArtifactPreviewState(
                                                preview.id,
                                                preview.item,
                                                problem = problem,
                                            )
                                        }
                                    else it.preview,
                                problem =
                                    problem.takeIf {
                                        it != ArtifactProblem.Temporary ||
                                            current.page == null ||
                                            attempt > 0
                                    },
                                reading =
                                    if (problem == ArtifactProblem.Temporary)
                                        ArtifactCatalogRead.Refreshing
                                    else null,
                            )
                        }
                        problem == ArtifactProblem.Temporary
                    }
                }
            }
    }

    private fun cachedResults(query: ArtifactQuery): ArtifactPage? {
        val byType = catalogs[query.copy(keyword = "")]
        val all = catalogs[ArtifactQuery(chatThreadId = query.chatThreadId)]
        if (byType == null && all == null) return null
        val confirmed = (byType?.items.orEmpty() + all?.items.orEmpty()).distinctBy { it.id }
        val matching =
            confirmed
                .filter {
                    (query.filter.kind == null || query.filter.kind == it.kind) &&
                        (query.keyword.isEmpty() ||
                            it.title.contains(query.keyword, ignoreCase = true))
                }
                .sortedWith(
                    compareByDescending<ArtifactItem> { it.createdAt }.thenByDescending { it.id }
                )
        return ArtifactPage(matching, null)
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
            val page = service.page(query, next)
            page.items.forEach { items.putIfAbsent(it.id, it) }
            next = page.nextCursor
        } while (next != null && items.size < targetSize)
        return ArtifactPage(items.values.toList(), next)
    }

    private fun readPreview(id: String) {
        if (!active || mutable.value.offline) return
        previewJob?.cancel()
        previewJob =
            viewModelScope.launch {
                retryRead {
                    var detailAuthorized = false
                    try {
                        val info = service.info(id)
                        detailAuthorized = true
                        updatePreview(id) { copy(item = info.item, info = info, problem = null) }
                        val content =
                            when (val resource = info.resource) {
                                is ArtifactResource.File -> {
                                    val access = info.resolvedAccess ?: service.fileAccess(resource)
                                    updatePreview(id) { copy(access = access) }
                                    service.fileContent(resource, access)
                                }
                                is ArtifactResource.Site -> service.siteContent(resource)
                                is ArtifactResource.ResolvedHtml ->
                                    ArtifactContent.Website(resource.url)
                                ArtifactResource.Unsupported -> ArtifactContent.Unsupported
                            }
                        updatePreview(id) {
                            val browser = (info.resource as? ArtifactResource.Site)?.url
                            copy(
                                    info = info.copy(browserUrl = browser ?: info.browserUrl),
                                    content = content,
                                    problem = null,
                                )
                                .also {
                                    if (
                                        content is ArtifactContent.Text ||
                                            content is ArtifactContent.Image
                                    ) {
                                        previews.remember(id, it, 3)
                                    }
                                }
                        }
                        false
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        val errorType = problem(error)
                        val revoked =
                            errorType == ArtifactProblem.Denied ||
                                errorType == ArtifactProblem.Missing
                        updatePreview(id) {
                            if (revoked) previews.remove(id)
                            val hosted = detailAuthorized && info?.resource is ArtifactResource.Site
                            copy(
                                info = if (revoked && !hosted) null else info,
                                content =
                                    if (revoked || errorType == ArtifactProblem.Unsupported) null
                                    else content,
                                access = if (revoked) null else access,
                                problem = errorType,
                            )
                        }
                        errorType == ArtifactProblem.Temporary
                    }
                }
            }
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
        return when (error) {
            is ApiFailure.Http ->
                when (error.status) {
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
            is ResponseLimitExceeded -> ArtifactProblem.Unsupported
            is ApiFailure.Network,
            is IOException -> ArtifactProblem.Temporary
            else -> ArtifactProblem.Unavailable
        }
    }

    private fun handleSessionFailure(error: Exception) {
        if (error is ApiFailure.Unauthenticated || error is ApiFailure.UpdateRequired)
            sessionFailure(error)
    }
}

private fun ArtifactPreviewState.withoutSave(): ArtifactPreviewState =
    copy(access = access?.copy(save = null, previewOnly = true))

private suspend inline fun retryRead(read: (attempt: Int) -> Boolean) {
    var attempt = 0
    while (read(attempt)) {
        delay(2_000L shl attempt)
        attempt = (attempt + 1).coerceAtMost(4)
    }
}

private fun <K, V> LinkedHashMap<K, V>.remember(key: K, value: V, capacity: Int) {
    this[key] = value
    if (size > capacity) remove(keys.first())
}
