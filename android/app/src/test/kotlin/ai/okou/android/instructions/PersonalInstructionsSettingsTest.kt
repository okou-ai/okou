package ai.okou.android.instructions

import ai.okou.android.InstructionsApiFixture
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.TestOkouApplication
import ai.okou.android.auth.SessionModel
import ai.okou.android.openChatListSettings
import android.content.Intent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDisplayed
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInputSelection
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
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
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

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
            compose.onNodeWithContentDescription("Chats").assertExists()
            val firstSession = ViewModelProvider(compose.activity)[SessionModel::class.java]
            val first = checkNotNull(firstSession.uiState.value.ready).instructions
            editorJob = first.viewModelScope.coroutineContext[Job]
            var secondSession: SessionModel? = null
            other =
                ActivityScenario.launch(
                    Intent(app, MainActivity::class.java)
                        .addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_MULTIPLE_TASK,
                        ),
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
            assertEquals(
                "Keep editing after the other Activity closes",
                first.uiState.value.content,
            )
            assertEquals(null, restored.draft)
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
    @Config(qualifiers = "en-rUS-w240dp-h200dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortSettingsWindowAllowsEditingAndSavingAtLargeType() = assertShortEditor(208.dp)

    @Test
    @Config(qualifiers = "en-rUS-w820dp-h200dp")
    @GraphicsMode(GraphicsMode.Mode.NATIVE)
    fun shortWideSettingsWindowUsesAvailableWidth() = assertShortEditor(788.dp)

    private fun assertShortEditor(editorWidth: Dp) {
        val app = compose.activity.application as InstructionsApplication
        val originalFontScale = RuntimeEnvironment.getFontScale()
        try {
            RuntimeEnvironment.setFontScale(2f)
            compose.activityRule.scenario.recreate()
            compose.onNodeWithContentDescription("Chats").assertExists()
            compose.openChatListSettings()
            compose
                .onNodeWithText("Personal Instructions")
                .performScrollTo()
                .assertIsDisplayed()
                .performSemanticsAction(SemanticsActions.OnClick)
            compose.onNodeWithText("Cancel").assertExists()
            val editor = compose.runOnIdle {
                val session = ViewModelProvider(compose.activity)[SessionModel::class.java]
                checkNotNull(session.uiState.value.ready).instructions.also {
                    editorJob = it.viewModelScope.coroutineContext[Job]
                }
            }
            app.readGate.countDown()
            compose.waitUntil(10_000) { compose.runOnIdle { !editor.uiState.value.busy } }
            assertEquals(InstructionsPhase.Ready, editor.uiState.value.phase)
            val input = compose.onNodeWithTag("instructions_editor")
            input
                .performScrollTo()
                .assertIsDisplayed()
                .assertWidthIsEqualTo(editorWidth)
                .performTextReplacement("Short window draft")
            val save = compose.onNodeWithText("Save")
            if (!save.isDisplayed()) save.performScrollTo()
            save.assertIsDisplayed().performClick()
            compose.waitUntil(10_000) { compose.runOnIdle { editor.uiState.value.draft == null } }
            assertEquals("Short window draft", app.fixture.saved.content)
        } finally {
            RuntimeEnvironment.setFontScale(originalFontScale)
        }
    }

    @Test
    fun loadingLeavesSettingsUsableAndBackgroundUpdatesPreserveSelectionAndSave() {
        val app = compose.activity.application as InstructionsApplication
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.openChatListSettings()
        compose.onNodeWithText("Display mode").assertExists()
        compose.onNodeWithText("Personal Instructions").performScrollTo().performClick()
        compose.onNodeWithContentDescription("Loading Instructions…").assertExists()
        val model = compose.runOnIdle {
            checkNotNull(
                    ViewModelProvider(compose.activity)[SessionModel::class.java]
                        .uiState
                        .value
                        .ready,
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
        val save = compose.onNodeWithText("Save")
        val saved = checkNotNull(model.uiState.value.saved).content
        save.assertIsNotEnabled()
        input.performScrollTo().performClick()
        input.performTextReplacement(saved + " ")
        save.assertIsEnabled()
        input.performTextReplacement(saved)
        save.assertIsNotEnabled()
        input.performTextInputSelection(TextRange.Zero)
        input.performSemanticsAction(SemanticsActions.SetText) { setText ->
            assertTrue(setText(AnnotatedString("Temporary input")))
            assertTrue(setText(AnnotatedString(saved)))
        }
        input.assertTextEquals(saved)
        save.assertIsNotEnabled()
        input.performTextReplacement("$saved\u0000")
        val invalidMessage = app.getString(R.string.instructions_invalid)
        compose.onNodeWithText(invalidMessage).assertExists()
        assertEquals(invalidMessage, input.fetchSemanticsNode().config[SemanticsProperties.Error])
        save.assertIsNotEnabled()
        input.performScrollTo().performTextReplacement("Keep **my** 中文 👋 draft")
        compose.waitUntil(10_000) {
            val layouts = mutableListOf<TextLayoutResult>()
            input.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            layouts.singleOrNull()?.layoutInput?.text?.spanStyles?.any {
                it.item.fontWeight == FontWeight.Bold
            } == true
        }
        input.performTextInputSelection(TextRange(5, 8))
        input.assertIsFocused()
        assertEquals(
            TextRange(5, 8),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        app.fixture.externalEdit("Changed on Web")
        compose.runOnIdle { model.refresh() }
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                model.uiState.value.let { !it.busy && it.saved?.content == "Changed on Web" }
            }
        }
        assertEquals(
            "Keep **my** 中文 👋 draft",
            input.fetchSemanticsNode().config[SemanticsProperties.EditableText].text,
        )
        assertEquals(
            TextRange(5, 8),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        save.assertIsEnabled()
        assertEquals(0, app.fixture.requests.count { it.method == "PUT" })
        val discard = compose.onNode(hasText("Discard changes") and hasClickAction())
        compose.onNodeWithText("Cancel").performClick()
        discard.assertIsDisplayed()
        discard.performClick()
        input.assertDoesNotExist()
        compose.runOnIdle { assertEquals("Changed on Web", model.uiState.value.content) }
        compose.onNodeWithText("Personal Instructions").performScrollTo().performClick()
        awaitPhase(InstructionsPhase.Ready)
        input.assertTextEquals("Changed on Web")
        input.performScrollTo().performTextClearance()
        assertEquals("", input.fetchSemanticsNode().config[SemanticsProperties.EditableText].text)
        app.fixture.disconnectSave = true
        val markdown = "**Accepted** despite lost response"
        input.performScrollTo().performTextReplacement(markdown)
        input.performTextInputSelection(TextRange(2, 9))
        val saveReply = CountDownLatch(1)
        app.fixture.beforeSave = { saveReply.await() }
        val cancel = compose.onNodeWithText("Cancel")
        save.performScrollTo()
        val idleSaveBounds = save.getUnclippedBoundsInRoot()
        val idleCancelBounds = cancel.getUnclippedBoundsInRoot()
        val idleEditorBounds = input.getUnclippedBoundsInRoot()
        val readCount = app.fixture.requests.count { it.method == "GET" }
        try {
            save.performClick()
            val pending = compose.onNodeWithText(app.getString(R.string.settings_saving))
            pending.assertIsDisplayed().assertIsNotEnabled()
            assertEquals(idleSaveBounds, pending.getUnclippedBoundsInRoot())
            assertEquals(idleCancelBounds, cancel.getUnclippedBoundsInRoot())
            assertEquals(idleEditorBounds, input.getUnclippedBoundsInRoot())
            cancel.assertIsNotEnabled()
        } finally {
            saveReply.countDown()
        }
        compose.waitUntil(10_000) { compose.runOnIdle { model.uiState.value.saveRejected } }
        val failed =
            compose.onNodeWithText(
                app.getString(R.string.instructions_save_rejected),
                useUnmergedTree = true,
            )
        failed.assertIsDisplayed()
        save.assertIsEnabled()
        cancel.assertIsEnabled()
        assertTrue(failed.getUnclippedBoundsInRoot().bottom <= idleSaveBounds.top)
        assertEquals(idleSaveBounds, save.getUnclippedBoundsInRoot())
        assertEquals(idleCancelBounds, cancel.getUnclippedBoundsInRoot())
        assertEquals(idleEditorBounds, input.getUnclippedBoundsInRoot())
        assertEquals(
            markdown,
            input.fetchSemanticsNode().config[SemanticsProperties.EditableText].text,
        )
        assertEquals(
            TextRange(2, 9),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        assertEquals(readCount, app.fixture.requests.count { it.method == "GET" })
        assertEquals(1, app.fixture.requests.count { it.method == "PUT" })
        app.fixture.disconnectSave = false
        save.performClick()
        compose.waitUntil(10_000) {
            compose.runOnIdle {
                model.uiState.value.phase == InstructionsPhase.Ready &&
                    model.uiState.value.draft == null
            }
        }
        assertEquals(markdown, app.fixture.saved.content)
        assertEquals(readCount + 1, app.fixture.requests.count { it.method == "GET" })
        assertEquals(1, app.fixture.requests.count { it.method == "PUT" })
        input.assertDoesNotExist()
        compose.onNodeWithText("Personal Instructions").performScrollTo().performClick()
        awaitPhase(InstructionsPhase.Ready)
        val savedElsewhere = "Text written elsewhere after a rejected save"
        app.fixture.rejectSave = true
        input.performScrollTo().performTextReplacement(savedElsewhere)
        save.performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
        compose.waitUntil(10_000) { compose.runOnIdle { model.uiState.value.saveRejected } }
        app.fixture.externalEdit(savedElsewhere)
        compose.runOnIdle { model.refresh() }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.saved?.content == savedElsewhere }
        }
        input.assertTextEquals(savedElsewhere)
        save.assertIsNotEnabled()
        val large = "Personal instructions 👋 ".repeat(5_000)
        input.performScrollTo().performClick().performTextReplacement(large)
        input.performTextInputSelection(TextRange(13))
        save.performScrollTo().performSemanticsAction(SemanticsActions.OnClick)
        val rejected =
            compose.onNodeWithText(
                app.getString(R.string.instructions_save_rejected),
                useUnmergedTree = true,
            )
        compose.waitUntil(10_000) { compose.runOnIdle { model.uiState.value.saveRejected } }
        rejected.assertExists()
        assertTrue(
            rejected.getUnclippedBoundsInRoot().bottom <= save.getUnclippedBoundsInRoot().top,
        )
        input.assertIsFocused()
        val requestCount = app.fixture.requests.size
        // Recreation also verifies the shared whole-Activity saved-state budget.
        compose.activityRule.scenario.recreate()
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.phase == InstructionsPhase.Ready }
        }
        input.assertIsFocused()
        rejected.assertExists()
        assertEquals(requestCount, app.fixture.requests.size)
        assertEquals(
            large,
            input.fetchSemanticsNode().config[SemanticsProperties.EditableText].text,
        )
        assertEquals(
            TextRange(13),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        discard.assertIsDisplayed()
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        discard.assertDoesNotExist()
        input.assertIsFocused()
        assertEquals(
            TextRange(13),
            input.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
        discard.performClick()
        input.assertDoesNotExist()
        compose.onNodeWithText("Display mode").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Chats").assertExists()
    }

    @Test
    fun aFailedColdReadUsesItsReservedSpaceAndABackgroundFailureKeepsTheEditor() {
        val app = compose.activity.application as InstructionsApplication
        compose.onNodeWithContentDescription("Chats").assertExists()
        compose.openChatListSettings()
        compose.onNodeWithText("Personal Instructions").performScrollTo().performClick()
        val placeholder = compose.onNodeWithContentDescription("Loading Instructions…")
        val save = compose.onNodeWithText("Save")
        val cancel = compose.onNodeWithText("Cancel")
        placeholder.assertExists()
        val initialSave = save.getUnclippedBoundsInRoot()
        val initialCancel = cancel.getUnclippedBoundsInRoot()
        val model = compose.runOnIdle {
            val session = ViewModelProvider(compose.activity)[SessionModel::class.java]
            checkNotNull(session.uiState.value.ready).instructions.also {
                editorJob = it.viewModelScope.coroutineContext[Job]
            }
        }
        app.fixture.rejectRead = true
        app.readGate.countDown()
        fun awaitRead(read: InstructionsRead) {
            compose.waitUntil(10_000) {
                compose.runOnIdle {
                    model.uiState.value.let { !it.busy && it.read == read }
                }
            }
        }
        awaitRead(InstructionsRead.Failed)
        compose
            .onNodeWithTag("instructions_read_failure")
            .assertIsDisplayed()
            .assertTextEquals(app.getString(R.string.instructions_load_failed))
        placeholder.assertDoesNotExist()
        save.assertIsNotEnabled()
        assertEquals(initialSave, save.getUnclippedBoundsInRoot())
        assertEquals(initialCancel, cancel.getUnclippedBoundsInRoot())
        assertEquals(3, app.fixture.requests.count { it.method == "GET" })

        app.fixture.rejectRead = false
        compose.runOnIdle { model.refresh() }
        awaitRead(InstructionsRead.Ready)
        val input = compose.onNodeWithTag("instructions_editor")
        input.assertTextEquals(app.fixture.saved.content)
        assertEquals(initialSave, save.getUnclippedBoundsInRoot())
        input.performTextReplacement("Keep editing when the read fails")
        val initialEditor = input.getUnclippedBoundsInRoot()
        app.fixture.rejectRead = true
        compose.runOnIdle { model.refresh() }
        awaitRead(InstructionsRead.RefreshFailed)
        val feedback = compose.onNodeWithText(app.getString(R.string.instructions_refresh_failed))
        feedback.assertIsDisplayed()
        val snackbarBounds = feedback.getUnclippedBoundsInRoot()
        assertTrue(
            "Refresh feedback $snackbarBounds stays above Save $initialSave",
            snackbarBounds.bottom <= initialSave.top,
        )
        input.assertTextEquals("Keep editing when the read fails")
        save.assertIsEnabled()
        assertEquals(initialEditor, input.getUnclippedBoundsInRoot())
        assertEquals(initialSave, save.getUnclippedBoundsInRoot())

        compose.mainClock.advanceTimeBy(5_500L)
        feedback.assertDoesNotExist()
        val reads = app.fixture.requests.count { it.method == "GET" }
        app.fixture.rejectSave = true
        val permitSave = CountDownLatch(1)
        app.fixture.beforeSave = { permitSave.await() }
        try {
            save.performClick()
            compose.onNodeWithText(app.getString(R.string.settings_saving)).assertExists()
        } finally {
            permitSave.countDown()
        }
        compose.waitUntil(10_000) { compose.runOnIdle { model.uiState.value.saveRejected } }
        compose.onNodeWithText(app.getString(R.string.instructions_save_rejected)).assertExists()
        feedback.assertDoesNotExist()
        assertEquals(reads, app.fixture.requests.count { it.method == "GET" })
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
