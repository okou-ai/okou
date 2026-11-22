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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.first
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
    @get:Rule val temporary = TemporaryFolder()

    private fun TestScope.model(
        api: ChatListApiFixture,
        store: DefaultModelStore = store(backgroundScope),
        scope: CoroutineScope = backgroundScope,
        identity: WorkspaceIdentity = api.identity,
        service: WorkspaceSession = api.service,
        onFailure: (Exception) -> Unit = { throw it },
    ) = DefaultModelSettings(scope, service, identity, store, { true }, { currentTime }, onFailure)

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
            assertNull(model.state.value.record?.selectedModel)
            assertNull(model.state.value.record?.lastRefreshMillis)
            assertEquals(listOf(0L), attempts)

            model.showSettings(null)
            runCurrent()
            assertEquals("claude-test", model.state.value.record?.selectedModel)
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
    fun offlineChangesCoalesceAndReopeningOnlyRestoresTheDisplayValue() = runTest {
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
                model.online(false)
                model.effort(ModelEffort.HIGH)
                model.select("claude-test")
                assertEquals(ModelEffort.HIGH, model.state.value.effort)
                model.select("gpt-test")
                assertEquals(ModelEffort.HIGH, model.state.value.effort)
                model.fast(true)
                assertTrue(fixture.writes.isEmpty())

                model.online(true)
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
                owner.cancelAndJoin()
                assertEquals("Claude Sonnet 5", store.load(api.identity).label)
                val key = stringPreferencesKey(api.identity.workspaceStorageKey())
                preferences.edit { values ->
                    val record = Json.parseToJsonElement(checkNotNull(values[key])).jsonObject
                    val edit = record.getValue("edit").jsonObject
                    assertEquals(setOf("request"), edit.keys)
                    val oldEdit =
                        JsonObject(
                            edit +
                                mapOf(
                                    "failedAttempts" to JsonPrimitive(1),
                                    "lastFailureMillis" to JsonPrimitive(currentTime),
                                )
                        )
                    values[key] = JsonObject(record + ("edit" to oldEdit)).toString()
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
            assertNull(reopened.load(otherWorkspace).edit)
            assertNull(reopened.load(api.identity.copy(userId = "other")).selectedModel)
            val model = model(api, reopened, identity = api.identity.copy(sessionId = "renewed"))
            model.online(false)
            model.showSettings(SettingsDestination.Overview)
            model.foreground(true)
            val restored = model.state.first { it.record != null }
            assertEquals("claude-test", restored.record?.selectedModel)
            assertEquals("Claude Sonnet 5", restored.record?.label)
            assertNull(restored.pending)

            model.online(true)
            val cached = model.state.first { it.options != null }
            assertEquals("claude-test", cached.selected?.id)
            assertEquals(ModelEffort.HIGH, cached.effort)
            assertFalse(cached.fast)
            advanceTimeBy(30_000)
            assertEquals(1, fixture.writes.size)
            assertEquals("claude-test", model.state.value.selected?.id)

            model.showSettings(null)
            val refreshAt = checkNotNull(restored.record?.lastRefreshMillis) + 600_000
            advanceTimeBy((refreshAt - currentTime).coerceAtLeast(0))
            val refreshed = model.state.first { it.record?.edit == null }
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
    fun saveConfirmsItsFieldsAndKeepsAnotherModelsLocalEffort() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val model = model(api)
            assertEquals(ModelEffort.MEDIUM, model.openAfterSync().effort)
            val changedElsewhere = JsonObject(mapOf("effort" to JsonPrimitive("medium")))
            fixture.preference =
                JsonObject(
                    fixture.preference +
                        ("modelSettings" to JsonObject(mapOf("claude-test" to changedElsewhere)))
                )

            model.effort(ModelEffort.HIGH)
            val synced = model.state.first { it.pending == null }
            assertEquals(ModelEffort.HIGH, synced.effort)
            assertEquals(
                JsonPrimitive("gpt-test"),
                fixture.writes.single()["modelSettingsPatch"]?.jsonObject?.get("model"),
            )

            model.online(false)
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
            val failed = model.state.first { it.catalogUnavailable }
            assertNull(failed.selected)
            assertNull(failed.record?.selectedModel)
            assertNull(failed.options)
            assertEquals(1, reads.get())
            val recovered = model.state.first { it.options != null }
            assertFalse(recovered.catalogUnavailable)
            assertNull(recovered.selected)
            assertEquals(2, reads.get())
        }
    }

    @Test
    fun cachedCatalogKeepsItsOptionsUntilTheFailureWindowExpiresAndThenRecovers() = runTest {
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
            advanceTimeBy(29_999)
            assertEquals(listOf(started, started + 5_000, started + 15_000), attempts)
            assertFalse(model.state.value.catalogUnavailable)
            advanceTimeBy(1)
            runCurrent()
            assertTrue(model.state.value.catalogUnavailable)
            assertEquals("gpt-test", model.state.value.selected?.id)
            unavailable = false
            model.online(false)
            model.online(true)
            runCurrent()
            assertFalse(model.state.value.catalogUnavailable)
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
                        update: UpdateDefaultModelPreference
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
            assertEquals("auto", model.state.value.record?.selectedModel)
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
            assertNull(confirmed.record?.edit)
            assertNull(confirmed.selected)
            assertEquals(1, fixture.writes.size)
            assertEquals(JsonNull, fixture.writes.single()["selectedModel"])
        }
    }

    @Test
    fun rejectedReadbackDoesNotRepeatTheWriteAndReconnectReconciles() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val fixtureResponse = api.commandResponse
            val rejectReadback = AtomicBoolean(true)
            val blockedReads = AtomicInteger()
            api.commandResponse = { request ->
                val response = fixtureResponse(request)
                if (request.requestUrl?.encodedPath != "/api/user-model-preference") response
                else if (request.method == "PUT") jsonResponse("{}")
                else if (fixture.writes.isNotEmpty() && rejectReadback.get()) {
                    blockedReads.incrementAndGet()
                    jsonResponse("{}").setResponseCode(403)
                } else response
            }
            val model = model(api, onFailure = {})
            assertFalse(model.openAfterSync().fast)
            model.fast(true)
            val blocked = model.state.first { it.saveDegraded }
            assertTrue(blocked.pending != null)
            assertTrue(blocked.fast)
            assertEquals(DefaultModelNotice.SyncFailed, model.notices.first())
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, blockedReads.get())
            assertEquals(1, fixture.writes.size)

            model.online(false)
            rejectReadback.set(false)
            model.online(true)
            val confirmed = model.state.first { it.pending == null }
            assertTrue(confirmed.fast)
            assertFalse(confirmed.saveDegraded)
            assertEquals(1, fixture.writes.size)
        }
    }

    @Test
    fun saveRetriesKeepTheirScheduleAcrossReconnectAndYieldToScheduledRead() = runTest {
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
                        update: UpdateDefaultModelPreference
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
            model.fast(true)
            runCurrent()
            assertTrue(model.state.value.fast)

            advanceTimeBy(1_000)
            model.online(false)
            runCurrent()
            advanceTimeBy(1_000)
            model.online(true)
            runCurrent()
            assertEquals(listOf(0L), writes)
            advanceTimeBy(3_000)
            runCurrent()
            assertEquals(listOf(0L, 5_000L), writes)

            advanceTimeBy(9_999)
            assertTrue(notices.isEmpty())
            advanceTimeBy(1)
            runCurrent()
            assertEquals(listOf(0L, 5_000L, 15_000L), writes)
            assertEquals(listOf(DefaultModelNotice.SyncFailed), notices)
            assertTrue(model.state.value.fast)
            assertNull(model.state.value.pending)
            assertEquals("PRIORITY", store.load(api.identity).edit?.request?.serviceTier?.name)

            advanceTimeBy(30_000)
            model.online(false)
            model.online(true)
            runCurrent()
            assertEquals(listOf(0L, 5_000L, 15_000L), writes)
            assertEquals(listOf(DefaultModelNotice.SyncFailed), notices)
            model.showSettings(null)
            advanceTimeBy(600_000 - currentTime)
            runCurrent()
            assertEquals(600_000L, reads.last())
            assertFalse(model.state.value.fast)
            assertNull(model.state.value.pending)
            assertNull(store.load(api.identity).edit)

            model.showSettings(SettingsDestination.Overview)
            advanceTimeBy(599_000)
            model.fast(true)
            runCurrent()
            assertTrue(model.state.value.fast)
            val attemptTimes = listOf(0L, 5_000L, 15_000L, 1_199_000L)
            assertEquals(attemptTimes, writes)

            model.showSettings(null)
            advanceTimeBy(1_000)
            runCurrent()
            assertEquals(1_200_000L, reads.last())
            assertFalse(model.state.value.fast)
            assertNull(store.load(api.identity).edit)
            advanceTimeBy(20_000)
            assertEquals(attemptTimes, writes)
            assertEquals(listOf(DefaultModelNotice.SyncFailed), notices)
        }
    }

    @Test
    fun aDefinitiveRejectionKeepsTheLocalChoiceUntilAnOrdinaryRefresh() = runTest {
        ChatListApiFixture().use { api ->
            val fixture = DefaultModelApiFixture(api)
            val fixtureResponse = api.commandResponse
            api.commandResponse = { request ->
                if (
                    request.method == "PUT" &&
                        request.requestUrl?.encodedPath == "/api/user-model-preference"
                )
                    jsonResponse("{}").setResponseCode(400)
                else fixtureResponse(request)
            }
            val store = store(backgroundScope)
            val model =
                model(api, store, onFailure = { assertEquals(400, (it as ApiFailure.Http).status) })
            model.openAfterSync()
            model.fast(true)
            val rejected = model.state.first { it.saveDegraded && it.pending == null }
            assertTrue(rejected.fast)
            assertEquals(DefaultModelNotice.SyncFailed, model.notices.first())
            assertEquals(JsonNull, fixture.preference["serviceTier"])
            runCurrent()
            assertEquals("PRIORITY", store.load(api.identity).edit?.request?.serviceTier?.name)

            model.foreground(false)
            advanceTimeBy(600_000)
            model.foreground(true)
            assertTrue(model.state.value.fast)
            model.showSettings(null)
            model.state.first { it.record?.edit == null }
            assertFalse(model.state.value.fast)
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
                                        JsonObject(mapOf("effort" to JsonPrimitive("ultra")))
                                )
                            ))
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
