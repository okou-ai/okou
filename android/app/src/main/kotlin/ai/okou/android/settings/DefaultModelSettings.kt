package ai.okou.android.settings

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.RecoveryCatalog
import ai.okou.android.api.generated.RecoveryModels
import ai.okou.android.api.generated.RecoveryModelsModelsItemMemberEffectiveAvailability
import ai.okou.android.api.generated.RecoveryModelsModelsItemSubscriptionOptionsServiceTier
import ai.okou.android.api.generated.UpdateDefaultModelPreference
import ai.okou.android.api.generated.UpdateDefaultModelPreferenceModelSettingsPatch
import ai.okou.android.api.generated.UpdateDefaultModelPreferenceModelSettingsPatchEffort
import ai.okou.android.api.generated.UpdateDefaultModelPreferenceServiceTier
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.state.SettingsDestination
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private val retryDelays = listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L)
private val preferenceSaveRetryDelays = listOf(3_000L, 3_000L)
private const val preferenceRefreshMillis = 10 * 60_000L
private const val catalogFailureWindowMillis = 30_000L

internal typealias ModelEffort = UpdateDefaultModelPreferenceModelSettingsPatchEffort

internal fun isAutoDefaultModel(id: String?): Boolean =
    id == null || id == "auto" || id == "okou-1.0"

internal data class DefaultModelChoice(
    val id: String,
    val label: String,
    val canSelect: Boolean,
    val efforts: List<ModelEffort>,
    val defaultEffort: ModelEffort?,
    val fastMultiplier: Double?,
)

internal data class DefaultModelOptions(
    val choices: List<DefaultModelChoice>,
    val replacements: Map<String, String>,
) {
    fun resolve(id: String?): String? = id?.let(replacements::get)?.takeUnless(::isAutoDefaultModel)
}

private fun modelOptions(
    models: RecoveryModels,
    catalog: RecoveryCatalog,
    codexExecution: Boolean,
): DefaultModelOptions {
    val available = models.models.associateBy { it.model }
    val choices =
        catalog.models
            .sortedBy { it.sortOrder }
            .mapNotNull { model ->
                if (model.replacedBy != null || isAutoDefaultModel(model.model)) {
                    return@mapNotNull null
                }
                val run = available[model.model] ?: return@mapNotNull null
                val effective = run.memberEffective
                val provider = effective.providerType.name.lowercase().replace('_', '-')
                val runtime = effective.runtimeProviderType?.name?.lowercase()?.replace('_', '-')
                val routes =
                    catalog.routes
                        .filter {
                            it.model == model.model &&
                                it.enabled &&
                                it.providerType == provider &&
                                it.concreteProviderType == runtime
                        }
                        .sortedBy { it.priority }
                val subscription = run.subscriptionOptions
                val admitted = subscription?.efforts?.map { it.name }
                val usesPi = !codexExecution && routes.any { it.piRuntimeCapable == true }
                val efforts =
                    routes
                        .flatMap { route -> route.efforts }
                        .mapNotNull { wire ->
                            ModelEffort.entries.find { it.name.equals(wire, ignoreCase = true) }
                        }
                        .filter {
                            it != ModelEffort.ULTRACODE &&
                                (!usesPi || it != ModelEffort.ULTRA) &&
                                (admitted == null || it.name in admitted)
                        }
                        .distinct()
                val defaultEffort = routes.firstNotNullOfOrNull { it.defaultEffort }
                DefaultModelChoice(
                    model.model,
                    model.displayName,
                    effective.availability !=
                        RecoveryModelsModelsItemMemberEffectiveAvailability.PLAN_RESTRICTED,
                    efforts,
                    efforts.firstOrNull { it.name.equals(defaultEffort, ignoreCase = true) },
                    model.runOptions?.fast?.chatGptUsageMultiplier?.takeIf {
                        subscription?.serviceTier ==
                            RecoveryModelsModelsItemSubscriptionOptionsServiceTier.PRIORITY
                    },
                )
            }
    return DefaultModelOptions(choices, catalog.models.associate { it.model to it.resolvedModel })
}

internal enum class DefaultModelNotice {
    SyncFailed,
    LocalSaveFailed,
}

/** Retry state belongs to the current authorized workspace owner. */
internal data class DefaultModelSave(
    val failedAttempts: Int = 0,
    val lastFailureMillis: Long? = null,
)

internal data class DefaultModelState(
    val record: DefaultModelRecord? = null,
    val save: DefaultModelSave? = null,
    val options: DefaultModelOptions? = null,
    val offline: Boolean = false,
    val catalogUnavailable: Boolean = false,
    val saveDegraded: Boolean = false,
) {
    val pending: UpdateDefaultModelPreference?
        get() = if (save != null) record?.edit?.request else null

    val selected: DefaultModelChoice?
        get() {
            val id = options?.resolve(record?.selectedModel)
            return options?.choices?.firstOrNull { it.id == id }
        }

    val fast: Boolean
        get() =
            selected?.fastMultiplier != null &&
                if (record?.edit != null) record.edit.request.serviceTier != null
                else record?.confirmed?.serviceTier != null

    val effort: ModelEffort?
        get() {
            val choice = selected ?: return null
            val name =
                record?.efforts?.get(choice.id)?.name
                    ?: record?.confirmed?.modelSettings?.get(choice.id)?.effort?.name
            return choice.efforts.firstOrNull { it.name == name } ?: choice.defaultEffort
        }
}

/** Owns one authorized workspace's cached default, writes, and foreground refresh. */
internal class DefaultModelSettings(
    private val scope: CoroutineScope,
    private val service: WorkspaceSession,
    private val identity: WorkspaceIdentity,
    private val store: DefaultModelStore,
    private val authorized: () -> Boolean,
    private val nowMillis: () -> Long = System::currentTimeMillis,
    private val onFailure: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(DefaultModelState())
    val state = mutable.asStateFlow()
    private val messages = Channel<DefaultModelNotice>(1, BufferOverflow.DROP_OLDEST)
    val notices = messages.receiveAsFlow()
    private val preferenceRequests = Mutex()
    private var presented = false
    private var foreground = false
    private var destination: SettingsDestination? = null
    private var preferenceRead: Job? = null
    private var catalogRead: Job? = null
    private var saving: Job? = null
    private var saveWait: Job? = null
    private var storageWrite: Deferred<Boolean>? = null
    private var needsReadback = false
    private var readbackBlocked = false

    init {
        scope.launch {
            if (!authorized()) return@launch
            val record = store.load(identity)
            currentCoroutineContext().ensureActive()
            if (!authorized()) return@launch
            mutable.value = mutable.value.copy(record = record)
            if (mutable.value.options != null) publish(record)
            synchronizeReads()
        }
    }

    fun showSettings(page: SettingsDestination?) {
        if (presented && destination == page) return
        if (destination == null && page != null) resumeReadback()
        presented = true
        destination = page
        synchronizeReads()
    }

    fun foreground(active: Boolean) {
        if (foreground == active) return
        foreground = active
        synchronizeReads()
    }

    fun online(online: Boolean) {
        val current = mutable.value
        if (current.offline == !online) return
        mutable.value = current.copy(offline = !online, catalogUnavailable = false)
        saveWait?.cancel()
        if (online) resumeReadback()
        synchronizeReads()
    }

    fun select(id: String?) {
        val value = mutable.value
        val options = value.options ?: return
        val choice = options.choices.firstOrNull { it.id == id }
        if (value.selected?.id == id || id != null && choice?.canSelect != true) return
        submit(id, fast = false, choice = choice)
    }

    fun effort(effort: ModelEffort) {
        val value = mutable.value
        val choice = value.selected ?: return
        if (!choice.canSelect || effort !in choice.efforts || effort == value.effort) return
        submit(choice.id, value.fast, choice, effort)
    }

    fun fast(enabled: Boolean) {
        val value = mutable.value
        val choice = value.selected ?: return
        if (!choice.canSelect || choice.fastMultiplier == null || enabled == value.fast) return
        submit(choice.id, enabled, choice)
    }

    private fun submit(
        id: String?,
        fast: Boolean,
        choice: DefaultModelChoice?,
        effort: ModelEffort? = null,
    ) {
        val current = mutable.value
        val record = current.record ?: return
        if (!authorized()) return
        val efforts =
            if (id != null && effort != null) record.efforts + (id to effort) else record.efforts
        val patch =
            choice?.let { model ->
                efforts[model.id]
                    ?.takeIf { it in model.efforts }
                    ?.let { UpdateDefaultModelPreferenceModelSettingsPatch(model.id, it) }
            }
        val request =
            UpdateDefaultModelPreference(
                id,
                if (fast) UpdateDefaultModelPreferenceServiceTier.PRIORITY else null,
                patch,
            )
        clearSaveFailure()
        publish(
            record.copy(edit = DefaultModelEdit(request), efforts = efforts),
            save = DefaultModelSave(),
        )
        saveWait?.cancel()
        resumeReadback()
    }

    private fun resumeReadback() {
        readbackBlocked = false
        synchronizeSaves()
    }

    private fun synchronizeReads() {
        val current = mutable.value
        val active = foreground && !current.offline && authorized()
        val refresh = active && presented && destination == null && current.record != null
        if (!refresh) {
            preferenceRead?.cancel()
            preferenceRead = null
        } else if (preferenceRead?.isActive != true) {
            preferenceRead = scope.launch { refreshPreferences() }
        }

        val catalogVisible =
            active &&
                (destination == SettingsDestination.Overview ||
                    destination == SettingsDestination.Instructions)
        if (!catalogVisible) {
            catalogRead?.cancel()
            catalogRead = null
        } else if (catalogRead == null) {
            catalogRead = scope.launch { refreshCatalog() }
        }
    }

    private suspend fun refreshPreferences() {
        var failures = 0
        while (authorized()) {
            val last = mutable.value.record?.lastRefreshMillis
            val age = last?.let { nowMillis() - it }
            if (age != null && age in 0 until preferenceRefreshMillis) {
                delay(preferenceRefreshMillis - age)
            }
            state.first { it.canApplyScheduledRead }
            try {
                preferenceRequests.withLock {
                    val before = mutable.value
                    if (!before.canApplyScheduledRead) return@withLock
                    val remote = service.defaultModelPreference()
                    currentCoroutineContext().ensureActive()
                    if (!authorized()) return
                    if (before.record?.edit !== mutable.value.record?.edit) return@withLock
                    needsReadback = false
                    readbackBlocked = false
                    clearSaveFailure()
                    publish(
                        DefaultModelRecord(confirmed = remote, lastRefreshMillis = nowMillis()),
                        save = null,
                    )
                    saveWait?.cancel()
                }
                failures = 0
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                onFailure(error)
                delay(if (error.retryable()) retryDelay(++failures) else preferenceRefreshMillis)
            }
        }
    }

    private suspend fun refreshCatalog() {
        var failures = 0
        var firstFailure = 0L
        while (authorized()) {
            try {
                val options = loadOptions()
                currentCoroutineContext().ensureActive()
                if (!authorized()) return
                mutable.value = mutable.value.copy(options = options, catalogUnavailable = false)
                mutable.value.record?.let { publish(it) }
                return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                onFailure(error)
                if (!authorized()) return
                if (failures++ == 0) firstFailure = nowMillis()
                if (mutable.value.options == null || !error.retryable()) showCatalogFailure()
                if (!error.retryable()) return

                var untilRetry = retryDelay(failures)
                if (failures >= 3 && !mutable.value.catalogUnavailable) {
                    val untilNotice =
                        (catalogFailureWindowMillis - (nowMillis() - firstFailure)).coerceAtLeast(0)
                    if (untilNotice <= untilRetry) {
                        delay(untilNotice)
                        if (!authorized()) return
                        showCatalogFailure()
                        untilRetry -= untilNotice
                    }
                }
                delay(untilRetry)
            }
        }
    }

    private fun showCatalogFailure() {
        mutable.value = mutable.value.copy(catalogUnavailable = true)
    }

    private fun synchronizeSaves() {
        if (!canSave() || saving != null) return
        val job =
            scope.launch(start = CoroutineStart.LAZY) {
                try {
                    savePreferences()
                } finally {
                    saving = null
                    synchronizeSaves()
                }
            }
        saving = job
        job.start()
    }

    private fun canSave(): Boolean =
        authorized() && !mutable.value.offline && !readbackBlocked && mutable.value.pending != null

    private suspend fun savePreferences() {
        while (canSave()) {
            val retryMillis =
                preferenceRequests.withLock {
                    if (!canSave()) return
                    val save = checkNotNull(mutable.value.save)
                    val elapsed = save.lastFailureMillis?.let { nowMillis() - it }
                    val delay = preferenceSaveRetryDelays.getOrNull(save.failedAttempts - 1)
                    if (elapsed != null && delay != null && elapsed in 0 until delay) {
                        return@withLock delay - elapsed
                    }
                    val disk = storageWrite
                    val durable = disk?.await() ?: true
                    if (!canSave()) return
                    if (save !== mutable.value.save) return@withLock 0L
                    val request = checkNotNull(mutable.value.pending)
                    val readback = needsReadback
                    try {
                        val remote =
                            if (readback) service.defaultModelPreference()
                            else {
                                needsReadback = true
                                service.updateDefaultModelPreference(request)
                            }
                        currentCoroutineContext().ensureActive()
                        if (!authorized()) return
                        val current = mutable.value
                        val latest = current.pending
                        val confirmedRequest =
                            if (readback) latest?.takeIf { it.matches(remote) } else request
                        needsReadback = false
                        if (confirmedRequest != null) {
                            val fulfilled = latest == confirmedRequest
                            if (fulfilled) clearSaveFailure()
                            publish(
                                checkNotNull(current.record)
                                    .confirm(confirmedRequest, remote, fulfilled),
                                save = current.save.takeUnless { fulfilled },
                            )
                        }
                        0L
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (error: Exception) {
                        currentCoroutineContext().ensureActive()
                        onFailure(error)
                        if (!authorized()) return
                        val retryable =
                            error.retryable() || error is ApiFailure.IncompatibleResponse
                        if (!retryable && !readback) needsReadback = false
                        val current = mutable.value
                        if (current.save !== save) return@withLock 0L
                        if (!retryable && readback) {
                            // A rejected read cannot tell us whether the write committed.
                            readbackBlocked = true
                            reportSaveFailure(durable)
                            return
                        }
                        if (retryable && save.failedAttempts < preferenceSaveRetryDelays.size) {
                            mutable.value =
                                current.copy(
                                    save =
                                        save.copy(
                                            failedAttempts = save.failedAttempts + 1,
                                            lastFailureMillis = nowMillis(),
                                        )
                                )
                        } else {
                            reportSaveFailure(durable, save = null)
                        }
                        0L
                    }
                }
            if (retryMillis > 0 && canSave()) waitToSave(retryMillis)
        }
    }

    private suspend fun waitToSave(millis: Long) = coroutineScope {
        val wait = launch { delay(millis) }
        saveWait = wait
        try {
            wait.join()
        } finally {
            saveWait = null
        }
    }

    private fun reportSaveFailure(durable: Boolean, save: DefaultModelSave? = mutable.value.save) {
        val current = mutable.value
        mutable.value = current.copy(save = save, saveDegraded = true)
        if (current.saveDegraded) return
        messages.trySend(
            if (durable) DefaultModelNotice.SyncFailed else DefaultModelNotice.LocalSaveFailed
        )
    }

    private fun clearSaveFailure() {
        val current = mutable.value
        if (!current.saveDegraded) return
        mutable.value = current.copy(saveDegraded = false)
        messages.tryReceive()
    }

    private fun publish(record: DefaultModelRecord, save: DefaultModelSave? = mutable.value.save) {
        val state = mutable.value
        val label =
            if (state.options != null) {
                val model = state.options.resolve(record.selectedModel)
                state.options.choices.firstOrNull { it.id == model }?.label
            } else
                state.record?.label?.takeIf { state.record.selectedModel == record.selectedModel }
        val updated = record.copy(label = label)
        mutable.value = state.copy(record = updated, save = save)
        if (updated == state.record) return
        val write = store.save(identity, updated)
        storageWrite = write
        if (save != null) {
            scope.launch {
                if (!write.await() && mutable.value.record == updated && mutable.value.offline) {
                    reportSaveFailure(durable = false)
                }
            }
        }
    }

    private suspend fun loadOptions() = coroutineScope {
        val catalog = async { service.recoveryCatalog() }
        val models = async { service.recoveryModels() }
        val available = models.await()
        val currentCatalog = catalog.await()
        val hasPiUltra =
            currentCatalog.routes.any { route ->
                route.piRuntimeCapable == true &&
                    "ultra" in route.efforts &&
                    available.models.any { run ->
                        run.model == route.model &&
                            run.memberEffective.availability !=
                                RecoveryModelsModelsItemMemberEffectiveAvailability.PLAN_RESTRICTED
                    }
            }
        val codexExecution =
            hasPiUltra && service.featureSwitches().effectiveSwitches["_codexExecution"] == true
        modelOptions(available, currentCatalog, codexExecution)
    }
}

private fun DefaultModelRecord.confirm(
    request: UpdateDefaultModelPreference,
    response: DefaultModelPreference,
    fulfilled: Boolean,
): DefaultModelRecord {
    val patch = request.modelSettingsPatch
    val setting = patch?.let { response.modelSettings[it.model] }
    val modelSettings =
        if (patch != null && setting != null) confirmed.modelSettings + (patch.model to setting)
        else confirmed.modelSettings
    val localEfforts =
        if (patch != null && setting != null && efforts[patch.model] == patch.effort) {
            efforts - patch.model
        } else efforts
    return copy(
        confirmed = response.copy(modelSettings = modelSettings),
        edit = edit.takeUnless { fulfilled },
        efforts = localEfforts,
    )
}

private val DefaultModelState.canApplyScheduledRead: Boolean
    get() = save == null || saveDegraded || save.failedAttempts > 0

private fun Exception.retryable(): Boolean =
    this is ApiFailure.Network ||
        this is ApiFailure.Http && (status >= 500 || status == 408 || status == 429)

private fun retryDelay(failures: Int): Long =
    retryDelays[(failures - 1).coerceAtMost(retryDelays.lastIndex)]

private fun UpdateDefaultModelPreference.matches(preference: DefaultModelPreference): Boolean =
    // The server can read back an explicit Auto ID for a nullable write.
    (selectedModel == preference.selectedModel ||
        isAutoDefaultModel(selectedModel) && isAutoDefaultModel(preference.selectedModel)) &&
        serviceTier?.name == preference.serviceTier?.name &&
        (modelSettingsPatch?.let {
            preference.modelSettings[it.model]?.effort?.name == it.effort.name
        } ?: true)
