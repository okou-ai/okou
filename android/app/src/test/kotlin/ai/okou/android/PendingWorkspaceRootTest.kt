package ai.okou.android

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AgentsItem
import ai.okou.android.api.generated.AgentsItemVisibility
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.HistorySnapshot
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.ReadState
import ai.okou.android.api.generated.ThreadDetail
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.CachedChatNavigation
import ai.okou.android.chat.ChatCheckpoint
import ai.okou.android.chat.ChatCursor
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.HistoryPage
import ai.okou.android.chat.chatScopeHash
import ai.okou.android.chat.cursor
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** External responses are controllable, with the real Activity and disk cache. */
class PendingWorkspaceApplication : TestOkouApplication() {
    var organizationResponse = CompletableDeferred<Unit>()
    @Volatile var listResponse = CompletableDeferred<Unit>()
    var preferencesResponse = CompletableDeferred<Unit>()
    @Volatile private var editTail = ChatEvents(emptyList(), false)

    override fun onCreate() {
        val agents =
            listOf(
                AgentsItem(
                    CHAT_AGENT,
                    true,
                    "user-a",
                    null,
                    "My Okou",
                    null,
                    null,
                    AgentsItemVisibility.PRIVATE,
                )
            )
        chatService =
            object : TestChatService() {
                override suspend fun agents() = agents

                override suspend fun chatEvents(since: Long?): ChatEvents {
                    listResponse.await()
                    return editTail
                }

                override suspend fun setPinned(
                    threadId: String,
                    pinOrder: String?,
                    eventId: String,
                ) =
                    recordEdit(
                        chatEventWire(
                            id = eventId,
                            seq = 18,
                            thread = threadId,
                            kind = "pinned",
                            extra = ",\"pinOrder\":\"$pinOrder\"",
                        )
                    )

                override suspend fun setMuted(threadId: String, muted: Boolean, eventId: String) =
                    recordEdit(
                        chatEventWire(
                            id = eventId,
                            seq = 18,
                            thread = threadId,
                            kind = "sort_touched",
                            extra = ",\"muted\":$muted",
                        )
                    )

                override suspend fun threadDetail(threadId: String) = ThreadDetail(null, false)

                override suspend fun historySnapshot(threadId: String): HistorySnapshot =
                    throw ApiFailure.Http(404, "CHAT_EVENT_SNAPSHOT_NOT_FOUND", null, null)

                override suspend fun historyRows(threadId: String, cursor: HistoryCursor) =
                    if (cursor.seqId == 0L) {
                        HistoryPage(
                            listOf(HistoryEvent.decode(historyEventWire(thread = threadId))),
                            HistoryCursor(HISTORY_LAST_EVENT, 37),
                            false,
                        )
                    } else HistoryPage(emptyList(), cursor, false)

                override suspend fun markRead(threadId: String) = ReadState(CHAT_DATE)
            }
        val events =
            Json.decodeFromString<ChatEvents>(
                """{"events":[${chatEventWire(title = CACHED_CHAT)}],"hasMore":false}"""
            )
        val identity =
            WorkspaceIdentity(
                BuildConfig.API_ORIGIN,
                "user-a",
                "session-a",
                "org-a",
                chatScopeHash(listOf("org:member")),
            )
        runBlocking {
            chatCache
                .open(identity) { true }
                .use { cache ->
                    cache.save(
                        ChatCheckpoint(
                            ChatArchive(emptyList()),
                            ChatCursor(),
                            events.events,
                            events.events.single().cursor(),
                        ),
                        System.currentTimeMillis(),
                        CachedChatNavigation(agents),
                    )
                }
        }
        super.onCreate()
    }

    private fun recordEdit(event: String) {
        editTail = Json.decodeFromString("""{"events":[$event],"hasMore":false}""")
    }

    override fun createWorkspaceSession(
        identity: WorkspaceIdentity,
        tokens: WorkspaceTokenProvider,
    ): WorkspaceSession {
        val service = super.createWorkspaceSession(identity, tokens)
        return object : WorkspaceSession by service {
            override suspend fun organization(): Organization {
                organizationResponse.await()
                return service.organization()
            }

            override suspend fun preferences(): UserPreferences {
                preferencesResponse.await()
                return service.preferences()
            }
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(
    sdk = [35],
    qualifiers = "en-rUS-w400dp-h800dp",
    application = PendingWorkspaceApplication::class,
)
class PendingWorkspaceRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as PendingWorkspaceApplication

    @After
    fun close() {
        val application = app
        try {
            compose.activityRule.scenario.close()
        } finally {
            application.organizationResponse.complete(Unit)
            application.preferencesResponse.complete(Unit)
            application.listResponse.complete(Unit)
            runBlocking { application.chatCache.close() }
        }
    }

    @Test
    fun authorizedCacheOpensChatAndSearchWhilePreferencesAndLiveChatsWait() {
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithText("Loading chats…").assertExists()
        compose.onNodeWithText(CACHED_CHAT).assertDoesNotExist()
        compose.onNodeWithContentDescription("Search").assertDoesNotExist()
        compose.runOnIdle { app.organizationResponse.complete(Unit) }
        awaitCachedRow()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").assertIsEnabled().performClick()
        compose.waitUntil(10_000) {
            compose
                .onAllNodesWithText("Native history", substring = true)
                .fetchSemanticsNodes()
                .isNotEmpty()
        }
        compose.onNodeWithTag("message_input").assertDoesNotExist()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("New chat").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Settings").assertDoesNotExist()
        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNodeWithTag("chat_search_query").performTextReplacement("startup")
        compose.onNodeWithText(CACHED_CHAT).performClick()
        compose.onNodeWithTag("conversation").assertExists()

        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithTag("message_input").assertDoesNotExist()
        compose.runOnIdle { app.preferencesResponse.complete(Unit) }
        compose.onNodeWithTag("message_input").assertExists()
        compose.onNodeWithText("Send").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("chat_search_query").assert(hasText("startup"))
        compose.onNodeWithText(CACHED_CHAT).assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Settings").assertExists()
        compose.onNodeWithText("New chat").assertIsEnabled()
    }

    @Test
    fun preferenceFailureAndRetryKeepTheAuthorizedCachedRowsActionable() {
        compose.runOnIdle { app.organizationResponse.complete(Unit) }
        awaitCachedRow()
        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNodeWithText(CACHED_CHAT).assertExists()
        compose.runOnIdle {
            app.preferencesResponse.completeExceptionally(ApiFailure.Http(503, null, null, null))
        }
        val retry = compose.onNodeWithText("Try again")
        retry.assertIsDisplayed()
        compose.onNodeWithText(CACHED_CHAT).assertExists()
        compose.onNodeWithContentDescription("Back").performClick()

        val list = compose.onNodeWithTag("chat_list")
        list.performScrollToNode(hasText("Try again"))
        list.performScrollToNode(hasText(CACHED_CHAT))
        val row = compose.onNodeWithTag("chat_$CHAT_PERSONAL")
        row.assertIsEnabled().performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Mute chat").performClick()
        row.assert(
            SemanticsMatcher.expectValue(
                SemanticsProperties.StateDescription,
                "Muted, Updating chat…",
            )
        )
        compose.onNodeWithContentDescription("Settings").assertDoesNotExist()
        compose.onNodeWithText("New chat").assertIsNotEnabled()
        row.performClick()
        compose.onNodeWithTag("conversation").assertExists()
        retry.assertIsDisplayed()
        compose.runOnIdle {
            app.organizationResponse = CompletableDeferred()
            app.preferencesResponse = CompletableDeferred()
        }
        retry.performClick()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithTag("message_input").assertDoesNotExist()
        compose.runOnIdle { app.preferencesResponse.complete(Unit) }
        compose.onNodeWithTag("message_input").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        row.assertExists()
        compose.onNodeWithContentDescription("Settings").assertExists()
    }

    @Test
    fun pinUsesTheSynchronizedListWhileTheNextRefreshWaits() {
        compose.runOnIdle { app.organizationResponse.complete(Unit) }
        awaitCachedRow()
        compose.runOnIdle { app.listResponse.complete(Unit) }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Showing saved chats.").fetchSemanticsNodes().isEmpty()
        }

        compose.runOnIdle { app.listResponse = CompletableDeferred() }
        compose.onRoot().performTouchInput {
            swipe(Offset(centerX, height * 0.6f), Offset(centerX, height * 0.9f))
        }
        compose.onNodeWithText("Refreshing chats…").assertExists()
        val row = hasTestTag("chat_$CHAT_PERSONAL")
        compose.onNode(row).performSemanticsAction(SemanticsActions.OnLongClick)
        compose.onNodeWithText("Pin chat").performClick()

        val pendingPin =
            SemanticsMatcher.expectValue(
                SemanticsProperties.StateDescription,
                "Pinned, Updating chat…",
            )
        compose.waitUntil(10_000) {
            compose.onAllNodes(row.and(pendingPin)).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Refreshing chats…").assertExists()
        compose.runOnIdle { app.listResponse.complete(Unit) }
        val confirmedPin =
            SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Pinned")
        compose.waitUntil(10_000) {
            compose.onAllNodes(row.and(confirmedPin)).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Could not confirm the chat change.").assertDoesNotExist()
    }

    private fun awaitCachedRow() {
        val list = compose.onNodeWithTag("chat_list")
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Showing saved chats.").fetchSemanticsNodes().isNotEmpty()
        }
        list.performScrollToNode(hasText(CACHED_CHAT))
        compose.onNodeWithText(CACHED_CHAT).assertExists()
    }
}

private const val CACHED_CHAT = "Saved startup chat"
