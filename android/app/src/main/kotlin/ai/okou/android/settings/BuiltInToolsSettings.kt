package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.defaultImageToolModel
import ai.okou.android.auth.WorkspaceIdentity
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.SetSerializer
import kotlinx.serialization.builtins.serializer

internal const val webSearchTool = "web-search"
internal const val imageGenerationTool = "image-generation"
private const val disabledToolsCache = "built-in-tools-disabled"
private const val imageModelCache = "image-generation-model"
private val disabledToolsSerializer = SetSerializer(String.serializer())

internal data class BuiltInToolsState(
    val catalog: SettingsRead<List<DataToolFamily>> = SettingsRead(),
    val disabled: Set<String>? = null,
    val preferencesUnavailable: Boolean = false,
    val confirmedImage: String? = null,
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
    }

    fun leaveSettings() {
        hidePage()
        visit++
        mutable.update { it.copy(draftImage = null, imageFailed = false) }
    }

    fun refresh() {
        if (!visible || !authorized() || read?.isActive == true) return
        val tools = toolRevision
        val image = imageRevision
        val snapshot = state.value
        read = scope.launch {
            coroutineScope {
                if (
                    snapshot.catalog.value == null ||
                        snapshot.catalog.isStale(System.currentTimeMillis())
                )
                    launch {
                        mutable.update { it.copy(catalog = it.catalog.copy(refreshing = true)) }
                        val families = readResource(reportFailure = false) { service.catalog() }
                        if (authorized())
                            mutable.update {
                                it.copy(
                                    catalog =
                                        if (families == null)
                                            it.catalog.copy(unavailable = true, refreshing = false)
                                        else
                                            SettingsRead(
                                                value = families,
                                                readAt = System.currentTimeMillis(),
                                            ),
                                )
                            }
                    }
                if (snapshot.savingTools.isEmpty())
                    launch {
                        if (snapshot.disabled == null) {
                            val saved =
                                cache?.load(identity, disabledToolsCache, disabledToolsSerializer)
                            if (saved != null && authorized() && tools == toolRevision) {
                                mutable.update { it.copy(disabled = saved.value) }
                            }
                        }
                        val disabled = readResource { service.disabledTools() }
                        if (authorized() && tools == toolRevision) {
                            mutable.update {
                                it.copy(
                                    disabled = disabled ?: it.disabled,
                                    preferencesUnavailable = disabled == null,
                                )
                            }
                            if (disabled != null) cacheDisabled(disabled)
                        }
                    }
                if (!snapshot.savingImage)
                    launch {
                        if (snapshot.confirmedImage == null) {
                            val saved = cache?.load(identity, imageModelCache, String.serializer())
                            if (saved != null && authorized() && image == imageRevision) {
                                mutable.update { it.copy(confirmedImage = saved.value) }
                            }
                        }
                        val model = readResource { service.imageModel() ?: defaultImageToolModel }
                        if (model != null && authorized() && image == imageRevision) {
                            mutable.update { it.copy(confirmedImage = model) }
                            cacheImage(model)
                        }
                    }
            }
        }
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
            val confirmed =
                save({ service.setEnabled(id, attempted) }) { id !in service.disabledTools() }
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
                        confirmed == null -> notice(SettingsNotice.ToolSaveUnconfirmed)
                        confirmed != latest -> notice(SettingsNotice.ToolSaveFailed)
                    }
                }
                return
            }
            attempted = latest
        }
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
        val currentVisit = visit
        imageRevision++
        mutable.update { it.copy(draftImage = id, savingImage = true, imageFailed = false) }
        scope.launch {
            val model =
                save({ service.selectImageModel(id) ?: defaultImageToolModel }) {
                    service.imageModel() ?: defaultImageToolModel
                }
            if (!authorized()) return@launch
            imageRevision++
            mutable.update {
                val failed =
                    model != id && currentVisit == visit && it.enabled(imageGenerationTool) == true
                it.copy(
                    confirmedImage = model ?: it.confirmedImage,
                    draftImage = id.takeIf { failed },
                    savingImage = false,
                    imageFailed = failed,
                )
            }
            if (model != null) cacheImage(model)
        }
    }

    private suspend fun <T : Any> readResource(
        reportFailure: Boolean = true,
        load: suspend () -> T,
    ): T? {
        repeat(settingsReadAttempts) { attempt ->
            if (!authorized()) return null
            try {
                return load()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (reportFailure) onSessionFailure(error)
                if (
                    attempt == settingsReadAttempts - 1 ||
                        !error.retryableSettingsRead() && error !is IOException
                )
                    return null
                delay(settingsReadRetryDelayMillis)
            }
        }
        return null
    }

    private suspend fun <T : Any> save(send: suspend () -> T, readBack: suspend () -> T): T? {
        repeat(settingsReadAttempts) { attempt ->
            if (!authorized()) return null
            try {
                return send()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (authorized()) onSessionFailure(error)
                val undelivered = error is ApiFailure.Network && error.connectionFailed
                val throttled = error is ApiFailure.Http && error.status == 429
                if ((!undelivered && !throttled) || attempt == settingsReadAttempts - 1) {
                    return readResource(load = readBack)
                }
                delay(settingsReadRetryDelayMillis)
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
