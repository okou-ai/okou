package ai.okou.android.settings

import ai.okou.android.FeedbackReceipt
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.boundedRetryDelayMillis
import ai.okou.android.api.finiteReadRetryDelays
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
import android.os.SystemClock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val preferenceRefreshMillis = 10 * 60_000L

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
                val canSelect =
                    effective.availability !=
                        RecoveryModelsModelsItemMemberEffectiveAvailability.PLAN_RESTRICTED
                DefaultModelChoice(
                    model.model,
                    model.displayName,
                    canSelect,
                    efforts,
                    efforts.firstOrNull { it.name.equals(defaultEffort, ignoreCase = true) },
                    model.runOptions?.fast?.chatGptUsageMultiplier?.takeIf {
                        canSelect &&
                            it.isFinite() &&
                            it > 0 &&
                            subscription?.serviceTier ==
                                RecoveryModelsModelsItemSubscriptionOptionsServiceTier.PRIORITY &&
                            routes.any { route ->
                                route.subscriptionType == provider &&
                                    "priority" in route.serviceTiers
                            }
                    },
                )
            }
    return DefaultModelOptions(choices, catalog.models.associate { it.model to it.resolvedModel })
}

internal enum class DefaultModelNotice {
    SaveRolledBack,
}

/** The current workspace owner keeps optimistic writes in memory until they are confirmed. */
internal data class DefaultModelSave(
    val request: UpdateDefaultModelPreference,
    val failedAttempts: Int = 0,
    val lastFailureElapsedMillis: Long? = null,
    val retryDelayMillis: Long? = null,
    val checking: Boolean = false,
) {
    val canRetry: Boolean
        get() = failedAttempts < finiteReadRetryDelays.size
}

internal data class DefaultModelState(
    val record: DefaultModelRecord? = null,
    val save: DefaultModelSave? = null,
    val options: DefaultModelOptions? = null,
    val catalogUnavailable: Boolean = false,
    val settingsCatalogRefreshFailure: SettingsRefreshFailure? = null,
    val saveFeedback: FeedbackReceipt<DefaultModelNotice>? = null,
) {
    val pending: UpdateDefaultModelPreference?
        get() = save?.request

    val selectedModel: String?
        get() = if (save == null) record?.confirmed?.selectedModel else save.request.selectedModel

    val selected: DefaultModelChoice?
        get() {
            val id = options?.resolve(selectedModel)
            return options?.choices?.firstOrNull { it.id == id }
        }

    val fast: Boolean
        get() =
            selected?.fastMultiplier != null &&
                if (save != null) save.request.serviceTier != null
                else record?.confirmed?.serviceTier != null

    val effort: ModelEffort?
        get() {
            val choice = selected ?: return null
            val name =
                pending?.modelSettingsPatch?.takeIf { it.model == choice.id }?.effort?.name
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
    private val monotonicMillis: () -> Long = SystemClock::elapsedRealtime,
    private val onFailure: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(DefaultModelState())
    val state = mutable.asStateFlow()
    private val preferenceRequests = Mutex()
    private var presented = false
    private var foreground = false
    private var destination: SettingsDestination? = null
    private var composerOptionsVisible = false
    private var preferenceRead: Job? = null
    private var catalogRead: Job? = null
    private var saving: Job? = null
    private var saveWait: Job? = null
    private var unconfirmedWrite: UpdateDefaultModelPreference? = null

    init {
        scope.launch {
            if (!authorized()) return@launch
            val record = store.load(identity)
            currentCoroutineContext().ensureActive()
            if (!authorized()) return@launch
            mutable.value = mutable.value.copy(record = record)
            if (mutable.value.options != null) publishConfirmed(record)
            synchronizeReads()
        }
    }

    fun showSettings(page: SettingsDestination?) {
        if (presented && destination == page) return
        if ((destination == null) != (page == null)) {
            mutable.value = mutable.value.copy(saveFeedback = null)
        }
        presented = true
        destination = page
        synchronizeReads()
    }

    fun foreground(active: Boolean) {
        if (foreground == active) return
        foreground = active
        synchronizeReads()
    }

    fun showComposerOptions(visible: Boolean) {
        if (composerOptionsVisible == visible) return
        composerOptionsVisible = visible
        synchronizeReads()
    }

    fun select(id: String?) {
        val value = mutable.value
        val options = value.options ?: return
        val choice = options.choices.firstOrNull { it.id == id }
        if (id == null) {
            if (isAutoDefaultModel(value.selectedModel)) return
        } else if (value.selected?.id == id || choice?.canSelect != true) {
            return
        }
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
        if (current.record == null || !authorized()) return
        val patch = choice?.let { model ->
            if (effort != null) {
                UpdateDefaultModelPreferenceModelSettingsPatch(model.id, effort)
            } else {
                current.pending?.modelSettingsPatch?.takeIf {
                    it.model == model.id && it.effort in model.efforts
                }
            }
        }
        val request =
            UpdateDefaultModelPreference(
                id,
                if (fast) UpdateDefaultModelPreferenceServiceTier.PRIORITY else null,
                patch,
            )
        val verifying = current.save?.takeIf { unconfirmedWrite != null }
        mutable.value =
            current.copy(
                save = verifying?.copy(request = request) ?: DefaultModelSave(request),
                saveFeedback = null,
            )
        if (verifying == null) saveWait?.cancel()
        synchronizeSaves()
    }

    private fun synchronizeReads() {
        val current = mutable.value
        val active = foreground && authorized()
        val refresh = active && presented && destination == null && current.record != null
        if (!refresh) {
            preferenceRead?.cancel()
            preferenceRead = null
        } else if (preferenceRead?.isActive != true) {
            preferenceRead = scope.launch { refreshPreferences() }
        }

        val catalogVisible =
            active &&
                (composerOptionsVisible ||
                    destination == SettingsDestination.Overview ||
                    destination == SettingsDestination.Instructions)
        if (!catalogVisible || destination != SettingsDestination.Overview)
            clearSettingsCatalogRefreshFailure()
        if (!catalogVisible) {
            catalogRead?.cancel()
            catalogRead = null
        } else if (catalogRead == null) {
            catalogRead = scope.launch { refreshCatalog() }
        }
    }

    private fun clearSettingsCatalogRefreshFailure() {
        val current = mutable.value
        current.settingsCatalogRefreshFailure?.let(::dismissCatalogFailure)
    }

    fun dismissCatalogFailure(failure: SettingsRefreshFailure) {
        val current = mutable.value
        if (current.settingsCatalogRefreshFailure === failure)
            mutable.value = current.copy(settingsCatalogRefreshFailure = null)
    }

    private suspend fun refreshPreferences() {
        var failures = 0
        while (authorized()) {
            val last = state.first { it.save == null }.record?.lastRefreshMillis
            val age = last?.let { nowMillis() - it }
            if (age != null && age in 0 until preferenceRefreshMillis) {
                delay(preferenceRefreshMillis - age)
            }
            try {
                preferenceRequests.withLock {
                    val current = mutable.value
                    if (current.save != null || current.record?.lastRefreshMillis != last)
                        return@withLock
                    val remote = service.defaultModelPreference()
                    currentCoroutineContext().ensureActive()
                    if (!authorized()) return
                    if (mutable.value.save != null) return@withLock
                    publishConfirmed(DefaultModelRecord(remote, lastRefreshMillis = nowMillis()))
                }
                failures = 0
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                onFailure(error)
                if (!authorized()) return
                val wait =
                    if (error.retryable()) boundedRetryDelayMillis(failures++, error) else null
                if (wait != null) {
                    delay(wait)
                    currentCoroutineContext().ensureActive()
                } else {
                    failures = 0
                    delay(preferenceRefreshMillis)
                }
            }
        }
    }

    private suspend fun refreshCatalog() {
        var failures = 0
        while (authorized()) {
            try {
                val options = loadOptions()
                currentCoroutineContext().ensureActive()
                if (!authorized()) return
                mutable.value =
                    mutable.value.copy(
                        options = options,
                        catalogUnavailable = false,
                        settingsCatalogRefreshFailure = null,
                    )
                mutable.value.record?.let { publishConfirmed(it) }
                return
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Exception) {
                currentCoroutineContext().ensureActive()
                onFailure(error)
                if (!authorized()) return
                val wait =
                    if (error.retryable()) boundedRetryDelayMillis(failures++, error) else null
                if (wait == null) {
                    val latest = mutable.value
                    mutable.value =
                        latest.copy(
                            catalogUnavailable = true,
                            settingsCatalogRefreshFailure =
                                if (
                                    destination == SettingsDestination.Overview &&
                                        latest.options != null
                                )
                                    SettingsRefreshFailure()
                                else null,
                        )
                    return
                }
                delay(wait)
                currentCoroutineContext().ensureActive()
            }
        }
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

    private fun canSave(): Boolean = authorized() && mutable.value.pending != null

    private suspend fun savePreferences() {
        while (canSave()) {
            val retryMillis = preferenceRequests.withLock {
                if (!canSave()) return
                val current = mutable.value
                val pending = checkNotNull(current.save)
                val elapsed = pending.lastFailureElapsedMillis?.let { monotonicMillis() - it }
                val delay = pending.retryDelayMillis
                if (elapsed != null && delay != null && elapsed in 0 until delay) {
                    return@withLock delay - elapsed
                }
                val unresolved = unconfirmedWrite
                val save =
                    if (
                        unresolved == null &&
                            pending.request.serviceTier != null &&
                            current.selected?.fastMultiplier == null
                    ) {
                        // The catalog can change while a save waits for its turn or retries.
                        pending.copy(request = pending.request.copy(serviceTier = null)).also {
                            mutable.value = current.copy(save = it)
                        }
                    } else pending
                val request = unresolved ?: save.request
                try {
                    val remote =
                        if (unresolved != null) service.defaultModelPreference()
                        else {
                            unconfirmedWrite = request
                            service.updateDefaultModelPreference(request)
                        }
                    currentCoroutineContext().ensureActive()
                    if (!authorized()) return
                    if (unresolved == null) {
                        unconfirmedWrite = null
                        applySaveResponse(request, remote)
                    } else if (!reconcileReadback(unresolved, remote)) {
                        val latest = checkNotNull(mutable.value.save)
                        deferReadback(latest, boundedRetryDelayMillis(latest.failedAttempts))
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (error: Exception) {
                    currentCoroutineContext().ensureActive()
                    onFailure(error)
                    if (!authorized()) return
                    handleSaveFailure(save, readback = unresolved != null, error = error)
                    currentCoroutineContext().ensureActive()
                }
                0L
            }
            if (retryMillis > 0 && canSave()) waitToSave(retryMillis)
        }
    }

    private fun applySaveResponse(
        request: UpdateDefaultModelPreference,
        response: DefaultModelPreference,
    ) {
        val current = mutable.value
        val latest = checkNotNull(current.save)
        val fulfilled = latest.request == request
        publishConfirmed(
            checkNotNull(current.record).confirm(request, response),
            save = if (fulfilled) null else DefaultModelSave(latest.request),
        )
    }

    private fun reconcileReadback(
        attempted: UpdateDefaultModelPreference,
        response: DefaultModelPreference,
    ): Boolean {
        val current = mutable.value
        val latest = checkNotNull(current.save)
        val evidence = settingReadback(attempted, latest.request) { it.matches(response) }
        if (evidence == SettingReadback.Unconfirmed) return false
        val fulfilled = evidence == SettingReadback.ConfirmsLatest

        unconfirmedWrite = null
        publishConfirmed(
            DefaultModelRecord(response, lastRefreshMillis = nowMillis()),
            save = if (fulfilled) null else DefaultModelSave(latest.request),
        )
        return true
    }

    private fun handleSaveFailure(save: DefaultModelSave, readback: Boolean, error: Exception) {
        val rejected = !readback && error.definitivelyRejectedWrite()
        val undelivered = !readback && error is ApiFailure.Network && error.connectionFailed
        if (rejected || undelivered) unconfirmedWrite = null
        val current = mutable.value
        val latest = current.save ?: return
        if ((rejected || undelivered) && latest !== save) {
            mutable.value = current.copy(save = DefaultModelSave(latest.request))
            return
        }
        when {
            rejected || (undelivered && !latest.canRetry) -> {
                rollBackSave()
            }
            readback -> {
                val wait =
                    if (error.retryable() || error is ApiFailure.IncompatibleResponse)
                        boundedRetryDelayMillis(latest.failedAttempts, error)
                    else null
                deferReadback(latest, wait)
            }
            else -> deferSave(latest, boundedRetryDelayMillis(latest.failedAttempts, error))
        }
    }

    private fun deferReadback(save: DefaultModelSave, wait: Long?) {
        if (wait != null) {
            deferSave(save, wait)
        } else if (save.request != checkNotNull(unconfirmedWrite)) {
            unconfirmedWrite = null
            mutable.value = mutable.value.copy(save = DefaultModelSave(save.request))
        } else {
            rollBackSave()
        }
    }

    private fun deferSave(save: DefaultModelSave, wait: Long?) {
        val checking = unconfirmedWrite != null
        // Verification reads have their own budget after a write loses its acknowledgement.
        val failedAttempts = if (checking && !save.checking) 0 else save.failedAttempts + 1
        mutable.value =
            mutable.value.copy(
                save =
                    save.copy(
                        failedAttempts = failedAttempts,
                        lastFailureElapsedMillis = monotonicMillis(),
                        retryDelayMillis = wait,
                        checking = checking,
                    ),
            )
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

    private fun rollBackSave() {
        unconfirmedWrite = null
        mutable.value =
            mutable.value.copy(
                save = null,
                saveFeedback = FeedbackReceipt(DefaultModelNotice.SaveRolledBack),
            )
    }

    fun dismissSaveFailure(receipt: FeedbackReceipt<DefaultModelNotice>) {
        val current = mutable.value
        if (current.saveFeedback === receipt) mutable.value = current.copy(saveFeedback = null)
    }

    private fun publishConfirmed(
        record: DefaultModelRecord,
        save: DefaultModelSave? = mutable.value.save,
    ) {
        val state = mutable.value
        val selectedModel = record.confirmed.selectedModel
        val label =
            state.options?.let { options ->
                val model = options.resolve(selectedModel)
                options.choices.firstOrNull { it.id == model }?.label
            }
                ?: state.record
                    ?.takeIf { it.confirmed.selectedModel == selectedModel }
                    ?.confirmedLabel
        val updated = record.copy(confirmedLabel = label)
        mutable.value = state.copy(record = updated, save = save)
        if (updated != state.record) store.save(identity, updated)
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
): DefaultModelRecord {
    val model = request.modelSettingsPatch?.model
    val modelSettings =
        if (model != null) {
            val setting = response.modelSettings[model]
            if (setting == null) confirmed.modelSettings - model
            else confirmed.modelSettings + (model to setting)
        } else confirmed.modelSettings
    return copy(confirmed = response.copy(modelSettings = modelSettings))
}

private fun Exception.retryable(): Boolean =
    this is ApiFailure.Network ||
        this is ApiFailure.Http && (status >= 500 || status == 408 || status == 429)

private fun UpdateDefaultModelPreference.matches(preference: DefaultModelPreference): Boolean =
    // The server can read back an explicit Auto ID for a nullable write.
    (selectedModel == preference.selectedModel ||
        isAutoDefaultModel(selectedModel) && isAutoDefaultModel(preference.selectedModel)) &&
        serviceTier?.name == preference.serviceTier?.name &&
        (modelSettingsPatch?.let {
            preference.modelSettings[it.model]?.effort?.name == it.effort.name
        } ?: true)
