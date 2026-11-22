package ai.okou.android.screenshots

import ai.okou.android.BuildConfig
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatCacheSnapshot
import ai.okou.android.MainActivity
import ai.okou.android.R
import ai.okou.android.ScreenshotCapture
import ai.okou.android.TestAuthentication
import ai.okou.android.TestChatService
import ai.okou.android.TestOkouApplication
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ChatArchive
import ai.okou.android.api.generated.ChatEvents
import ai.okou.android.api.generated.UserPreferencesColorTheme
import ai.okou.android.api.generated.UserPreferencesTheme
import ai.okou.android.auth.MembershipAccess
import ai.okou.android.auth.WorkspaceIdentity
import ai.okou.android.auth.scopeHash
import ai.okou.android.auth.workspaceStorageKey
import ai.okou.android.awaitChatList
import ai.okou.android.chat.ChatCheckpoint
import ai.okou.android.chat.ChatCursor
import ai.okou.android.chat.cursor
import ai.okou.android.chatEventWire
import ai.okou.android.preferences.MemberAppearance
import ai.okou.android.testAuthenticationState
import android.util.AtomicFile
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.Condition
import androidx.test.uiautomator.Direction
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScreenshotScenario {
    @Test
    fun identifiedShellShowsTheCacheAndUpdatesInPlace() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val app = instrumentation.targetContext.applicationContext as TestOkouApplication
        val device = UiDevice.getInstance(instrumentation)
        val auth = app.authentication as TestAuthentication
        val originalAuth = auth.state.value
        val originalRefresh = auth.refreshAction
        val originalChats = app.chatService
        val originalOrganizationRead = app.beforeOrganizationRead
        val savedCache = ChatCacheSnapshot(app.noBackupFilesDir.resolve("chat-list"), app.chatCache)
        val authorization = CompletableDeferred<Unit>()
        val organization = CompletableDeferred<Unit>()
        val listRequested = CompletableDeferred<Unit>()
        val listResponse = CompletableDeferred<Unit>()
        val access = MembershipAccess("org-a", "org:member", emptyList())
        val session = testAuthenticationState(user = "startup-design-fixture")
        val identity =
            WorkspaceIdentity(
                BuildConfig.API_ORIGIN,
                checkNotNull(session.session).userId,
                "earlier-session",
                access.workspaceId,
                scopeHash(listOf(access.role, access.role, "known")),
            )
        val appearanceFile =
            AtomicFile(
                app.noBackupFilesDir.resolve(
                    "member-appearance/${identity.workspaceStorageKey()}.json"
                )
            )
        val previousAppearance = runBlocking { app.memberAppearanceCache.load(identity) }
        val cachedTitle = "Review the launch checklist"
        val refreshedTitle = "Review the final launch checklist"
        val cache =
            events(
                listOf(
                    chatEventWire(title = cachedTitle),
                    chatEventWire(
                        id = "33333333-3333-4333-8333-333333333333",
                        seq = 18,
                        thread = "88888888-8888-4888-8888-888888888888",
                        title = "Summarize partner feedback",
                    ),
                    chatEventWire(
                        id = "99999999-9999-4999-8999-999999999999",
                        seq = 19,
                        thread = "22222222-2222-4222-8222-222222222222",
                        title = "Prepare the team briefing",
                    ),
                )
            )
        val tail =
            events(
                listOf(
                    chatEventWire(
                        id = "77777777-7777-4777-8777-777777777777",
                        seq = 20,
                        thread = CHAT_PERSONAL,
                        kind = "renamed",
                        title = refreshedTitle,
                    )
                )
            )
        fun find(selector: BySelector) =
            checkNotNull(device.wait(Until.findObject(selector), 10_000)) {
                "Expected visible UI for $selector"
            }
        fun description(label: Int) = By.pkg(app.packageName).desc(app.getString(label))
        fun text(value: String) = By.pkg(app.packageName).text(value)
        fun revealSettingsRow(label: Int) {
            val target = text(app.getString(label))
            if (!device.hasObject(target)) {
                val settings = find(By.pkg(app.packageName).scrollable(true))
                val visible =
                    object : Condition<UiObject2, Boolean> {
                        override fun apply(container: UiObject2) = device.hasObject(target)
                    }
                settings.scrollUntil(Direction.DOWN, visible)
            }
            find(target)
        }
        val skeleton = description(R.string.chat_loading)
        val slots =
            listOf(
                By.pkg(app.packageName)
                    .descStartsWith(app.getString(R.string.auth_switch_workspace)),
                description(R.string.chat_filter),
                description(R.string.settings),
                description(R.string.workspace_workflows),
                description(R.string.workspace_connectors),
                description(R.string.workspace_artifacts),
            )
        try {
            runBlocking {
                app.chatCache
                    .open(identity) { true }
                    .use {
                        check(
                            it.save(
                                ChatCheckpoint(
                                    ChatArchive(emptyList()),
                                    ChatCursor(),
                                    cache.events,
                                    cache.events.last().cursor(),
                                ),
                                System.currentTimeMillis(),
                            )
                        )
                    }
                app.memberAppearanceCache.save(
                    identity,
                    MemberAppearance(UserPreferencesTheme.LIGHT, UserPreferencesColorTheme.DAYDREAM),
                )
            }
            auth.refreshAction = { authorization.await() }
            auth.state.value = session.copy(membershipAccess = listOf(access))
            app.beforeOrganizationRead = { organization.await() }
            app.chatService =
                object : TestChatService() {
                    override suspend fun chatEvents(since: Long?): ChatEvents {
                        listRequested.complete(Unit)
                        listResponse.await()
                        return if (since != null && since >= 20) ChatEvents(emptyList(), false)
                        else tail
                    }
                }
            ActivityScenario.launch(MainActivity::class.java).use {
                device.awaitChatList(app)
                find(skeleton)
                val initialBounds = slots.map { selector -> find(selector).visibleBounds }
                assertFalse(device.hasObject(text(cachedTitle)))
                ScreenshotCapture.capture("startup-loading.png")

                authorization.complete(Unit)
                runBlocking { withTimeout(10_000) { listRequested.await() } }
                find(text(cachedTitle))
                assertFalse(device.hasObject(skeleton))
                assertEquals(initialBounds, slots.map { selector -> find(selector).visibleBounds })
                ScreenshotCapture.capture("startup-cache.png")

                find(description(R.string.settings)).click()
                revealSettingsRow(R.string.palette_daydream)
                organization.completeExceptionally(ApiFailure.Http(503, null, null, null))
                revealSettingsRow(R.string.chat_list_first_load_failed)
                find(text(app.getString(R.string.palette_daydream)))
                assertFalse(device.hasObject(text(app.getString(R.string.retry))))
                ScreenshotCapture.capture("startup-settings.png")

                device.pressBack()
                find(text(cachedTitle))
                listResponse.complete(Unit)
                find(text(refreshedTitle))
                assertTrue(device.wait(Until.gone(text(cachedTitle)), 10_000))
                assertEquals(initialBounds, slots.map { selector -> find(selector).visibleBounds })
                ScreenshotCapture.capture("startup-synced.png")
            }
        } finally {
            authorization.complete(Unit)
            organization.complete(Unit)
            listResponse.complete(Unit)
            app.chatService = originalChats
            app.beforeOrganizationRead = originalOrganizationRead
            auth.refreshAction = originalRefresh
            auth.state.value = originalAuth
            savedCache.restore()
            if (previousAppearance == null) appearanceFile.delete()
            else runBlocking { app.memberAppearanceCache.save(identity, previousAppearance) }
        }
    }

    private fun events(wires: List<String>): ChatEvents =
        Json.decodeFromString("""{"events":[${wires.joinToString(",")}],"hasMore":false}""")
}
