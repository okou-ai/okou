package ai.okou.android.instructions

import ai.okou.android.InstructionsApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import android.content.Intent
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.TextRange
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.test.core.app.ActivityScenario
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.model.MultipleFailureException
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

class InstructionsApplication : TestOkouApplication() {
    lateinit var fixture: InstructionsApiFixture
    lateinit var draftDirectory: java.io.File
    val readGate = CountDownLatch(1)

    override fun onCreate() {
        fixture = InstructionsApiFixture()
        fixture.beforeRead = { readGate.await() }
        instructionsService = fixture.service
        draftDirectory = Files.createTempDirectory("instructions-ui-").toFile()
        instructionsStore = PersonalInstructionsDraftStore(this, draftDirectory)
        super.onCreate()
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = InstructionsApplication::class)
class PersonalInstructionsSettingsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private var editorJob: Job? = null

    @Test
    fun twoAuthorizedActivitiesShareEditsAndTheFrozenSaveTransaction() {
        val app = compose.activity.application as InstructionsApplication
        var other: ActivityScenario<MainActivity>? = null
        var otherJob: Job? = null
        val failures = mutableListOf<Throwable>()
        try {
            compose.onNodeWithText("Chats").assertExists()
            val firstSession = ViewModelProvider(compose.activity)[SessionModel::class.java]
            val first = checkNotNull(firstSession.uiState.value.ready).instructions
            editorJob = first.viewModelScope.coroutineContext[Job]
            var secondSession: SessionModel? = null
            other =
                ActivityScenario.launch(
                    Intent(app, MainActivity::class.java)
                        .addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK
                        )
                )
            compose.waitUntil(10_000) {
                other.onActivity { secondSession = ViewModelProvider(it)[SessionModel::class.java] }
                secondSession?.uiState?.value?.ready != null
            }
            val session = checkNotNull(secondSession)
            val second = checkNotNull(session.uiState.value.ready).instructions
            otherJob = second.viewModelScope.coroutineContext[Job]
            assertNotSame(firstSession, session)
            assertTrue(firstSession.isPresentationCurrent(firstSession.uiState.value.generation))
            assertTrue(session.isPresentationCurrent(session.uiState.value.generation))
            compose.runOnIdle {
                first.open()
                second.open()
            }
            app.readGate.countDown()
            compose.waitUntil(10_000) {
                compose.runOnIdle { first.uiState.value.phase == InstructionsPhase.Ready }
            }
            compose.runOnIdle {
                first.edit("Draft from first Activity")
                assertEquals("Draft from first Activity", second.uiState.value.content)
                second.edit("Latest accepted draft")
                first.save()
                second.edit("Cannot replace a frozen save")
                second.save()
                assertFalse(second.uiState.value.canEdit)
                assertEquals("Latest accepted draft", first.uiState.value.content)
            }
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    second.uiState.value.phase == InstructionsPhase.Ready &&
                        second.uiState.value.draft == null
                }
            }
            assertEquals("Latest accepted draft", app.fixture.saved.content)
            assertEquals(1, app.fixture.requests.count { it.method == "PUT" })
            other.close()
            compose.runOnIdle {
                assertTrue(first.uiState.value.canEdit)
                first.edit("Keep editing after the other Activity closes")
            }
            compose.waitUntil(10_000) { compose.runOnIdle { !first.uiState.value.persisting } }
            val restored = runBlocking {
                app.instructionsDrafts.load(checkNotNull(firstSession.uiState.value.ready).identity)
            }
            assertEquals("Keep editing after the other Activity closes", restored.draft?.content)
        } catch (error: Throwable) {
            failures += error
        } finally {
            for (cleanup in
                listOf<() -> Unit>(
                    { other?.close() },
                    { runBlocking { withTimeout(10_000) { otherJob?.join() } } },
                )) {
                try {
                    cleanup()
                } catch (error: Throwable) {
                    failures += error
                }
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }

    @Test
    fun loadingLeavesSettingsUsableAndConflictsPreserveNativeSelectionUntilExplicitReload() {
        val app = compose.activity.application as InstructionsApplication
        compose.onNodeWithText("Chats").assertExists()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Appearance").assertExists()
        compose.onNodeWithText("Loading Instructions…").assertExists()
        val model =
            compose.runOnIdle {
                checkNotNull(
                        ViewModelProvider(compose.activity)[SessionModel::class.java]
                            .uiState
                            .value
                            .ready
                    )
                    .instructions
                    .also { editorJob = it.viewModelScope.coroutineContext[Job] }
            }
        fun awaitPhase(phase: InstructionsPhase) {
            compose.waitUntil(10_000) { compose.runOnIdle { model.uiState.value.phase == phase } }
        }
        app.readGate.countDown()
        awaitPhase(InstructionsPhase.Ready)
        val input = compose.onNodeWithTag("instructions_editor")
        input.performScrollTo().performTextReplacement("Keep **my** 中文 👋 draft")
        input.performTextInputSelection(TextRange(5, 8))
        app.fixture.externalEdit("Changed on Web")
        compose.runOnIdle { model.refresh() }
        awaitPhase(InstructionsPhase.Conflict)
        assertEquals(
            "Keep **my** 中文 👋 draft",
            input.fetchSemanticsNode().config[SemanticsProperties.EditableText].text,
        )
        assertEquals(
            TextRange(5, 8),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        compose.onNodeWithText("Save Instructions").assertIsNotEnabled()
        assertEquals(0, app.fixture.requests.count { it.method == "PUT" })
        compose.onNodeWithText("Reload latest and discard changes").performScrollTo().performClick()
        awaitPhase(InstructionsPhase.Ready)
        input.assertTextEquals("Instructions", "Changed on Web")
        app.fixture.disconnectSave = true
        input.performScrollTo().performTextReplacement("Accepted despite lost response")
        compose.onNodeWithText("Save Instructions").performScrollTo().performClick()
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                model.uiState.value.phase == InstructionsPhase.Ready &&
                    model.uiState.value.draft == null
            }
        }
        assertEquals("Accepted despite lost response", app.fixture.saved.content)
        assertEquals(1, app.fixture.requests.count { it.method == "PUT" })
        val large = "Personal instructions 👋 ".repeat(5_000)
        input.performScrollTo().performTextReplacement(large)
        input.performTextInputSelection(TextRange(13))
        // Recreation also verifies the shared whole-Activity saved-state budget.
        compose.activityRule.scenario.recreate()
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.phase == InstructionsPhase.Ready }
        }
        assertEquals(
            large,
            input.fetchSemanticsNode().config[SemanticsProperties.EditableText].text,
        )
        assertEquals(
            TextRange(13),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
    }

    @After
    fun closeActualOwners() {
        val app = compose.activity.application as InstructionsApplication
        val failures = mutableListOf<Throwable>()
        for (cleanup in
            listOf<() -> Unit>(
                { app.readGate.countDown() },
                { compose.activityRule.scenario.close() },
                { runBlocking { withTimeout(10_000) { editorJob?.join() } } },
                { runBlocking { checkNotNull(app.instructionsStore).close() } },
                { app.fixture.close() },
                { check(app.draftDirectory.deleteRecursively()) },
            )) {
            try {
                cleanup()
            } catch (error: Throwable) {
                failures += error
            }
        }
        MultipleFailureException.assertEmpty(failures)
    }
}
