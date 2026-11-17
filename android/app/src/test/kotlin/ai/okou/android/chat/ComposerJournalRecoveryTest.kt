package ai.okou.android.chat

import ai.okou.android.CHAT_AGENT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ComposerApiFixture
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.WorkspaceIdentity
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.test.core.app.ApplicationProvider
import java.io.File
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = TestOkouApplication::class)
class ComposerJournalRecoveryTest {
    @get:Rule val temporary = TemporaryFolder()
    private val target = ComposerTarget(CHAT_PERSONAL, CHAT_AGENT)

    private class Fixture(val root: File, private val dispatcher: CoroutineDispatcher) {
        val api = ComposerApiFixture()
        private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        var store = ComposerJournalStore(context, root, dispatcher)
            private set

        private val owners = mutableListOf<ViewModelStore>()

        fun model(identity: WorkspaceIdentity = api.identity): ChatComposerModel {
            val owner = ViewModelStore().also { owners += it }
            return ViewModelProvider(
                owner,
                viewModelFactory {
                    initializer {
                        ChatComposerModel(api.service, store, identity, { true }, {}, {})
                    }
                },
            )[ChatComposerModel::class.java]
        }

        suspend fun reopen() {
            owners.forEach { it.clear() }
            owners.clear()
            store.close()
            store = ComposerJournalStore(context, root, dispatcher)
        }

        suspend fun close() {
            owners.forEach { it.clear() }
            try {
                store.close()
            } finally {
                api.close()
            }
        }

        fun file() = checkNotNull(root.listFiles()).single { it.extension == "json" }

        fun posts() = api.requests.count { it.method == "POST" }
    }

    private fun check(action: suspend TestScope.(Fixture) -> Unit) = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        Dispatchers.setMain(dispatcher)
        val fixture = Fixture(temporary.newFolder(), dispatcher)
        try {
            action(fixture)
        } finally {
            try {
                fixture.close()
            } finally {
                Dispatchers.resetMain()
            }
        }
    }

    private suspend fun pending(fixture: Fixture): ChatComposerModel {
        val model = fixture.model()
        model.open(target)
        model.uiState.first { it.persistence == ComposerPersistence.Durable }
        fixture.api.disconnectSend = true
        model.edit(target, "Original input 你好 👋")
        model.send(target)
        model.uiState.first { target.key in it.failed }
        model.edit(target, "Newer draft **kept**")
        model.uiState.first { it.persistence == ComposerPersistence.Durable }
        assertEquals(1, fixture.posts())
        assertNotNull(model.uiState.value.entry(target).pending)
        return model
    }

    @Test
    fun unversionedFilesStayUnavailableAndUntouchedInsteadOfRestoringEmptyIntent() =
        check { fixture ->
            val original = pending(fixture).uiState.value.entry(target)
            val wire = Json.parseToJsonElement(fixture.file().readText()).jsonObject
            for (broken in listOf("{}", JsonObject(wire - "format").toString())) {
                fixture.reopen()
                fixture.file().writeText(broken)
                val model = fixture.model(fixture.api.identity.copy(sessionId = "renewed"))
                model.open(target)
                val failed = model.uiState.first { it.persistence != ComposerPersistence.Loading }
                assertEquals(ComposerPersistence.Failed, failed.persistence)
                assertNull(failed.journal)
                assertFalse(failed.canSend(target))
                model.edit(target, "Must not replace unreadable intent")
                model.send(target)
                model.retry(target)
                model.observe(target)
                model.retryLocal()
                model.open(target)
                model.uiState.first { it.persistence != ComposerPersistence.Loading }
                runCurrent()
                assertEquals(ComposerPersistence.Failed, model.uiState.value.persistence)
                assertNull(model.uiState.value.journal)
                assertEquals(broken, fixture.file().readText())
                assertEquals(1, fixture.posts())
            }
            // Retry can recover once storage is repaired, without manufacturing a new request.
            fixture.file().writeText(wire.toString())
            val recovered = fixture.model()
            recovered.open(target)
            recovered.uiState.first { it.persistence == ComposerPersistence.Durable }
            assertEquals(original, recovered.uiState.value.entry(target))
            assertEquals(1, fixture.posts())
        }

    @Test
    fun validPendingJournalReopensAcrossSessionsAndOnlyExplicitRecoveryReusesTheRequest() =
        check { fixture ->
            val original = pending(fixture).uiState.value.entry(target)
            val originalRequest = fixture.api.inputs.values.single()
            fixture.reopen()
            val model = fixture.model(fixture.api.identity.copy(sessionId = "renewed"))
            model.open(target)
            model.uiState.first { it.persistence == ComposerPersistence.Durable }
            assertEquals(original, model.uiState.value.entry(target))
            assertEquals(1, fixture.posts())
            for (other in
                listOf(
                    fixture.api.identity.copy(userId = "other-user"),
                    fixture.api.identity.copy(workspaceId = "other-workspace"),
                    fixture.api.identity.copy(apiOrigin = "https://other.example/"),
                )) {
                val separate = fixture.model(other)
                separate.open(target)
                val state = separate.uiState.first { it.persistence == ComposerPersistence.Durable }
                assertTrue(checkNotNull(state.journal).entries.isEmpty())
                assertFalse(state.canSend(target))
            }
            fixture.api.disconnectSend = false
            model.retry(target)
            model.uiState.first {
                it.entry(target).receipt != null && it.persistence == ComposerPersistence.Durable
            }
            assertEquals(2, fixture.posts())
            assertEquals(originalRequest, fixture.api.inputs.values.single())
            val requests = fixture.api.requests.filter { it.method == "POST" }
            assertEquals(requests[0].body.clone().readUtf8(), requests[1].body.clone().readUtf8())
            assertEquals(original.text, model.uiState.value.entry(target).text)
            assertNull(model.uiState.value.entry(target).pending)
            assertEquals(
                original.pending!!.eventId,
                model.uiState.value.entry(target).receipt!!.eventId,
            )
        }

    @Test
    fun missingFileAndWriterProducedEmptyJournalBothAllowNormalUse() = check { fixture ->
        val model = fixture.model()
        model.open(target)
        val initial = model.uiState.first { it.persistence == ComposerPersistence.Durable }
        assertTrue(checkNotNull(initial.journal).entries.isEmpty())
        assertTrue(checkNotNull(fixture.root.listFiles()).isEmpty())
        model.edit(target, "An editable draft")
        model.uiState.first { it.persistence == ComposerPersistence.Durable }
        model.edit(target, "")
        model.uiState.first { it.persistence == ComposerPersistence.Durable }
        val empty = fixture.file().readText()
        assertEquals(
            "1",
            Json.parseToJsonElement(empty).jsonObject.getValue("format").jsonPrimitive.content,
        )
        fixture.reopen()
        val restored = fixture.model()
        restored.open(target)
        val state = restored.uiState.first { it.persistence == ComposerPersistence.Durable }
        assertTrue(checkNotNull(state.journal).entries.isEmpty())
        assertEquals(empty, fixture.file().readText())
        restored.edit(target, "Send after reopening an empty journal")
        assertTrue(restored.uiState.value.canSend(target))
        restored.send(target)
        restored.uiState.first { it.entry(target).receipt != null }
        assertEquals(1, fixture.posts())
    }
}
