package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.boundedApiRetryDelayMillis
import ai.okou.android.api.boundedRetryDelayMillis
import ai.okou.android.api.generated.defaultImageToolModel
import ai.okou.android.auth.WorkspaceIdentity
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.SetSerializer
import kotlinx.serialization.builtins.serializer

internal const val webSearchTool = "web-search"
internal const val imageGenerationTool = "image-generation"
private const val disabledToolsCache = "built-in-tools-disabled"
private const val imageModelCache = "image-generation-model"
private val disabledToolsSerializer = SetSerializer(String.serializer())

private sealed interface SettingWrite<out T> {
    data class Acknowledged<T>(val value: T) : SettingWrite<T>

    data object Rejected : SettingWrite<Nothing>

    data object NeedsReadback : SettingWrite<Nothing>
}

internal data class BuiltInToolsState(
    val catalog: SettingsRead<List<DataToolFamily>> = SettingsRead(),
    val disabled: Set<String>? = null,
    val preferencesUnavailable: Boolean = false,
    val confirmedImage: String? = null,
    val imageUnavailable: Boolean = false,
    val draftImage: String? = null,
    val savingImage: Boolean = false,
    val imageFailed: Boolean = false,
    val savingTools: Map<String, Boolean> = emptyMap(),
) {
    val displayedImage: String?
        get() = draftImage ?: confirmedImage

    fun enabled(id: String): Boolean? = savingTools[id] ?: disabled?.let { id !in it }
}

/** One authorized workspace, with an image draft that lasts for one Settings visit. */
internal class BuiltInToolsSettings(
    private val scope: CoroutineScope,
    private val service: BuiltInToolsService,
    private val identity: WorkspaceIdentity,
    private val cache: WorkspaceSettingsCache?,
    private val authorized: () -> Boolean,
    private val onSessionFailure: (Exception) -> Unit,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val notice: (SettingsNotice) -> Unit,
) {
    private val mutable = MutableStateFlow(BuiltInToolsState())
    val state = mutable.asStateFlow()
    private var visit = 0L
    private var visible = false
    private var read: Job? = null
    private var toolRevision = 0L
    private var imageRevision = 0L

    fun show() {
        visible = true
        refresh()
    }

    fun hidePage() {
        visible = false
        read?.cancel()
        read = null
        clearCatalogFeedback()
    }

    fun leaveSettings() {
        hidePage()
        visit++
        mutable.update { it.copy(draftImage = null, imageFailed = false) }
    }

    fun refresh() {
        if (!visible || !authorized()) return
        // Reconnecting starts fresh reads even if a request on the old link is still pending.
        read?.cancel()
        clearCatalogFeedback()
        read = scope.launch {
            launch { refreshCatalog() }
            launch { refreshToolPreferences() }
            launch { refreshImagePreference() }
        }
    }

    private suspend fun refreshCatalog() {
        val current = state.value.catalog
        if (current.value != null && !current.isStale(nowMillis())) return
        mutable.update {
            it.copy(
                catalog = it.catalog.copy(unavailable = false, refreshing = current.value != null),
            )
        }
        val families = readResource(reportFailure = false, load = service::catalog)
        currentCoroutineContext().ensureActive()
        if (!authorized()) return
        mutable.update {
            it.copy(
                catalog =
                    if (families == null)
                        it.catalog.copy(
                            unavailable = true,
                            refreshing = false,
                            refreshFailure = current.value?.let { SettingsRefreshFailure() },
                        )
                    else SettingsRead(value = families, readAt = nowMillis()),
            )
        }
    }

    private fun clearCatalogFeedback() {
        mutable.update {
            val catalog = it.catalog
            if (catalog.refreshing || catalog.refreshFailure != null)
                it.copy(catalog = catalog.copy(refreshing = false, refreshFailure = null))
            else it
        }
    }

    private suspend fun refreshToolPreferences() {
        if (state.value.disabled == null) {
            val saved = cache?.load(identity, disabledToolsCache, disabledToolsSerializer)
            if (saved != null && authorized()) mutable.update { it.copy(disabled = saved.value) }
        }
        val disabled =
            readPreferenceAfterWrites({ it.savingTools.isNotEmpty() }, { toolRevision }) {
                service.disabledTools()
            }
        if (!authorized()) return
        mutable.update {
            it.copy(disabled = disabled ?: it.disabled, preferencesUnavailable = disabled == null)
        }
        if (disabled != null) cacheDisabled(disabled)
    }

    private suspend fun refreshImagePreference() {
        if (state.value.confirmedImage == null) {
            val saved = cache?.load(identity, imageModelCache, String.serializer())
            if (saved != null && authorized()) {
                mutable.update { it.copy(confirmedImage = saved.value, imageUnavailable = false) }
            }
        }
        val model =
            readPreferenceAfterWrites({ it.savingImage }, { imageRevision }) {
                service.imageModel() ?: defaultImageToolModel
            }
        if (!authorized()) return
        mutable.update {
            val draft = it.draftImage.takeUnless { draft -> draft == model }
            it.copy(
                confirmedImage = model ?: it.confirmedImage,
                imageUnavailable = model == null && it.confirmedImage == null,
                draftImage = draft,
                imageFailed = it.imageFailed && draft != null,
            )
        }
        if (model != null) cacheImage(model)
    }

    private suspend fun <T : Any> readPreferenceAfterWrites(
        writing: (BuiltInToolsState) -> Boolean,
        revision: () -> Long,
        load: suspend () -> T,
    ): T? {
        while (authorized()) {
            state.first { !writing(it) }
            val before = revision()
            val value = readResource(load = load)
            if (before == revision()) return value
        }
        return null
    }

    fun toggle(id: String, enabled: Boolean) {
        val current = state.value
        val displayed = current.enabled(id)
        if (!visible || !authorized() || displayed == null || displayed == enabled) return
        val currentVisit = visit
        toolRevision++
        mutable.update { it.copy(savingTools = it.savingTools + (id to enabled)) }
        if (id !in current.savingTools) scope.launch { saveTool(id, enabled, currentVisit) }
    }

    private suspend fun saveTool(id: String, first: Boolean, currentVisit: Long) {
        var attempted = first
        while (authorized()) {
            val write = writeWithRetry { service.setEnabled(id, attempted) } ?: return
            val confirmed =
                when (write) {
                    is SettingWrite.Acknowledged -> write.value
                    SettingWrite.Rejected -> null
                    SettingWrite.NeedsReadback -> verifyToolWrite(id, attempted)
                }
            currentCoroutineContext().ensureActive()
            if (!authorized()) return
            val latest = state.value.savingTools.getValue(id)
            val followUp = confirmed != null && latest != attempted && latest != confirmed
            toolRevision++
            mutable.update { value ->
                value.copy(
                    disabled =
                        value.disabled?.let { disabled ->
                            when (confirmed) {
                                true -> disabled - id
                                false -> disabled + id
                                null -> disabled
                            }
                        },
                    savingTools = if (followUp) value.savingTools else value.savingTools - id,
                    draftImage =
                        value.draftImage.takeUnless {
                            id == imageGenerationTool && confirmed == false && !followUp
                        },
                    imageFailed =
                        value.imageFailed &&
                            !(id == imageGenerationTool && confirmed == false && !followUp),
                )
            }
            if (confirmed != null) state.value.disabled?.let(::cacheDisabled)
            if (!followUp) {
                if (currentVisit == visit) {
                    when {
                        confirmed == null && write != SettingWrite.Rejected ->
                            notice(SettingsNotice.ToolSaveUnconfirmed)
                        state.value.enabled(id) != latest -> notice(SettingsNotice.ToolSaveFailed)
                    }
                }
                return
            }
            attempted = latest
        }
    }

    private suspend fun verifyToolWrite(id: String, attempted: Boolean): Boolean? = readResource {
        val observed = id !in service.disabledTools()
        val latest = state.value.savingTools.getValue(id)
        val evidence = settingReadback(attempted, latest) { it == observed }
        // A stale value cannot settle the write or release another PATCH for the same tool.
        observed.takeUnless { evidence == SettingReadback.Unconfirmed }
    }

    fun chooseImage(id: String) {
        val current = state.value
        if (
            !visible ||
                !authorized() ||
                current.enabled(imageGenerationTool) != true ||
                imageGenerationTool in current.savingTools ||
                current.savingImage ||
                current.confirmedImage == null
        )
            return
        if (current.confirmedImage == id && current.draftImage == null) return
        imageRevision++
        mutable.update { it.copy(draftImage = id, savingImage = true, imageFailed = false) }
        scope.launch {
            val write =
                writeWithRetry { service.selectImageModel(id) ?: defaultImageToolModel }
                    ?: return@launch
            val model =
                when (write) {
                    is SettingWrite.Acknowledged -> write.value
                    SettingWrite.Rejected,
                    SettingWrite.NeedsReadback ->
                        readResource { service.imageModel() ?: defaultImageToolModel }
                }
            currentCoroutineContext().ensureActive()
            if (!authorized()) return@launch
            imageRevision++
            mutable.update {
                val failed = model != id && it.draftImage == id
                it.copy(
                    confirmedImage = model ?: it.confirmedImage,
                    draftImage = id.takeIf { failed },
                    savingImage = false,
                    imageFailed = failed,
                )
            }
            if (model != null) state.value.confirmedImage?.let(::cacheImage)
        }
    }

    private suspend fun <T : Any> readResource(
        reportFailure: Boolean = true,
        load: suspend () -> T?,
    ): T? {
        var retries = 0
        while (authorized()) {
            val wait =
                try {
                    load()?.let {
                        return it
                    }
                    // A readback can succeed without confirming the attempted value.
                    boundedRetryDelayMillis(retries)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    if (reportFailure && authorized()) onSessionFailure(error)
                    if (error is IOException) boundedRetryDelayMillis(retries, error)
                    else error.boundedApiRetryDelayMillis(retries)
                }
            if (wait == null || !authorized()) return null
            retries++
            delay(wait)
            currentCoroutineContext().ensureActive()
        }
        return null
    }

    private suspend fun <T : Any> writeWithRetry(send: suspend () -> T): SettingWrite<T>? {
        var retries = 0
        while (authorized()) {
            try {
                return SettingWrite.Acknowledged(send())
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                if (authorized()) onSessionFailure(error)
                if (!authorized()) return null
                val undelivered = error is ApiFailure.Network && error.connectionFailed
                val throttled = error is ApiFailure.Http && error.status == 429
                val wait =
                    if (undelivered || throttled) boundedRetryDelayMillis(retries++, error)
                    else null
                if (wait == null) {
                    return if (
                        undelivered ||
                            error.definitivelyRejectedWrite() ||
                            error is ApiFailure.UpdateRequired
                    )
                        SettingWrite.Rejected
                    else SettingWrite.NeedsReadback
                }
                delay(wait)
                currentCoroutineContext().ensureActive()
            }
        }
        return null
    }

    private fun cacheDisabled(value: Set<String>) {
        cache?.save(
            identity,
            disabledToolsCache,
            disabledToolsSerializer,
            ConfirmedSetting(value, System.currentTimeMillis()),
        )
    }

    private fun cacheImage(value: String) {
        cache?.save(
            identity,
            imageModelCache,
            String.serializer(),
            ConfirmedSetting(value, System.currentTimeMillis()),
        )
    }
}
