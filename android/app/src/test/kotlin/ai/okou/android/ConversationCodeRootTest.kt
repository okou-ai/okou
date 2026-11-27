package ai.okou.android

import ai.okou.android.api.generated.SessionOutputDelta
import ai.okou.android.chat.RunOutputSignal
import android.content.ClipboardManager
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasAnyAncestor
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isFocused
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performKeyInput
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.pressKey
import androidx.compose.ui.test.printToString
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.height
import androidx.compose.ui.unit.width
import androidx.test.platform.app.InstrumentationRegistry
import java.time.Instant
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w1180dp-h840dp", application = ChatListApplication::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
internal class ConversationCodeRootTest : ArtifactCatalogRootTestFixture() {
    @Test
    fun longReplyKeepsItsCopyHeaderAndRestoresTheFullCodeTrigger() {
        val original =
            "\tval title = \"Release checklist\" // " +
                "Release plan and environment review ".repeat(7) +
                "\r\n" +
                (2..16).joinToString("\r\n", postfix = "\r\n") { "val checkpoint$it = $it" }
        val wrapped = "```kotlin\r\n$original```"
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.setInTouchMode(false)
        try {
            compose.activityRule.scenario.recreate()
            startChat(settled(wrapped))
            awaitText("Showing 12 / 16 lines")
            val read = compose.onNodeWithText("View full code")
            val copy = compose.onNodeWithContentDescription("Copy code")
            val card = compose.onNodeWithTag("conversation_code_card")
            val copyBounds = copy.getUnclippedBoundsInRoot()
            val hit = copy.fetchSemanticsNode().touchBoundsInRoot
            assertEquals(48.dp, with(compose.density) { hit.width.toDp() })
            assertEquals(48.dp, with(compose.density) { hit.height.toDp() })
            assertTrue(copyBounds.right < card.getUnclippedBoundsInRoot().right)

            val preview = compose.onNodeWithTag("conversation_code_source")
            val layouts = mutableListOf<TextLayoutResult>()
            preview.performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
            assertEquals(12, layouts.single().lineCount)
            val width = with(compose.density) { layouts.single().size.width.toDp() }
            assertTrue(
                "Code width $width should extend beyond the card",
                width > card.getUnclippedBoundsInRoot().width,
            )
            copy.performClick()
            assertClipboard(original)

            read.performSemanticsAction(SemanticsActions.RequestFocus) { assertTrue(it()) }
            read.assertIsFocused().performKeyInput { pressKey(Key.Enter) }
            awaitText("Full code")
            compose.onNodeWithTag("chat_list").assertIsDisplayed()
            val viewer = compose.onNodeWithTag("conversation_full_code")
            val pane = viewer.getUnclippedBoundsInRoot()
            compose.onNodeWithContentDescription("Expand code viewer").performClick()
            compose.onNodeWithTag("chat_list").assertDoesNotExist()
            assertTrue(viewer.getUnclippedBoundsInRoot().width > pane.width)
            compose.onNodeWithContentDescription("Collapse code viewer").performClick()
            assertEquals(pane, viewer.getUnclippedBoundsInRoot())
            compose.onNodeWithContentDescription("Copy code").performClick()
            assertClipboard(original)

            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            try {
                compose.waitUntilExactlyOneExists(hasText("View full code") and isFocused(), 10_000)
            } catch (error: ComposeTimeoutException) {
                throw AssertionError(compose.onRoot(useUnmergedTree = true).printToString(), error)
            }
            assertEquals(copyBounds, copy.getUnclippedBoundsInRoot())
        } finally {
            instrumentation.resetInTouchMode()
        }
    }

    @Test
    fun narrowingAReaderWithSearchOpenKeepsTheSourceAndReturnsToTheChat() {
        val originalQualifiers = RuntimeEnvironment.getQualifiers()
        val sample =
            (1..18).joinToString("\n", postfix = "\n") {
                "release checkpoint $it " + "details ".repeat(23)
            }
        try {
            startChat(settled("```text\n$sample```"))
            awaitText("Showing 12 / 18 lines")
            compose.onNodeWithTag("workspace_search_entry").performClick()
            val query = compose.onNodeWithTag("chat_search_query")
            query.performTextReplacement("release")
            compose.onNodeWithText("View full code").performClick()
            awaitText("Full code")
            query.assertIsDisplayed()
            val scrolling =
                compose.onNode(
                    SemanticsMatcher.keyIsDefined(SemanticsProperties.HorizontalScrollAxisRange) and
                        hasAnyAncestor(hasTestTag("conversation_full_code")),
                )
            fun axis() =
                scrolling.fetchSemanticsNode().config[SemanticsProperties.HorizontalScrollAxisRange]
            scrolling.performSemanticsAction(SemanticsActions.ScrollBy) { it(180f, 0f) }
            compose.waitUntil(10_000) { axis().value() > 0f }
            compose.waitForIdle()
            val offset = axis().value()

            RuntimeEnvironment.setQualifiers("en-rUS-w412dp-h780dp")
            compose.activityRule.scenario.recreate()
            awaitText("Full code")
            query.assertDoesNotExist()
            assertEquals(offset, axis().value(), 1f)

            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            awaitText("Showing 12 / 18 lines")
            query.assertDoesNotExist()
            compose.runOnIdle { compose.activity.onBackPressedDispatcher.onBackPressed() }
            query.assertTextContains("release")
        } finally {
            RuntimeEnvironment.setQualifiers(originalQualifiers)
        }
    }

    @Test
    @Config(qualifiers = "en-rUS-w412dp-h780dp")
    fun openSourceReceivesMoreChunksAndFollowsOnlyThePreviousUnselectedEnd() {
        startChat(listOf(input()))
        val realtime = app.realtimeService as TestRealtimeService
        awaitText("Show the release code.")
        try {
            compose.waitUntil(10_000) { realtime.target.value?.runId == HISTORY_RUN }
        } catch (error: ComposeTimeoutException) {
            val diagnosis = compose.runOnIdle {
                val history = ready.chats.history
                val snapshot = history.uiState.value
                "history=${snapshot.phase}, liveRuns=${snapshot.transcript?.liveRunIds}, " +
                    "visiting=${history.readSessionFor(CHAT_PERSONAL) != null}, " +
                    "target=${history.output.target.value}, connectionCount=${realtime.opened.get()}"
            }
            throw AssertionError(diagnosis, error)
        }
        val subscription = realtime.target.value
        val at = Instant.now().toString()
        fun emit(index: Long, chunk: String) {
            realtime.output(
                RunOutputSignal.Delta(
                    SessionOutputDelta(
                        CHAT_PERSONAL,
                        HISTORY_RUN,
                        ReplyId,
                        "reply-code",
                        at,
                        index,
                        chunk,
                    ),
                ),
            )
        }
        val lines = (1..12).joinToString("\n", postfix = "\n") { "val item$it = $it" }
        emit(0, "```kt\n$lines")
        awaitText("val item12 = 12", partial = true)
        compose.onNodeWithText("View full code").assertDoesNotExist()
        emit(1, "val item13 = 13\n")
        awaitText("Showing 12 / 13 lines")
        compose.onNodeWithText("View full code").performClick()
        awaitText("Full code")
        assertEquals(subscription, realtime.target.value)

        val continuation = (14..79).joinToString("\n", postfix = "\n") { "val item$it = $it" }
        emit(2, continuation)
        awaitText("val item79 = 79", partial = true)
        val scrolling =
            compose.onNode(
                SemanticsMatcher.keyIsDefined(SemanticsProperties.VerticalScrollAxisRange) and
                    hasAnyAncestor(hasTestTag("conversation_full_code")),
            )
        fun axis() =
            scrolling.fetchSemanticsNode().config[SemanticsProperties.VerticalScrollAxisRange]
        compose.waitUntil(10_000) { axis().maxValue() > 0f && axis().value() == axis().maxValue() }
        val document = compose.onNodeWithTag("conversation_code_source")
        val length = document.fetchSemanticsNode().config[SemanticsProperties.EditableText].length
        val selection = TextRange(length - 7, length - 1)
        document.performSemanticsAction(SemanticsActions.SetSelection) {
            assertTrue(it(selection.start, selection.end, false))
        }
        val selectedOffset = axis().value()
        emit(3, "val item80 = 80\n")
        awaitText("val item80 = 80", partial = true)
        assertEquals(
            selection,
            document.fetchSemanticsNode().config[SemanticsProperties.TextSelectionRange],
        )
        assertEquals(selectedOffset, axis().value(), 1f)
        document.performSemanticsAction(SemanticsActions.SetSelection) {
            assertTrue(it(selection.start, selection.start, false))
        }
        scrolling.performSemanticsAction(SemanticsActions.ScrollBy) { it(0f, -400f) }
        compose.waitUntil(10_000) { axis().value() < axis().maxValue() }
        compose.waitForIdle()
        val offset = axis().value()
        emit(4, "val item81 = 81")
        awaitText("val item81 = 81", partial = true)
        compose.waitForIdle()
        assertEquals(offset, axis().value(), 1f)
        compose.onNodeWithContentDescription("Back").performClick()
        awaitText("Showing 12 / 81 lines")
    }

    private fun input() =
        historyEventWire(
            "51385000-0000-4000-8000-000000000001",
            1,
            type = "input.prompt",
            payload =
                """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Show the release code."}]}}""",
            createdAt = Instant.now().toString(),
        )

    private fun settled(markdown: String) =
        listOf(
            input(),
            historyEventWire(ReplyId, 2, payload = """{"content":${JsonPrimitive(markdown)}}"""),
            historyEventWire(
                "51385000-0000-4000-8000-000000000003",
                3,
                type = "run.completed",
                payload = "null",
            ),
        )

    private fun startChat(events: List<String>) {
        app.fixture.setHistoryEvents(CHAT_PERSONAL, events)
        app.responseGate.countDown()
        awaitText("Personal chat")
        compose.onNodeWithText("Personal chat").performClick()
    }

    private fun assertClipboard(expected: String) {
        val actual = compose.runOnIdle {
            compose.activity
                .getSystemService(ClipboardManager::class.java)
                .primaryClip
                ?.getItemAt(0)
                ?.text
                ?.toString()
        }
        assertEquals(expected, actual)
    }

    private companion object {
        const val ReplyId = "51385000-0000-4000-8000-000000000002"
    }
}
