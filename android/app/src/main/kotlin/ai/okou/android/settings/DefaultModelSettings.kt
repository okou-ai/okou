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
import ai.okou.android.auth.WorkspaceSession
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
import kotlinx.coroutines.withTimeoutOrNull

private val readRetryDelays = listOf(5_000L, 10_000L, 20_000L, 40_000L, 60_000L)
private const val readFailureWindowMillis = 30_000L

internal typealias ModelEffort = UpdateDefaultModelPreferenceModelSettingsPatchEffort

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
    fun resolve(id: String?): String? =
        id?.let { replacements[it] }?.takeUnless { it == "auto" || it == "okou-1.0" }
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
                if (model.replacedBy != null || model.model in setOf("auto", "okou-1.0")) {
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

internal enum class DefaultModelFailure {
    Read,
    Save,
}

internal data class DefaultModelState(
    val preference: DefaultModelPreference? = null,
    val options: DefaultModelOptions? = null,
    val pending: UpdateDefaultModelPreference? = null,
    val offline: Boolean = false,
    val failure: DefaultModelFailure? = null,
) {
    val failed: Boolean
        get() = failure != null

    val selected: DefaultModelChoice?
        get() {
            val id =
                if (pending != null) pending.selectedModel
                else options?.resolve(preference?.selectedModel)
            return options?.choices?.firstOrNull { it.id == id }
        }

    val fast: Boolean
        get() =
            selected?.fastMultiplier != null &&
                (if (pending != null) pending.serviceTier != null
                else preference?.serviceTier != null)

    val effort: ModelEffort?
        get() {
            val choice = selected ?: return null
            val name =
                pending?.modelSettingsPatch?.effort?.name
                    ?: preference?.modelSettings?.get(choice.id)?.effort?.name
            return choice.efforts.firstOrNull { it.name == name } ?: choice.defaultEffort
        }
}

/** Workspace-owned writer; navigation does not cancel a save. */
internal class DefaultModelSettings(
    private val scope: CoroutineScope,
    private val service: WorkspaceSession,
    private val authorized: () -> Boolean,
    private val onFailure: (Exception) -> Unit,
) {
    private val mutable = MutableStateFlow(DefaultModelState())
    val state = mutable.asStateFlow()
    private var visible = false
    private var refreshRequested = false
    private var needsReadback = false
    private var work: Job? = null
    private var retryWait: Job? = null
    private var readFailures = 0
    private var readFailureWindow: Job? = null

    fun visible(active: Boolean) {
        if (visible == active) return
        visible = active
        refreshRequested = active
        if (!active) resetReadFailures()
        val current = mutable.value
        if (!active && current.pending == null) {
            work?.cancel()
            if (current.failure == DefaultModelFailure.Save)
                mutable.value = current.copy(failure = null)
        }
        synchronize()
    }

    fun online(online: Boolean) {
        val current = mutable.value
        if (current.offline == !online) return
        mutable.value =
            current.copy(
                offline = !online,
                failure = current.failure.takeUnless { online && it == DefaultModelFailure.Read },
            )
        if (!online) {
            // A pending save can keep this worker alive across a network change.
            resetReadFailures()
            retryWait?.cancel()
            if (current.pending == null) work?.cancel()
        } else if (visible) refreshRequested = true
        synchronize()
    }

    fun select(id: String?) {
        val value = mutable.value
        val options = value.options ?: return
        if (
            value.selected?.id == id ||
                id != null && options.choices.none { it.id == id && it.canSelect }
        )
            return
        submit(UpdateDefaultModelPreference(id, null))
    }

    fun effort(effort: ModelEffort) {
        val value = mutable.value
        val choice = value.selected ?: return
        if (!choice.canSelect || effort !in choice.efforts || effort == value.effort) return
        submit(
            UpdateDefaultModelPreference(
                choice.id,
                if (value.fast) UpdateDefaultModelPreferenceServiceTier.PRIORITY else null,
                UpdateDefaultModelPreferenceModelSettingsPatch(choice.id, effort),
            )
        )
    }

    fun fast(enabled: Boolean) {
        val value = mutable.value
        val choice = value.selected ?: return
        if (!choice.canSelect || choice.fastMultiplier == null || enabled == value.fast) return
        submit(
            UpdateDefaultModelPreference(
                choice.id,
                if (enabled) UpdateDefaultModelPreferenceServiceTier.PRIORITY else null,
                value.pending?.modelSettingsPatch,
            )
        )
    }

    private fun submit(change: UpdateDefaultModelPreference) {
        if (!authorized()) return
        mutable.value = mutable.value.copy(pending = change, failure = null)
        synchronize()
    }

    private fun synchronize() {
        if (
            !authorized() ||
                mutable.value.offline ||
                work != null ||
                (mutable.value.pending == null && !refreshRequested)
        )
            return
        val job =
            scope.launch(start = CoroutineStart.LAZY) {
                var saveFailures = 0
                try {
                    while (authorized() && !mutable.value.offline) {
                        val pending = mutable.value.pending
                        if (pending == null && !refreshRequested) break
                        val readback = pending != null && needsReadback
                        try {
                            if (pending == null) {
                                refreshRequested = false
                                refresh()
                                resetReadFailures()
                            } else {
                                val confirmed =
                                    if (readback) service.defaultModelPreference()
                                    else {
                                        needsReadback = true
                                        service.updateDefaultModelPreference(pending)
                                    }
                                currentCoroutineContext().ensureActive()
                                if (!authorized()) break
                                val current = mutable.value
                                val fulfilled =
                                    if (readback) current.pending?.matches(confirmed) == true
                                    else current.pending == pending
                                needsReadback = false
                                val awaitingWrite = readback && !fulfilled
                                if (!awaitingWrite) saveFailures = 0
                                mutable.value =
                                    current.copy(
                                        preference = confirmed,
                                        pending = current.pending.takeUnless { fulfilled },
                                        failure = current.failure.takeIf { awaitingWrite },
                                    )
                            }
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (error: Exception) {
                            currentCoroutineContext().ensureActive()
                            onFailure(error)
                            if (!authorized()) break
                            if (pending == null && !visible) continue
                            val retryable =
                                error is ApiFailure.Network ||
                                    pending != null && error is ApiFailure.IncompatibleResponse ||
                                    error is ApiFailure.Http &&
                                        (error.status >= 500 || error.status in setOf(408, 429))
                            val current = mutable.value
                            val failure =
                                if (pending != null) DefaultModelFailure.Save
                                else current.failure ?: DefaultModelFailure.Read
                            if (!retryable) {
                                needsReadback = false
                                mutable.value =
                                    current.copy(
                                        pending = current.pending.takeUnless { it == pending },
                                        failure = failure,
                                    )
                                if (mutable.value.pending == null) break
                                continue
                            }

                            if (pending == null) refreshRequested = visible
                            if (current.offline) continue
                            val retryMillis =
                                if (pending == null) {
                                    readFailures =
                                        (readFailures + 1).coerceAtMost(readRetryDelays.size)
                                    if (
                                        current.options == null ||
                                            readFailures >= 3 &&
                                                readFailureWindow?.isCompleted == true
                                    ) {
                                        showReadFailure()
                                    } else if (readFailures == 1) {
                                        readFailureWindow = launch {
                                            delay(readFailureWindowMillis)
                                            if (
                                                readFailures >= 3 &&
                                                    visible &&
                                                    !mutable.value.offline &&
                                                    authorized()
                                            )
                                                showReadFailure()
                                        }
                                    }
                                    readRetryDelays[readFailures - 1]
                                } else {
                                    saveFailures++
                                    if (saveFailures >= 2)
                                        mutable.value = current.copy(failure = failure)
                                    if (saveFailures == 1) 5_000L else 30_000L
                                }
                            if (!waitForRetry(retryMillis, refreshing = pending == null))
                                saveFailures = 0
                        }
                    }
                } finally {
                    resetReadFailures()
                    work = null
                    if (authorized()) synchronize()
                }
            }
        work = job
        job.start()
    }

    private fun resetReadFailures() {
        readFailures = 0
        readFailureWindow?.cancel()
        readFailureWindow = null
    }

    private fun showReadFailure() {
        val current = mutable.value
        if (current.failure != DefaultModelFailure.Save) {
            mutable.value = current.copy(failure = DefaultModelFailure.Read)
        }
    }

    private suspend fun CoroutineScope.waitForRetry(millis: Long, refreshing: Boolean): Boolean {
        val wait = launch {
            if (refreshing) withTimeoutOrNull(millis) { state.first { it.pending != null } }
            else delay(millis)
        }
        retryWait = wait
        try {
            wait.join()
            return !wait.isCancelled
        } finally {
            retryWait = null
        }
    }

    private suspend fun refresh() = coroutineScope {
        val preference = async { service.defaultModelPreference() }
        val catalog = async { service.recoveryCatalog() }
        val models = async { service.recoveryModels() }
        val confirmed = preference.await()
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
        val options = modelOptions(available, currentCatalog, codexExecution)
        currentCoroutineContext().ensureActive()
        if (authorized()) {
            val current = mutable.value
            mutable.value =
                current.copy(
                    preference = confirmed,
                    options = options,
                    failure = current.failure.takeIf { it == DefaultModelFailure.Save },
                )
        }
    }

    private fun UpdateDefaultModelPreference.matches(preference: DefaultModelPreference): Boolean =
        selectedModel == preference.selectedModel &&
            serviceTier?.name == preference.serviceTier?.name &&
            (modelSettingsPatch?.let {
                preference.modelSettings[it.model]?.effort?.name == it.effort.name
            } ?: true)
}
