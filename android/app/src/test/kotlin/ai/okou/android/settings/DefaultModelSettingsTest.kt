package ai.okou.android.settings

import ai.okou.android.ChatListApiFixture
import ai.okou.android.DefaultModelApiFixture
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.DefaultModelPreference
import ai.okou.android.api.generated.UpdateDefaultModelPreference
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.auth.workspaceStorageKey
import ai.okou.android.jsonResponse
import ai.okou.android.state.SettingsDestination
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import java.net.NoRouteToHostException
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

@OptIn(ExperimentalCoroutinesApi::class)
class DefaultModelSettingsTest {
    private val DefaultModelSettings.notices
        get() = state.mapNotNull { it.saveFeedback }.distinctUntilChanged().mapNotNull { it.value }

    @get:Rule val temporary = TemporaryFolder()

    private fun TestScope.model(
        api: ChatListApiFixture,
        store: DefaultModelStore = store(backgroundScope),
        scope: CoroutineScope = backgroundScope,
        identity: WorkspaceIdentity = api.identity,
        service: WorkspaceSession = api.service,
        nowMillis: () -> Long = { currentTime },
        onFailure: (Exception) -> Unit = { throw it },
    ) =
        DefaultModelSettings(
            scope,
            service,
            identity,
            store,
            { true },
            nowMillis,
            monotonicMillis = { currentTime },
            onFailure = onFailure,
        )

    private fun store(scope: CoroutineScope): DefaultModelStore {
        val file = temporary.newFolder().resolve("default-model.preferences_pb")
        return DefaultModelStore(PreferenceDataStoreFactory.create(scope = scope) { file }, scope)
    }

    private fun DefaultModelSettings.start() {
        showSettings(null)
        foreground(true)
    }

    private suspend fun DefaultModelSettings.openAfterSync(): DefaultModelState {
        start()
        state.first { it.record?.lastRefreshMillis != null }
        showSettings(SettingsDestination.Overview)
        return state.first { it.options != null }
    }

    @Test
    fun coldSettingsShowsAutoWhileOnlyTheCatalogIsFetched() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val fixtureResponse = api.commandResponse
            val reads = AtomicInteger()
            api.commandResponse = { request ->
                if (request.requestUrl?.encodedPath == "/api/user-model-preference") {
                    reads.incrementAndGet()
                }
                fixtureResponse(request)
            }
            val model = model(api)
            model.showSettings(SettingsDestination.Overview)
            model.foreground(true)
            val loaded = model.state.first { it.options != null && it.record != null }
            assertNull(loaded.selected)
            assertEquals(0, reads.get())
            model.showSettings(SettingsDestination.Instructions)
            model.showSettings(SettingsDestination.ModelAccounts)
            model.showSettings(SettingsDestination.Account)
            advanceTimeBy(600_001)
            assertEquals(0, reads.get())

            model.showSettings(null)
            val refreshed = model.state.first { it.selected?.id == "gpt-test" }
            assertEquals(ModelEffort.MEDIUM, refreshed.effort)
            assertEquals(1, reads.get())
            assertTrue(fixture.writes.isEmpty())
        }
    }

    @Test
    fun openingSettingsDiscardsAnEarlierReadAndForegroundCatchesUpOnSchedule() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val old = api.service.defaultModelPreference()
            val entered = CompletableDeferred<Unit>()
            val release = CompletableDeferred<Unit>()
            val attempts = mutableListOf<Long>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        attempts += currentTime
                        if (attempts.size == 1) {
                            entered.complete(Unit)
                            withContext(NonCancellable) { release.await() }
                            return old
                        }
                        return old.copy(selectedModel = "claude-test")
                    }
                }
            val model = model(api, service = remote)
            model.start()
            entered.await()
            model.showSettings(SettingsDestination.CreditBalance)
            release.complete(Unit)
            runCurrent()
            assertNull(model.state.value.selectedModel)
            assertNull(model.state.value.record?.lastRefreshMillis)
            assertEquals(listOf(0L), attempts)

            model.showSettings(null)
            runCurrent()
            assertEquals("claude-test", model.state.value.selectedModel)
            assertEquals(listOf(0L, 0L), attempts)
            advanceTimeBy(599_999)
            runCurrent()
            assertEquals(2, attempts.size)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(600_000L, attempts.last())
            model.foreground(false)
            advanceTimeBy(600_000)
            assertEquals(3, attempts.size)
            model.foreground(true)
            runCurrent()
            assertEquals(listOf(0L, 0L, 600_000L, 1_200_000L), attempts)
        }
    }

    @Test
    fun queuedChangesCoalesceAndReopeningRestoresOnlyConfirmedValues() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val fixtureResponse = api.commandResponse
            val rejectWrites = AtomicBoolean(false)
            val failedWrite = CompletableDeferred<Unit>()
            api.commandResponse = { request ->
                if (
                    rejectWrites.get() &&
                        request.method == "PUT" &&
                        request.requestUrl?.encodedPath == "/api/user-model-preference"
                )
                    jsonResponse("{}").setResponseCode(503)
                else fixtureResponse(request)
            }
            val file = temporary.newFolder().resolve("default-model.preferences_pb")
            val process = SupervisorJob(backgroundScope.coroutineContext[Job])
            val storageScope = CoroutineScope(backgroundScope.coroutineContext + process)
            val owner = SupervisorJob(process)
            val scope = CoroutineScope(backgroundScope.coroutineContext + owner)
            val preferences = PreferenceDataStoreFactory.create(scope = storageScope) { file }
            val store = DefaultModelStore(preferences, storageScope)
            try {
                val model =
                    model(
                        api,
                        store,
                        scope,
                        onFailure = {
                            assertEquals(503, (it as ApiFailure.Http).status)
                            failedWrite.complete(Unit)
                        },
                    )
                assertEquals("gpt-test", model.openAfterSync().selected?.id)
                assertNull(store.load(api.identity).confirmed.serviceTier)
                model.select("claude-test")
                assertEquals(ModelEffort.HIGH, model.state.value.effort)
                model.select("gpt-test")
                model.effort(ModelEffort.HIGH)
                assertEquals(ModelEffort.HIGH, model.state.value.effort)
                model.fast(true)
                assertTrue(fixture.writes.isEmpty())

                val synced = model.state.first { it.pending == null }
                assertTrue(synced.fast)
                assertEquals(ModelEffort.HIGH, synced.effort)
                val update = fixture.writes.single()
                assertEquals(JsonPrimitive("priority"), update["serviceTier"])
                assertEquals(
                    JsonPrimitive("high"),
                    update["modelSettingsPatch"]?.jsonObject?.get("effort"),
                )
                assertFalse(update.containsKey("selectedImageModel"))

                rejectWrites.set(true)
                model.select("claude-test")
                failedWrite.await()
                runCurrent()
                assertEquals("claude-test", model.state.value.selectedModel)
                owner.cancelAndJoin()
                assertEquals("GPT 5.6 Sol", store.load(api.identity).confirmedLabel)
                val key = stringPreferencesKey(api.identity.workspaceStorageKey())
                preferences.edit { values ->
                    val record = Json.parseToJsonElement(checkNotNull(values[key])).jsonObject
                    assertFalse("edit" in record)
                    val oldEdit =
                        JsonObject(
                            mapOf(
                                "request" to
                                    JsonObject(
                                        mapOf(
                                            "selectedModel" to JsonPrimitive("claude-test"),
                                            "serviceTier" to JsonNull,
                                        ),
                                    ),
                                "failedAttempts" to JsonPrimitive(1),
                                "lastFailureMillis" to JsonPrimitive(currentTime),
                            ),
                        )
                    values[key] =
                        JsonObject(
                                record - "confirmedLabel" +
                                    mapOf(
                                        "edit" to oldEdit,
                                        "label" to JsonPrimitive("Claude Sonnet 5"),
                                    ),
                            )
                            .toString()
                }
            } finally {
                process.cancelAndJoin()
            }
            rejectWrites.set(false)
            val reopened =
                DefaultModelStore(
                    PreferenceDataStoreFactory.create(scope = backgroundScope) { file },
                    backgroundScope,
                )
            val otherWorkspace = api.identity.copy(workspaceId = "other")
            assertNull(reopened.load(otherWorkspace).confirmed.selectedModel)
            assertNull(reopened.load(api.identity.copy(userId = "other")).confirmed.selectedModel)
            val model = model(api, reopened, identity = api.identity.copy(sessionId = "renewed"))
            val restored = model.state.first { it.record != null }
            assertEquals("gpt-test", restored.selectedModel)
            assertNull(restored.record?.confirmedLabel)
            assertNull(restored.pending)

            model.showSettings(SettingsDestination.Overview)
            model.foreground(true)
            val cached = model.state.first { it.options != null }
            assertEquals("gpt-test", cached.selected?.id)
            assertEquals(ModelEffort.HIGH, cached.effort)
            assertTrue(cached.fast)
            advanceTimeBy(30_000)
            assertEquals(1, fixture.writes.size)
            assertEquals("gpt-test", model.state.value.selected?.id)

            model.showSettings(null)
            val refreshAt = checkNotNull(restored.record?.lastRefreshMillis) + 600_000
            advanceTimeBy((refreshAt - currentTime).coerceAtLeast(0))
            val refreshed = model.state.first { it.record?.lastRefreshMillis == refreshAt }
            assertEquals("gpt-test", refreshed.selected?.id)
            assertTrue(refreshed.fast)
            assertEquals(1, fixture.writes.size)
            assertEquals(
                JsonPrimitive("high"),
                fixture.preference["modelSettings"]
                    ?.jsonObject
                    ?.get("claude-test")
                    ?.jsonObject
                    ?.get("effort"),
            )
            model.showSettings(SettingsDestination.Overview)
            model.select("claude-test")
            val switched = model.state.first { it.pending == null }
            assertEquals(ModelEffort.HIGH, switched.effort)
            assertFalse(switched.fast)
            assertEquals(JsonNull, fixture.writes.last()["serviceTier"])
        }
    }

    @Test
    fun saveConfirmsItsFieldsAndKeepsAnotherModelsConfirmedEffort() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val model = model(api)
            assertEquals(ModelEffort.MEDIUM, model.openAfterSync().effort)
            val changedElsewhere = JsonObject(mapOf("effort" to JsonPrimitive("medium")))
            fixture.preference =
                JsonObject(
                    fixture.preference +
                        ("modelSettings" to JsonObject(mapOf("claude-test" to changedElsewhere))),
                )

            model.effort(ModelEffort.HIGH)
            val synced = model.state.first { it.pending == null }
            assertEquals(ModelEffort.HIGH, synced.effort)
            assertEquals(
                JsonPrimitive("gpt-test"),
                fixture.writes.single()["modelSettingsPatch"]?.jsonObject?.get("model"),
            )

            model.select("claude-test")
            assertEquals(ModelEffort.HIGH, model.state.value.effort)
        }
    }

    @Test
    fun coldCatalogFailureKeepsTheLocalDefaultVisibleAndRetries() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val fixtureResponse = api.commandResponse
            val reads = AtomicInteger()
            api.commandResponse = { request ->
                if (
                    request.requestUrl?.encodedPath == "/api/model-catalog" &&
                        reads.incrementAndGet() == 1
                )
                    jsonResponse("{}").setResponseCode(503)
                else fixtureResponse(request)
            }
            val model =
                model(api, onFailure = { assertEquals(503, (it as ApiFailure.Http).status) })
            model.showSettings(SettingsDestination.Overview)
            model.foreground(true)
            val recovered = model.state.first { it.options != null }
            assertFalse(recovered.catalogUnavailable)
            assertNull(recovered.selected)
            assertEquals(2, reads.get())
        }
    }

    @Test
    fun cachedCatalogKeepsItsOptionsAfterThreeAttemptsAndRecoversOnForegrounding() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val catalog = api.service.recoveryCatalog()
            val models = api.service.recoveryModels()
            var unavailable = false
            val attempts = mutableListOf<Long>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun recoveryCatalog() =
                        if (unavailable) {
                            attempts += currentTime
                            throw ApiFailure.Http(503, null, null, null)
                        } else catalog

                    override suspend fun recoveryModels() = models
                }
            val model = model(api, service = remote, onFailure = {})
            assertEquals("gpt-test", model.openAfterSync().selected?.id)
            model.showSettings(SettingsDestination.ModelAccounts)
            unavailable = true
            val started = currentTime
            model.showSettings(SettingsDestination.Overview)
            advanceTimeBy(6_000)
            assertEquals(listOf(started, started + 3_000), attempts)
            assertFalse(model.state.value.catalogUnavailable)
            runCurrent()
            assertEquals(listOf(started, started + 3_000, started + 6_000), attempts)
            assertTrue(model.state.value.catalogUnavailable)
            assertTrue(model.state.value.settingsCatalogRefreshFailure != null)
            assertEquals("gpt-test", model.state.value.selected?.id)
            advanceTimeBy(60_000)
            assertEquals(3, attempts.size)
            model.showSettings(SettingsDestination.ModelAccounts)
            assertNull(model.state.value.settingsCatalogRefreshFailure)
            model.foreground(false)
            unavailable = false
            model.showSettings(SettingsDestination.Overview)
            model.foreground(true)
            runCurrent()
            assertFalse(model.state.value.catalogUnavailable)
            assertNull(model.state.value.settingsCatalogRefreshFailure)
            assertEquals("gpt-test", model.state.value.selected?.id)
        }
    }

    @Test
    fun anOlderWriteCannotReplaceTheLatestLocalChoice() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val first = CompletableDeferred<Unit>()
            val last = CompletableDeferred<Unit>()
            val releaseFirst = CompletableDeferred<Unit>()
            val releaseLast = CompletableDeferred<Unit>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        if (update.selectedModel == "gpt-test") {
                            first.complete(Unit)
                            releaseFirst.await()
                        } else {
                            last.complete(Unit)
                            releaseLast.await()
                        }
                        return api.service.updateDefaultModelPreference(update)
                    }
                }
            val model = model(api, service = remote)
            model.openAfterSync()
            model.fast(true)
            first.await()
            model.select("claude-test")
            model.select(null)
            assertNull(model.state.value.selected)
            releaseFirst.complete(Unit)
            last.await()
            assertEquals("gpt-test", model.state.value.record?.confirmed?.selectedModel)
            assertNull(model.state.value.selected)
            assertFalse(model.state.value.fast)
            releaseLast.complete(Unit)
            model.state.first { it.pending == null }
            assertEquals("auto", model.state.value.selectedModel)
            assertEquals(
                listOf(JsonPrimitive("gpt-test"), JsonNull),
                fixture.writes.map { it["selectedModel"] },
            )
        }
    }

    @Test
    fun canonicalAutoReadbackConfirmsAnUnacknowledgedWriteWithoutReplay() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val fixtureResponse = api.commandResponse
            api.commandResponse = { request ->
                val response = fixtureResponse(request)
                if (
                    request.method == "PUT" &&
                        request.requestUrl?.encodedPath == "/api/user-model-preference" &&
                        fixture.writes.size == 1
                )
                    jsonResponse("{}").setResponseCode(503)
                else response
            }
            val model =
                model(api, onFailure = { assertEquals(503, (it as ApiFailure.Http).status) })
            assertEquals("gpt-test", model.openAfterSync().selected?.id)

            model.select(null)
            val confirmed = model.state.first { it.pending == null }
            assertEquals("auto", confirmed.record?.confirmed?.selectedModel)
            assertNull(confirmed.selected)
            assertEquals(1, fixture.writes.size)
            assertEquals(JsonNull, fixture.writes.single()["selectedModel"])
        }
    }

    @Test
    fun finalReadbackConfirmsAWriteThatCommittedOnTheThirdAttempt() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val original = api.service.defaultModelPreference()
            val catalog = api.service.recoveryCatalog()
            val models = api.service.recoveryModels()
            var pref = original
            val writes = mutableListOf<Long>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun recoveryCatalog() = catalog

                    override suspend fun recoveryModels() = models

                    override suspend fun defaultModelPreference() = pref

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        writes += currentTime
                        if (writes.size < 3) throw ApiFailure.Network(UnknownHostException())
                        pref = pref.copy(selectedModel = "auto")
                        throw ApiFailure.Http(503, null, null, null)
                    }
                }
            val store = store(backgroundScope)
            val model = model(api, store, service = remote, onFailure = {})
            val notices = mutableListOf<DefaultModelNotice>()
            backgroundScope.launch { model.notices.collect { notices += it } }
            model.openAfterSync()
            model.select(null)
            advanceTimeBy(6_000)
            runCurrent()

            assertEquals(listOf(0L, 3_000L, 6_000L), writes)
            assertEquals("auto", model.state.value.selectedModel)
            assertEquals("auto", store.load(api.identity).confirmed.selectedModel)
            assertNull(model.state.value.pending)
            assertTrue(notices.isEmpty())
        }
    }

    @Test
    fun exhaustedReadbackRollsBackWithoutReplayingAndLaterSyncs() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val original = api.service.defaultModelPreference()
            val catalog = api.service.recoveryCatalog()
            val models = api.service.recoveryModels()
            var preference = original
            val writes = mutableListOf<Long>()
            val reads = mutableListOf<Long>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun recoveryCatalog() = catalog

                    override suspend fun recoveryModels() = models

                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        reads += currentTime
                        if (reads.size == 2) throw ApiFailure.Http(429, null, null, 1L)
                        return preference
                    }

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        writes += currentTime
                        throw ApiFailure.Http(503, null, null, null)
                    }
                }
            val store = store(backgroundScope)
            val model = model(api, store, service = remote, onFailure = {})
            val notices = mutableListOf<DefaultModelNotice>()
            backgroundScope.launch { model.notices.collect { notices += it } }
            model.openAfterSync()
            model.select(null)
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(listOf(0L), writes)
            assertEquals(listOf(0L, 3_000L), reads)
            assertTrue(notices.isEmpty())
            assertTrue(model.state.value.pending != null)
            assertNull(model.state.value.selected)

            advanceTimeBy(999)
            runCurrent()
            assertEquals(listOf(0L, 3_000L), reads)
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 4_000L), reads)
            assertTrue(model.state.value.save?.checking == true)
            assertTrue(notices.isEmpty())
            assertEquals("gpt-test", store.load(api.identity).confirmed.selectedModel)

            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 4_000L, 7_000L), reads)
            assertNull(model.state.value.pending)
            assertEquals("gpt-test", model.state.value.selected?.id)
            assertEquals(listOf(DefaultModelNotice.SaveRolledBack), notices)

            model.foreground(false)
            model.foreground(true)
            runCurrent()
            assertEquals(7_000L, reads.last())

            model.showSettings(null)
            advanceTimeBy(593_000)
            runCurrent()
            assertEquals(600_000L, reads.last())
            assertNull(model.state.value.pending)
            assertEquals("gpt-test", model.state.value.selected?.id)

            preference = original.copy(selectedModel = "auto")
            advanceTimeBy(600_000)
            runCurrent()
            assertEquals(1_200_000L, reads.last())
            assertNull(model.state.value.pending)
            assertEquals("auto", store.load(api.identity).confirmed.selectedModel)
            assertEquals(listOf(0L), writes)
            assertEquals(listOf(DefaultModelNotice.SaveRolledBack), notices)
        }
    }

    @Test
    fun scheduledRefreshLetsPendingReadbackHonorItsServerDelay() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val original = api.service.defaultModelPreference()
            val catalog = api.service.recoveryCatalog()
            val models = api.service.recoveryModels()
            val reads = mutableListOf<Long>()
            val writes = mutableListOf<Long>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun recoveryCatalog() = catalog

                    override suspend fun recoveryModels() = models

                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        reads += currentTime
                        return when (reads.size) {
                            1 -> original
                            2 -> throw ApiFailure.Http(429, null, null, 1L)
                            else -> original.copy(selectedModel = "auto")
                        }
                    }

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        writes += currentTime
                        throw ApiFailure.Http(503, null, null, null)
                    }
                }
            val model = model(api, service = remote, onFailure = {})
            model.openAfterSync()
            advanceTimeBy(596_500)
            model.select(null)
            runCurrent()
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(listOf(0L, 599_500L), reads)

            model.showSettings(null)
            advanceTimeBy(999)
            runCurrent()
            assertEquals(listOf(0L, 599_500L), reads)
            assertTrue(model.state.value.pending != null)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 599_500L, 600_500L), reads)
            assertEquals(listOf(596_500L), writes)
            assertNull(model.state.value.pending)
            assertEquals("auto", model.state.value.record?.confirmed?.selectedModel)

            advanceTimeBy(600_000)
            runCurrent()
            assertEquals(listOf(0L, 599_500L, 600_500L, 1_200_500L), reads)
        }
    }

    @Test
    fun aNewChoiceWaitsForTheOlderReadbackBudgetBeforeSubmitting() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val original = api.service.defaultModelPreference()
            val catalog = api.service.recoveryCatalog()
            val models = api.service.recoveryModels()
            val reads = mutableListOf<Long>()
            val writes = mutableListOf<Pair<Long, String?>>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun recoveryCatalog() = catalog

                    override suspend fun recoveryModels() = models

                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        reads += currentTime
                        if (reads.size == 2) throw ApiFailure.Http(429, null, null, 1L)
                        return original
                    }

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        writes += currentTime to update.selectedModel
                        if (writes.size == 1) throw ApiFailure.Http(503, null, null, null)
                        return original.copy(selectedModel = update.selectedModel)
                    }
                }
            val model = model(api, service = remote, onFailure = {})
            model.openAfterSync()
            model.select(null)
            runCurrent()
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(listOf(0L, 3_000L), reads)

            advanceTimeBy(400)
            model.select("claude-test")
            assertEquals("claude-test", model.state.value.selected?.id)
            advanceTimeBy(599)
            runCurrent()
            assertEquals(listOf(0L, 3_000L), reads)
            assertEquals(listOf(0L to null), writes)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 4_000L), reads)
            assertEquals(listOf(0L to null), writes)
            assertEquals("claude-test", model.state.value.selected?.id)
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 4_000L, 7_000L), reads)
            assertEquals(listOf(0L to null, 7_000L to "claude-test"), writes)
            assertNull(model.state.value.pending)
        }
    }

    @Test
    fun reopeningSettingsKeepsTheActiveReadbackWaitAfterAClockCorrection() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val original = api.service.defaultModelPreference()
            val catalog = api.service.recoveryCatalog()
            val models = api.service.recoveryModels()
            val reads = mutableListOf<Long>()
            val writes = mutableListOf<Pair<Long, String?>>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun recoveryCatalog() = catalog

                    override suspend fun recoveryModels() = models

                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        reads += currentTime
                        return when (reads.size) {
                            2 -> throw ApiFailure.Http(429, null, null, 1L)
                            3 -> original.copy(selectedModel = null)
                            else -> original
                        }
                    }

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        writes += currentTime to update.selectedModel
                        if (writes.size == 1) throw ApiFailure.Http(503, null, null, null)
                        return original.copy(selectedModel = update.selectedModel)
                    }
                }
            var wallClockOffset = 0L
            val model =
                model(
                    api,
                    service = remote,
                    nowMillis = { currentTime + wallClockOffset },
                    onFailure = {},
                )
            model.openAfterSync()
            model.select(null)
            advanceTimeBy(3_000)
            runCurrent()
            val expectedReads = listOf(0L, 3_000L)
            assertEquals(expectedReads, reads)

            model.showSettings(null)
            advanceTimeBy(400)
            wallClockOffset = -60_000L
            model.showSettings(SettingsDestination.Overview)
            runCurrent()
            assertEquals(expectedReads, reads)
            model.select("claude-test")
            advanceTimeBy(599)
            runCurrent()
            assertEquals(expectedReads, reads)
            assertEquals(listOf(0L to null), writes)

            advanceTimeBy(1)
            runCurrent()
            assertEquals(expectedReads + 4_000L, reads)
            assertEquals(listOf(0L to null, 4_000L to "claude-test"), writes)
            assertEquals("claude-test", model.state.value.record?.confirmed?.selectedModel)
        }
    }

    @Test
    fun unavailableReadbackRollsBackAndForegroundSyncAdoptsTheLateValue() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val fixtureResponse = api.commandResponse
            val rejectReadback = AtomicBoolean(true)
            val blockedReads = AtomicInteger()
            val writes = AtomicInteger()
            api.commandResponse = { request ->
                if (request.requestUrl?.encodedPath != "/api/user-model-preference")
                    fixtureResponse(request)
                else if (request.method == "PUT") {
                    writes.incrementAndGet()
                    jsonResponse("{}")
                } else if (writes.get() > 0 && rejectReadback.get()) {
                    blockedReads.incrementAndGet()
                    jsonResponse("{}").setResponseCode(403)
                } else fixtureResponse(request)
            }
            val model = model(api, onFailure = {})
            assertFalse(model.openAfterSync().fast)
            model.fast(true)
            assertEquals(DefaultModelNotice.SaveRolledBack, model.notices.first())
            val blocked = model.state.value
            assertNull(blocked.pending)
            assertFalse(blocked.fast)
            advanceTimeBy(600_000)
            runCurrent()
            assertEquals(1, blockedReads.get())
            assertEquals(1, writes.get())

            model.foreground(false)
            model.showSettings(null)
            fixture.preference =
                JsonObject(fixture.preference + ("serviceTier" to JsonPrimitive("priority")))
            rejectReadback.set(false)
            model.foreground(true)
            val confirmed = model.state.first { it.fast }
            assertTrue(confirmed.fast)
            assertEquals(1, writes.get())
            assertTrue(fixture.writes.isEmpty())
        }
    }

    @Test
    fun anExplicitNewChoiceWaitsForTheUnconfirmedSaveBeforeSubmitting() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val started = CompletableDeferred<Unit>()
            val fail = CompletableDeferred<Unit>()
            val writes = mutableListOf<Pair<String?, String?>>()
            val reads = mutableListOf<Long>()
            var delayed: UpdateDefaultModelPreference? = null
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        reads += currentTime
                        val snapshot = api.service.defaultModelPreference()
                        delayed?.let {
                            delayed = null
                            api.service.updateDefaultModelPreference(it)
                        }
                        return snapshot
                    }

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        writes += update.selectedModel to update.serviceTier?.name
                        if (update.serviceTier != null) {
                            started.complete(Unit)
                            fail.await()
                            delayed = update
                            throw ApiFailure.Http(503, null, null, 1L)
                        }
                        return api.service.updateDefaultModelPreference(update)
                    }
                }
            val model = model(api, service = remote, onFailure = {})
            model.openAfterSync()
            model.fast(true)
            started.await()
            model.select("claude-test")
            assertEquals("claude-test", model.state.value.selected?.id)
            fail.complete(Unit)

            advanceTimeBy(999)
            runCurrent()
            assertEquals(listOf(0L), reads)
            advanceTimeBy(1)
            val confirmed = model.state.first { it.pending == null }
            assertEquals(listOf(0L, 1_000L, 4_000L), reads)
            assertEquals(listOf("gpt-test" to "PRIORITY", "claude-test" to null), writes)
            assertEquals("claude-test", confirmed.selected?.id)
            assertEquals(JsonPrimitive("claude-test"), fixture.preference["selectedModel"])
            assertEquals(2, fixture.writes.size)
        }
    }

    @Test
    fun switchingBackStillSavesWhenReadbackPrecedesTheEarlierWrite() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val started = CompletableDeferred<Unit>()
            val fail = CompletableDeferred<Unit>()
            var lateWrite: UpdateDefaultModelPreference? = null
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        val snapshot = api.service.defaultModelPreference()
                        lateWrite?.let {
                            lateWrite = null
                            api.service.updateDefaultModelPreference(it)
                        }
                        return snapshot
                    }

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        if (update.selectedModel == "claude-test") {
                            started.complete(Unit)
                            fail.await()
                            lateWrite = update
                            throw ApiFailure.Http(503, null, null, null)
                        }
                        return api.service.updateDefaultModelPreference(update)
                    }
                }
            val model = model(api, service = remote, onFailure = {})
            assertEquals("gpt-test", model.openAfterSync().selectedModel)
            model.select("claude-test")
            started.await()
            model.select("gpt-test")
            fail.complete(Unit)

            val confirmed = model.state.first { it.pending == null }
            assertEquals("gpt-test", confirmed.selectedModel)
            assertEquals("gpt-test", api.service.defaultModelPreference().selectedModel)
            assertEquals(
                listOf(JsonPrimitive("claude-test"), JsonPrimitive("gpt-test")),
                fixture.writes.map { it["selectedModel"] },
            )
        }
    }

    @Test
    fun safeSaveRetriesFinishBeforeTheScheduledRead() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val confirmed = api.service.defaultModelPreference()
            val catalog = api.service.recoveryCatalog()
            val models = api.service.recoveryModels()
            val writes = mutableListOf<Long>()
            val reads = mutableListOf<Long>()
            val remote =
                object : WorkspaceSession by api.service {
                    override suspend fun recoveryCatalog() = catalog

                    override suspend fun recoveryModels() = models

                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        reads += currentTime
                        return confirmed
                    }

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        writes += currentTime
                        throw ApiFailure.Network(NoRouteToHostException())
                    }
                }
            val store = store(backgroundScope)
            val model = model(api, store, service = remote, onFailure = {})
            val notices = mutableListOf<DefaultModelNotice>()
            backgroundScope.launch { model.notices.collect { notices += it } }
            model.openAfterSync()
            model.fast(true)
            runCurrent()
            assertTrue(model.state.value.fast)

            advanceTimeBy(1_000)
            advanceTimeBy(1_000)
            runCurrent()
            assertEquals(listOf(0L), writes)
            advanceTimeBy(1_000)
            runCurrent()
            assertEquals(listOf(0L, 3_000L), writes)

            advanceTimeBy(2_999)
            assertTrue(notices.isEmpty())
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 6_000L), writes)
            assertEquals(listOf(0L), reads)
            assertEquals(listOf(DefaultModelNotice.SaveRolledBack), notices)
            assertFalse(model.state.value.fast)
            assertNull(model.state.value.pending)
            assertNull(store.load(api.identity).confirmed.serviceTier)

            advanceTimeBy(30_000)
            runCurrent()
            assertEquals(listOf(0L, 3_000L, 6_000L), writes)
            assertEquals(listOf(DefaultModelNotice.SaveRolledBack), notices)
            model.showSettings(null)
            advanceTimeBy(600_000 - currentTime)
            runCurrent()
            assertEquals(600_000L, reads.last())
            assertFalse(model.state.value.fast)
            assertNull(model.state.value.pending)
            assertNull(store.load(api.identity).confirmed.serviceTier)

            model.showSettings(SettingsDestination.Overview)
            advanceTimeBy(599_000)
            model.fast(true)
            runCurrent()
            assertTrue(model.state.value.fast)
            val attemptTimes = listOf(0L, 3_000L, 6_000L, 1_199_000L)
            assertEquals(attemptTimes, writes)

            model.showSettings(null)
            advanceTimeBy(1_000)
            runCurrent()
            assertEquals(600_000L, reads.last())
            assertTrue(model.state.value.fast)
            assertEquals(attemptTimes, writes)

            advanceTimeBy(5_000)
            runCurrent()
            assertEquals(1_205_000L, reads.last())
            assertFalse(model.state.value.fast)
            assertNull(store.load(api.identity).confirmed.serviceTier)
            advanceTimeBy(20_000)
            assertEquals(attemptTimes + listOf(1_202_000L, 1_205_000L), writes)
            assertEquals(List(2) { DefaultModelNotice.SaveRolledBack }, notices)
        }
    }

    @Test
    fun aDefinitiveRejectionImmediatelyRestoresTheConfirmedValue() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val fixtureResponse = api.commandResponse
            val writes = AtomicInteger()
            api.commandResponse = { request ->
                if (
                    request.method == "PUT" &&
                        request.requestUrl?.encodedPath == "/api/user-model-preference"
                ) {
                    writes.incrementAndGet()
                    jsonResponse("{}").setResponseCode(400)
                } else fixtureResponse(request)
            }
            val store = store(backgroundScope)
            val model =
                model(api, store, onFailure = { assertEquals(400, (it as ApiFailure.Http).status) })
            model.openAfterSync()
            model.fast(true)
            assertTrue(model.state.value.fast)
            assertEquals(DefaultModelNotice.SaveRolledBack, model.notices.first())
            assertFalse(model.state.value.fast)
            assertNull(model.state.value.pending)
            assertEquals(JsonNull, fixture.preference["serviceTier"])
            runCurrent()
            assertNull(store.load(api.identity).confirmed.serviceTier)

            model.foreground(false)
            advanceTimeBy(600_000)
            model.foreground(true)
            assertFalse(model.state.value.fast)
            assertEquals(1, writes.get())
        }
    }

    @Test
    fun anInvalidFastMultiplierKeepsASelectableModelOnStandard() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api).apply { gptFastMultiplier = 0.0 }
            val model = model(api)
            val state = model.openAfterSync()
            assertEquals("gpt-test", state.selected?.id)
            assertNull(state.selected?.fastMultiplier)
            model.fast(true)
            assertFalse(model.state.value.fast)
            assertTrue(fixture.writes.isEmpty())

            fixture.gptFastMultiplier = 2.75
            model.foreground(false)
            model.foreground(true)
            val refreshed = model.state.first { it.selected?.fastMultiplier == 2.75 }
            assertFalse(refreshed.fast)
            model.fast(true)
            assertTrue(model.state.first { it.pending == null }.fast)
            assertEquals(JsonPrimitive("priority"), fixture.writes.single()["serviceTier"])
        }
    }

    @Test
    fun restoredEffortTracksTheMemberExecutionRouteWithoutOverwritingTheSavedChoice() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api, piUltra = true)
            fixture.preference =
                JsonObject(
                    fixture.preference +
                        ("modelSettings" to
                            JsonObject(
                                mapOf(
                                    "gpt-test" to
                                        JsonObject(mapOf("effort" to JsonPrimitive("ultra"))),
                                ),
                            )),
                )
            val model = model(api)
            val pi = model.openAfterSync()
            assertEquals(ModelEffort.MEDIUM, pi.effort)
            assertFalse(ModelEffort.ULTRA in checkNotNull(pi.selected).efforts)
            model.effort(ModelEffort.ULTRA)
            assertNull(model.state.value.pending)

            model.showSettings(SettingsDestination.ModelAccounts)
            fixture.codexExecution = true
            model.showSettings(SettingsDestination.Overview)
            val codex = model.state.first { it.effort == ModelEffort.ULTRA }
            assertTrue(ModelEffort.ULTRA in checkNotNull(codex.selected).efforts)
            assertTrue(fixture.writes.isEmpty())
        }
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
class DefaultModelQueuedSaveTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test
    fun throttledDefaultModelSaveHonorsRetryAfterAndRollsBackOnce() = runTest {
        ChatListApiFixture().use { api ->
            DefaultModelApiFixture(api)
            val confirmed = api.service.defaultModelPreference()
            val times = mutableListOf<Long>()
            var reads = 0
            val service =
                object : WorkspaceSession by api.service {
                    override suspend fun defaultModelPreference(): DefaultModelPreference {
                        reads++
                        return confirmed
                    }

                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        times += currentTime
                        throw ApiFailure.Http(429, null, null, 2)
                    }
                }
            val file = temporary.newFolder().resolve("default-model.preferences_pb")
            val store =
                DefaultModelStore(
                    PreferenceDataStoreFactory.create(scope = backgroundScope) { file },
                    backgroundScope,
                )
            val model =
                DefaultModelSettings(
                    backgroundScope,
                    service,
                    api.identity,
                    store,
                    { true },
                    nowMillis = { currentTime },
                    monotonicMillis = { currentTime },
                    onFailure = {},
                )
            model.showSettings(null)
            model.foreground(true)
            model.state.first { it.record?.lastRefreshMillis != null }
            model.showSettings(SettingsDestination.Overview)
            model.state.first { it.selected?.fastMultiplier != null }
            val start = currentTime
            model.fast(true)
            runCurrent()
            advanceTimeBy(1_999)
            runCurrent()
            assertEquals(listOf(start), times)
            assertTrue(model.state.value.fast)
            assertNull(model.state.value.saveFeedback)
            advanceTimeBy(2_001)
            runCurrent()
            assertEquals(listOf(start, start + 2_000, start + 4_000), times)
            assertEquals(1, reads)
            assertFalse(model.state.value.fast)
            assertNull(model.state.value.pending)
            assertEquals(DefaultModelNotice.SaveRolledBack, model.state.value.saveFeedback?.value)
        }
    }

    @Test
    fun queuedSaveClearsFastWhenTheSubscriptionRouteLosesIt() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val effortSaveStarted = CompletableDeferred<Unit>()
            val releaseEffortSave = CompletableDeferred<Unit>()
            val service =
                object : WorkspaceSession by api.service {
                    override suspend fun updateDefaultModelPreference(
                        update: UpdateDefaultModelPreference,
                    ): DefaultModelPreference {
                        if (update.modelSettingsPatch?.effort == ModelEffort.HIGH) {
                            effortSaveStarted.complete(Unit)
                            releaseEffortSave.await()
                        }
                        return api.service.updateDefaultModelPreference(update)
                    }
                }
            val file = temporary.newFolder().resolve("default-model.preferences_pb")
            val store =
                DefaultModelStore(
                    PreferenceDataStoreFactory.create(scope = backgroundScope) { file },
                    backgroundScope,
                )
            val model =
                DefaultModelSettings(
                    backgroundScope,
                    service,
                    api.identity,
                    store,
                    { true },
                    nowMillis = { currentTime },
                    monotonicMillis = { currentTime },
                    onFailure = { throw it },
                )
            model.showSettings(null)
            model.foreground(true)
            model.state.first { it.record?.lastRefreshMillis != null }
            model.showSettings(SettingsDestination.Overview)
            val loaded = model.state.first { it.options != null }
            assertEquals(2.5, loaded.selected?.fastMultiplier)
            model.fast(true)
            assertTrue(model.state.first { it.pending == null }.fast)
            model.effort(ModelEffort.HIGH)
            effortSaveStarted.await()
            model.effort(ModelEffort.MEDIUM)
            assertTrue(model.state.value.fast)

            fixture.gptFastAvailable = false
            model.foreground(false)
            model.foreground(true)
            assertFalse(model.state.first { it.selected?.fastMultiplier == null }.fast)
            releaseEffortSave.complete(Unit)

            val confirmed = model.state.first { it.pending == null }
            assertEquals(ModelEffort.MEDIUM, confirmed.effort)
            assertNull(confirmed.record?.confirmed?.serviceTier)
            assertEquals(
                listOf(JsonPrimitive("priority"), JsonPrimitive("priority"), JsonNull),
                fixture.writes.map { it["serviceTier"] },
            )
        }
    }
}
