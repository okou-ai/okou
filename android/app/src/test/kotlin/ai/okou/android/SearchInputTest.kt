package ai.okou.android

import ai.okou.android.artifacts.ArtifactCatalogModel
import ai.okou.android.artifacts.ArtifactsRoute
import ai.okou.android.chat.ConversationFind
import ai.okou.android.chat.ConversationFindVisit
import ai.okou.android.chat.HistoryCheckpoint
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.projectHistory
import android.os.Looper
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.activity.ComponentActivity
import androidx.compose.ui.platform.InterceptPlatformTextInput
import androidx.compose.ui.platform.PlatformTextInputInterceptor
import androidx.compose.ui.test.assertHeightIsEqualTo
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertTextContains
import androidx.compose.ui.test.assertTouchHeightIsEqualTo
import androidx.compose.ui.test.assertTouchWidthIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.awaitCancellation
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS-w400dp-h800dp", application = TestOkouApplication::class)
class SearchInputTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun findBrowsesAttachmentOnlyTurnsAndOpensOneResultPerMatchingMessage() {
        val first = "77777777-7777-4777-8777-777777777771"
        val second = "77777777-7777-4777-8777-777777777772"
        fun prompt(id: String, sequence: Long, parts: String) =
            HistoryEvent.decode(
                historyEventWire(
                    id = id,
                    seq = sequence,
                    type = "input.prompt",
                    payload = """{"userMessage":{"version":1,"parts":[$parts]}}""",
                ),
            )
        val file =
            """{"type":"file","fileId":"42","filenameSnapshot":"Launch Checklist.txt","contentType":"text/plain"}"""
        val otherFile =
            """{"type":"file","fileId":"43","filenameSnapshot":"Launch Review.txt","contentType":"text/plain"}"""
        val rows =
            listOf(
                prompt(first, 36, "$file,$otherFile"),
                prompt(second, 37, """{"type":"text","text":"Review the draft"},$file"""),
            )
        val latest = rows.last()
        val visit =
            ConversationFindVisit(
                projectHistory(
                    HistoryCheckpoint(
                        latest.threadId,
                        rows,
                        HistoryCursor(latest.id, latest.seqId),
                    ),
                ),
                rows,
                artifactCards = false,
                restoreActionsFocus = false,
            )
        compose.setContent { OkouTheme(false) { ConversationFind(visit) {} } }
        compose.waitUntilExactlyOneExists(hasText("Browse turns"), 5_000)
        compose.onNodeWithText("Only searches loaded messages").assertIsDisplayed()
        compose.onNodeWithText("Attachment").assertIsDisplayed()
        compose.onNodeWithText("Review the draft").assertIsDisplayed()

        val query = compose.onNodeWithTag("conversation_find_query")
        query.performTextReplacement("draft Launch")
        compose.waitUntilExactlyOneExists(hasText("No matching messages"), 5_000)
        compose.onNodeWithText("Only searches loaded messages").assertIsDisplayed()
        query.performTextReplacement("  LAUNCH  ")
        compose.waitUntilExactlyOneExists(hasText("2 matching messages"), 5_000)
        val matches = compose.onAllNodes(hasText("Launch Checklist.txt"))
        matches[1].performClick()
        compose.runOnIdle { assertEquals(first, visit.target?.id) }
    }

    @Test
    fun findKeepsTheTurnListUntilImeCommitAndRestoresFocusOnClear() {
        val prompt =
            HistoryEvent.decode(
                historyEventWire(
                    id = "77777777-7777-4777-8777-777777777777",
                    seq = 36,
                    type = "input.prompt",
                    payload =
                        """{"userMessage":{"version":1,"parts":[{"type":"text","text":"Hello"}]}}""",
                ),
            )
        val reply = HistoryEvent.decode(historyEventWire())
        val rows = listOf(prompt, reply)
        val transcript =
            projectHistory(
                HistoryCheckpoint(reply.threadId, rows, HistoryCursor(reply.id, reply.seqId)),
            )
        val visit =
            ConversationFindVisit(
                transcript,
                rows,
                artifactCards = false,
                restoreActionsFocus = false,
            )
        val ime = SearchTestIme()
        compose.setContent {
            OkouTheme(false) {
                InterceptPlatformTextInput(ime.interceptor) { ConversationFind(visit) {} }
            }
        }
        val query = compose.onNodeWithTag("conversation_find_query").assertIsFocused()
        fun awaitTurns() = compose.waitUntilExactlyOneExists(hasText("Browse turns"), 5_000)
        awaitTurns()
        compose.waitUntil(5_000) { ime.connection != null }
        val connection = checkNotNull(ime.connection)
        compose.runOnIdle { assertTrue(connection.setComposingText("Native", 1)) }
        query.assertTextContains("Native").assertIsFocused()
        compose.onNodeWithText("Browse turns").assertIsDisplayed()

        compose.runOnIdle { assertTrue(connection.commitText("Native history", 1)) }
        compose.waitUntilExactlyOneExists(hasText("1 matching message"), 5_000)
        compose.onNodeWithText("Native history reply").assertIsDisplayed()
        compose
            .onNodeWithContentDescription("Clear search")
            .assertWidthIsEqualTo(40.dp)
            .assertHeightIsEqualTo(40.dp)
            .assertTouchWidthIsEqualTo(48.dp)
            .assertTouchHeightIsEqualTo(48.dp)
            .performClick()
        query.assertIsFocused()
        awaitTurns()
    }

    @Test
    fun artifactsShowCommittedResultsWhileTheImeOffersSuggestionsForTheSameText() {
        ChatListApiFixture().use { api ->
            val fixture = ArtifactApiFixture(api)
            val committed = "Product launch"
            val searchStarted = CountDownLatch(1)
            val finishSearch = CountDownLatch(1)
            fixture.beforeCatalog = { request ->
                if (request.requestUrl?.queryParameter("keyword") == committed) {
                    searchStarted.countDown()
                    finishSearch.await()
                }
            }
            fixture.install()
            val store = ViewModelStore()
            try {
                val model = compose.runOnIdle {
                    ViewModelProvider.create(
                            store,
                            viewModelFactory {
                                initializer {
                                    ArtifactCatalogModel(api.service.artifacts) {
                                        throw AssertionError(it)
                                    }
                                }
                            },
                        )[ArtifactCatalogModel::class]
                }
                val ime = SearchTestIme()
                compose.setContent {
                    OkouTheme(false) {
                        InterceptPlatformTextInput(ime.interceptor) {
                            ArtifactsRoute(
                                model,
                                emptyList(),
                                listWidth = null,
                                onClose = {},
                                onSource = {},
                            )
                        }
                    }
                }

                val files = compose.onNodeWithText("Files")
                files.performClick()
                compose.waitUntilExactlyOneExists(hasText(fixture.checklist.title), 5_000)
                val query = compose.onNodeWithTag("artifact_query")
                query.performTouchInput { click() }.assertIsFocused()
                compose.waitUntil(5_000) { ime.connection != null }
                compose.runOnIdle {
                    assertTrue(checkNotNull(ime.connection).setComposingText("Product", 1))
                }
                query.assertTextContains("Product").assertIsFocused()
                compose.onNodeWithText(fixture.checklist.title).assertIsDisplayed()
                assertTrue(model.state.value.query.keyword.isEmpty())

                compose.runOnIdle {
                    assertTrue(checkNotNull(ime.connection).setComposingText(committed, 1))
                }
                query.assertTextContains(committed).assertIsFocused()
                compose.runOnIdle { assertTrue(checkNotNull(ime.connection).finishComposingText()) }
                compose.waitUntil(5_000) { model.state.value.query.keyword == committed }
                compose.waitForIdle()
                shadowOf(Looper.getMainLooper()).idleFor(250, TimeUnit.MILLISECONDS)
                compose.waitUntil(5_000) { searchStarted.count == 0L }
                compose.runOnIdle {
                    assertTrue(checkNotNull(ime.connection).setComposingRegion(0, committed.length))
                }
                finishSearch.countDown()
                compose.waitUntilExactlyOneExists(hasText(fixture.summary.title), 5_000)
                compose.onNodeWithText(fixture.checklist.title).assertDoesNotExist()
                assertTrue(fixture.catalogQueries.contains("file" to committed))
                assertTrue(fixture.catalogQueries.none { it.second == "Product" })

                compose.onNodeWithContentDescription("Clear search").performClick()
                compose.waitUntilExactlyOneExists(hasText(fixture.checklist.title), 5_000)
                query.assertIsFocused()
                files.assertIsSelected()
            } finally {
                finishSearch.countDown()
                compose.runOnIdle { store.clear() }
            }
        }
    }
}

private class SearchTestIme {
    @Volatile
    var connection: InputConnection? = null
        private set

    val interceptor = PlatformTextInputInterceptor { request, _ ->
        connection = request.createInputConnection(EditorInfo())
        try {
            awaitCancellation()
        } finally {
            connection = null
        }
    }
}
