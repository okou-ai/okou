package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_DATE
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestChatService
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.ReadState
import ai.okou.android.api.generated.ThreadDetail
import ai.okou.android.auth.MembershipAccess
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.scopeHash
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatCheckpoint
import ai.okou.android.chat.ChatCursor
import ai.okou.android.chat.HistoryCheckpoint
import ai.okou.android.chat.HistoryCursor
import ai.okou.android.chat.HistoryEvent
import ai.okou.android.chat.HistoryPage
import ai.okou.android.chat.cursor
import ai.okou.android.chatEventWire
import ai.okou.android.historyEventWire
import ai.okou.android.testAuthenticationState
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun cachedConversationUpdatesWithoutClosing() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalRefresh = auth.refreshAction
        val originalChats = app.chatService
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val authorization = CompletableDeferred<Unit>()
        val historyRequested = CompletableDeferred<Unit>()
        val detailRequested = CompletableDeferred<Unit>()
        val readRequested = CompletableDeferred<Unit>()
        val access = MembershipAccess("org-a", "org:member", emptyList())
        val session = testAuthenticationState(user = "conversation-design-fixture")
        val identity =
            WorkspaceIdentity(
                BuildConfig.API_ORIGIN,
                checkNotNull(session.session).userId,
                "earlier-session",
                access.workspaceId,
                scopeHash(listOf(access.role, access.role, "known")),
            )
        val title = "Review the launch checklist"
        val cachedText = "I found three items to check before launch."
        val syncedText = "The updated launch checklist is ready."
        val threads =
            Json.decodeFromString<ChatEvents>(
                """{"events":[${chatEventWire(title = title)}],"hasMore":false}""",
            )
        val cached =
            HistoryEvent.decode(historyEventWire(payload = """{"content":"$cachedText"}"""))
        val synced =
            HistoryEvent.decode(
                historyEventWire(
                    id = "66666666-6666-4666-8666-666666666666",
                    seq = 38,
                    payload = """{"content":"$syncedText"}""",
                    run = "33333333-3333-4333-8333-333333333333",
                ),
            )
        val cachedCursor = HistoryCursor(cached.id, cached.seqId)
        val syncedCursor = HistoryCursor(synced.id, synced.seqId)
        fun findText(text: String) =
            checkNotNull(
                device.wait(Until.findObject(By.pkg(app.packageName).text(text)), 10_000),
            ) {
                "Expected visible text $text"
            }
        val chatActions = By.pkg(app.packageName).desc(app.getString(R.string.chat_actions))
        try {
            runBlocking {
                app.chatCache
                    .open(identity) { true }
                    .use { lease ->
                        check(
                            lease.save(
                                ChatCheckpoint(
                                    ChatArchive(emptyList()),
                                    ChatCursor(),
                                    threads.events,
                                    threads.events.single().cursor(),
                                ),
                                System.currentTimeMillis(),
                            ),
                        )
                        lease.saveHistory(
                            HistoryCheckpoint(CHAT_PERSONAL, listOf(cached), cachedCursor),
                            System.currentTimeMillis(),
                        )
                    }
            }
            auth.refreshAction = { authorization.await() }
            auth.state.value = session.copy(membershipAccess = listOf(access))
            app.chatService =
                object : TestChatService() {
                    override suspend fun historyRows(
                        threadId: String,
                        cursor: HistoryCursor,
                    ): HistoryPage {
                        historyRequested.complete(Unit)
                        return if (cursor == cachedCursor)
                            HistoryPage(listOf(synced), syncedCursor, false)
                        else HistoryPage(emptyList(), cursor, false)
                    }

                    override suspend fun threadDetail(threadId: String): ThreadDetail {
                        detailRequested.complete(Unit)
                        return ThreadDetail(null, false)
                    }

                    override suspend fun markRead(threadId: String): ReadState {
                        readRequested.complete(Unit)
                        return ReadState(CHAT_DATE)
                    }
                }
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(app)
                findText(title).click()
                findText(cachedText)
                check(!historyRequested.isCompleted)
                check(!detailRequested.isCompleted)
                check(!readRequested.isCompleted)
                check(!device.hasObject(chatActions))
                ScreenshotCapture.capture("conversation-cache.png")

                authorization.complete(Unit)
                findText(syncedText)
                check(device.wait(Until.hasObject(chatActions), 10_000))
                ScreenshotCapture.capture("conversation-synced.png")

                device.pressBack()
                device.awaitChatList(app)
                findText(title)
            }
        } finally {
            authorization.complete(Unit)
            app.chatService = originalChats
            auth.refreshAction = originalRefresh
            auth.state.value = originalAuth
            savedCache.restore()
        }
    }
}
