package ai.okou.android

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AgentsItem
import ai.okou.android.api.generated.AgentsItemVisibility
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.chat.CachedChatNavigation
import ai.okou.android.chat.ChatCheckpoint
import ai.okou.android.chat.ChatCursor
import ai.okou.android.chat.chatScopeHash
import ai.okou.android.chat.cursor
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
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
    val listResponse = CompletableDeferred<Unit>()
    var preferencesResponse = CompletableDeferred<Unit>()

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
                    return super.chatEvents(since)
                }
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
@Config(sdk = [35], qualifiers = "en-rUS", application = PendingWorkspaceApplication::class)
class PendingWorkspaceRootTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val app
        get() = compose.activity.application as PendingWorkspaceApplication

    @After
    fun close() {
        val application = app
        compose.runOnIdle {
            application.organizationResponse.complete(Unit)
            application.preferencesResponse.complete(Unit)
            application.listResponse.complete(Unit)
        }
        compose.activityRule.scenario.close()
        runBlocking { application.chatCache.close() }
    }

    @Test
    fun listOpensBeforeAccessAndShowsCachedRowsWhilePreferencesAndLiveChatsWait() {
        compose.onNodeWithTag("chat_list").assertExists()
        compose.onNodeWithText("Loading chats…").assertExists()
        compose.onNodeWithText(CACHED_CHAT).assertDoesNotExist()
        compose.onNodeWithContentDescription("Search").assertDoesNotExist()
        compose.runOnIdle { app.organizationResponse.complete(Unit) }
        awaitCachedRow()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").assertIsNotEnabled()
        compose.onNodeWithText("New chat").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Search").assertDoesNotExist()

        compose.activityRule.scenario.recreate()
        awaitCachedRow()
        compose.runOnIdle { app.preferencesResponse.complete(Unit) }
        compose.onNodeWithContentDescription("Settings").assertExists()
        compose.onNodeWithTag("chat_$CHAT_PERSONAL").assertIsEnabled()
        compose.onNodeWithContentDescription("Search").performClick()
        compose.onNodeWithTag("chat_search_results").assertExists()
        compose.onNodeWithText(CACHED_CHAT).assertExists()
    }

    @Test
    fun preferenceFailureAndRetryKeepTheAuthorizedCachedRows() {
        compose.runOnIdle { app.organizationResponse.complete(Unit) }
        awaitCachedRow()
        compose.runOnIdle {
            app.preferencesResponse.completeExceptionally(ApiFailure.Http(503, null, null, null))
        }
        val list = compose.onNodeWithTag("chat_list")
        list.performScrollToNode(hasText("Try again"))
        compose.runOnIdle {
            app.organizationResponse = CompletableDeferred()
            app.preferencesResponse = CompletableDeferred()
        }
        compose.onNodeWithText("Try again").performClick()
        list.performScrollToNode(hasText(CACHED_CHAT))
        compose.onNodeWithText(CACHED_CHAT).assertExists()
        compose.onNodeWithText("New chat").assertIsNotEnabled()
        compose.runOnIdle { app.preferencesResponse.complete(Unit) }
        compose.onNodeWithContentDescription("Settings").assertExists()
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
