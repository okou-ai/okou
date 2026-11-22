package ai.okou.android

import ai.okou.android.api.ApiFailure
import ai.okou.android.api.WorkspaceTokenProvider
import ai.okou.android.api.generated.AndroidUpdates
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.HistorySnapshot
import ai.okou.android.api.generated.Organization
import ai.okou.android.api.generated.ReadState
import ai.okou.android.api.generated.ThreadDetail
import ai.okou.android.api.generated.UserPreferences
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.Authentication
import ai.okou.android.auth.MembershipAccess
import ai.okou.android.auth.OpeningWorkspace
import ai.okou.android.auth.SessionModel
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.WorkspaceSession
import ai.okou.android.auth.scopeHash
import ai.okou.android.chat.ChatCheckpoint
import ai.okou.android.chat.ChatCursor
import ai.okou.android.chat.ChatListSource
import ai.okou.android.chat.ChatReadPhase
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.HistoryPage
import ai.okou.android.chat.cursor
import ai.okou.android.preferences.MemberAppearance
import ai.okou.android.updates.ControlledUpdates
import ai.okou.android.updates.UpdateCheck
import ai.okou.android.updates.updateRelease
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTextReplacement
import androidx.lifecycle.ViewModelProvider
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** External responses are controllable, with the real Activity and disk cache. */
open class PendingWorkspaceApplication : TestOkouApplication() {
    protected open val selectedAccess: MembershipAccess? = null
    protected open val seedChats = true
    val authorizationResponse = CompletableDeferred<Unit>()
    var organizationResponse = CompletableDeferred<Unit>()
    @Volatile var listResponse = CompletableDeferred<Unit>()
    var preferencesResponse = CompletableDeferred<Unit>()
    @Volatile private var editTail = ChatEvents(emptyList(), false)

    override fun createAuthentication(): Authentication {
        val access = selectedAccess ?: return super.createAuthentication()
        return TestAuthentication(testAuthenticationState().copy(membershipAccess = listOf(access)))
            .apply { refreshAction = { authorizationResponse.await() } }
    }

    override fun onCreate() {
        chatService =
            object : TestChatService() {

                override suspend fun chatEvents(since: Long?): ChatEvents {
                    listResponse.await()
                    val tail = editTail
                    return if (since == null) tail
                    else tail.copy(events = tail.events.filter { it.cursor().seqId > since })
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
                "previous-session",
                "org-a",
                if (selectedAccess == null) scopeHash(listOf("org:member"))
                else scopeHash(listOf("org:member", "org:member", "known")),
            )
        runBlocking {
            if (seedChats) {
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
                        )
                    }
            }
            if (selectedAccess != null) {
                memberAppearanceCache.save(
                    identity,
                    MemberAppearance(UserPreferencesTheme.DARK, UserPreferencesColorTheme.DAYDREAM),
                )
            }
        }
        super.onCreate()
    }

    private fun recordEdit(event: String) {
        editTail = Json.decodeFromString("""{"events":[$event],"hasMore":false}""")
    }

    fun renameOnServer(title: String) =
        recordEdit(
            chatEventWire(
                id = "77777777-7777-4777-8777-777777777777",
                seq = 18,
                kind = "renamed",
                title = title,
            )
        )

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

open class FreshWorkspaceAccessApplication : PendingWorkspaceApplication() {
    override val selectedAccess = MembershipAccess("org-a", "org:member", emptyList())
}

class UncachedWorkspaceApplication : FreshWorkspaceAccessApplication() {
    override val seedChats = false
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
            application.authorizationResponse.complete(Unit)
            application.organizationResponse.complete(Unit)
            application.preferencesResponse.complete(Unit)
            application.listResponse.complete(Unit)
            runBlocking { application.chatCache.close() }
        }
    }

    @Test
    @Config(application = FreshWorkspaceAccessApplication::class)
    fun coldStartShowsLocalControlsAndCachedContentBeforeWorkspaceReads() {
        val avatar = compose.onNodeWithContentDescription("Switch workspace", substring = true)
        val filter = compose.onNodeWithContentDescription("Filter")
        val settings = compose.onNodeWithContentDescription("Settings")
        val search = compose.onNodeWithTag("workspace_search_entry")
        avatar.assertIsDisplayed().assertIsNotEnabled()
        filter.assertIsDisplayed().assertIsNotEnabled()
        settings.assertIsDisplayed().assertIsNotEnabled()
        val searchBounds = search.getUnclippedBoundsInRoot()
        val avatarBounds = avatar.getUnclippedBoundsInRoot()
        compose.onNodeWithText(CACHED_CHAT).assertDoesNotExist()

        compose.runOnIdle { app.authorizationResponse.complete(Unit) }
        awaitCachedRow()
        compose.onNodeWithContentDescription("Loading chats…").assertDoesNotExist()
        assertEquals(searchBounds, search.getUnclippedBoundsInRoot())
        assertEquals(avatarBounds, avatar.getUnclippedBoundsInRoot())
        filter.assertIsEnabled().performClick()
        compose.onNodeWithText("Archived").performClick()
        compose.onNodeWithTag("chat_filter_heading").assert(hasText("Archived"))
        filter.performClick()
        compose.onNodeWithText("Inbox").performClick()
        compose.onNodeWithText(CACHED_CHAT).assertIsDisplayed()

        settings.assertIsEnabled().performClick()
        compose.onNodeWithText("Display mode").assertIsNotEnabled()
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText("Dark").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("Daydream").assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText(CACHED_CHAT).assertIsDisplayed()

        compose.runOnIdle {
            app.renameOnServer("Synced startup chat")
            app.listResponse.complete(Unit)
        }
        compose.waitUntil(10_000) { listState()?.source == ChatListSource.Network }
        compose.onNodeWithText("Synced startup chat").assertIsDisplayed()
        compose.onNodeWithText(CACHED_CHAT).assertDoesNotExist()
        settings.performClick()
        compose.runOnIdle { app.organizationResponse.complete(Unit) }
        compose.onNodeWithText("Dark").assertExists()
        compose.runOnIdle { app.preferencesResponse.complete(Unit) }
        compose.onNodeWithText("Display mode").assertIsEnabled()
        compose.onNodeWithText("Follow system").assertExists()
    }

    @Test
    @Config(application = UncachedWorkspaceApplication::class)
    fun cacheMissWaitsForChatsInTheIdentifiedWorkspaceShell() {
        compose.runOnIdle { app.authorizationResponse.complete(Unit) }
        compose.waitUntil(10_000) { listState()?.listPhase == ChatReadPhase.Loading }
        compose.mainClock.advanceTimeBy(120)
        compose.onNodeWithContentDescription("Loading chats…").assertExists()
        val empty = compose.activity.getString(R.string.chat_empty)
        compose.onNodeWithText(empty).assertDoesNotExist()
        compose.onNodeWithContentDescription("Filter").assertIsEnabled()
        compose.onNodeWithContentDescription("Settings").assertIsEnabled()

        compose.runOnIdle { app.listResponse.complete(Unit) }
        compose.waitUntil(10_000) { listState()?.source == ChatListSource.Network }
        compose.waitUntil(10_000) {
            compose.onAllNodesWithText(empty).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("Loading chats…").assertDoesNotExist()
    }

    @Test
    @Config(application = FreshWorkspaceAccessApplication::class)
    fun lateOrganizationDenialRetiresTheVisibleCachedWorkspace() {
        compose.runOnIdle { app.authorizationResponse.complete(Unit) }
        awaitCachedRow()
        compose.runOnIdle {
            app.organizationResponse.completeExceptionally(ApiFailure.Http(403, null, null, null))
        }
        compose
            .onNodeWithText(compose.activity.getString(R.string.auth_access_removed))
            .assertIsDisplayed()
        compose.onNodeWithTag("chat_list").assertDoesNotExist()
        compose.onNodeWithText(CACHED_CHAT).assertDoesNotExist()
        compose.onNodeWithContentDescription("Settings").assertDoesNotExist()
    }

    @Test
    fun authorizedCacheOpensChatAndSearchWhilePreferencesAndLiveChatsWait() {
        compose.onNodeWithTag("chat_list").assertExists()
        compose.mainClock.advanceTimeBy(120)
        compose.onNodeWithContentDescription("Loading chats…").assertExists()
        compose.onNodeWithText(CACHED_CHAT).assertDoesNotExist()
        compose.onNodeWithContentDescription("Search workspace").assertDoesNotExist()
        val toolEntries =
            listOf("Workflows", "Connectors", "Artifacts").map {
                compose.onNodeWithContentDescription(it)
            }
        toolEntries.forEach { it.assertDoesNotExist() }
        val searchEntry = compose.onNodeWithTag("workspace_search_entry")
        val startupBounds = searchEntry.getUnclippedBoundsInRoot()
        compose.runOnIdle { app.organizationResponse.complete(Unit) }
        awaitCachedRow()
        toolEntries.forEach { it.assertIsDisplayed().assertIsNotEnabled() }
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
        compose.onNodeWithContentDescription("Settings").assertIsEnabled()
        compose.onNodeWithContentDescription("Search workspace").performClick()
        compose.onNodeWithTag("chat_search_query").performTextReplacement("startup")
        compose.onNodeWithText(CACHED_CHAT).performClick()
        compose.onNodeWithTag("conversation").assertExists()

        compose.activityRule.scenario.recreate()
        compose.onNodeWithTag("conversation").assertExists()
        compose.onNodeWithTag("message_input").assertDoesNotExist()
        compose.runOnIdle { app.preferencesResponse.complete(Unit) }
        compose.onNodeWithTag("message_input").assertExists()
        compose.onNodeWithContentDescription("Send").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("chat_search_query").assert(hasText("startup"))
        compose.onNodeWithText(CACHED_CHAT).assertExists()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Settings").assertExists()
        compose.onNodeWithText("New chat").assertIsEnabled()
        assertEquals(startupBounds, searchEntry.getUnclippedBoundsInRoot())
    }

    @Test
    fun updateDiscoveredDuringWorkspaceOpeningUsesOnlyTheReadyToolbar() {
        val search = compose.onNodeWithTag("workspace_search_entry")
        val startupBounds = search.getUnclippedBoundsInRoot()
        val release = updateRelease("99.0.0")
        val action = app.getString(R.string.updates_toolbar)
        val update = compose.onNodeWithContentDescription(action)
        val previousService = app.updateService
        try {
            compose.waitUntil(10_000) { app.updates.state.value.check == UpdateCheck.Checked }
            compose.runOnIdle {
                app.updateService =
                    ControlledUpdates().apply { response = AndroidUpdates(null, release) }
                app.updates.check()
            }
            compose.waitUntil(10_000) { app.updates.state.value.canDownload }
            update.assertDoesNotExist()
            assertEquals(startupBounds, search.getUnclippedBoundsInRoot())

            compose.runOnIdle { app.organizationResponse.complete(Unit) }
            awaitCachedRow()
            update.assertDoesNotExist()
            assertEquals(startupBounds, search.getUnclippedBoundsInRoot())

            compose.runOnIdle { app.preferencesResponse.complete(Unit) }
            compose.waitUntil(10_000) {
                compose.onAllNodesWithContentDescription(action).fetchSemanticsNodes().isNotEmpty()
            }
            update.assertIsDisplayed().assertIsEnabled()
            assertEquals(startupBounds, search.getUnclippedBoundsInRoot())
        } finally {
            compose.runOnIdle { app.updateService = previousService }
        }
    }

    @Test
    fun preferenceFailureAndRetryKeepTheAuthorizedCachedRowsActionable() {
        compose.runOnIdle { app.organizationResponse.complete(Unit) }
        awaitCachedRow()
        compose.onNodeWithContentDescription("Search workspace").performClick()
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
        compose.onNodeWithContentDescription("Settings").assertIsEnabled()
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
        compose.waitUntil(10_000) { listState()?.source == ChatListSource.Network }

        compose.runOnIdle { app.listResponse = CompletableDeferred() }
        compose.runOnIdle { app.connectivity.value = false }
        compose.waitUntil(10_000) { listState()?.offline == true }
        compose.runOnIdle { app.connectivity.value = true }
        compose.waitUntil(10_000) { listState()?.listPhase == ChatReadPhase.Loading }
        compose.onNodeWithText("Refreshing chats…").assertDoesNotExist()
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
        compose.onNodeWithText("Refreshing chats…").assertDoesNotExist()
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
        compose.waitUntil(10_000) { listState()?.source == ChatListSource.Cache }
        list.performScrollToNode(hasText(CACHED_CHAT))
        compose.onNodeWithText(CACHED_CHAT).assertExists()
    }

    private fun listState() =
        compose.runOnIdle {
            val session =
                ViewModelProvider(compose.activity)[SessionModel::class.java].uiState.value
            (session.ready?.chats ?: (session.opening as? OpeningWorkspace.Authorized)?.chats)
                ?.uiState
                ?.value
        }
}

private const val CACHED_CHAT = "Saved startup chat"
