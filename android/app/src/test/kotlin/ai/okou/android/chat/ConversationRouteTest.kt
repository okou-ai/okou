package ai.okou.android.chat

import ai.okou.android.CHAT_IN_PROJECT
import ai.okou.android.CHAT_PERSONAL
import ai.okou.android.ChatListApiFixture
import ai.okou.android.OkouTheme
import ai.okou.android.TestOkouApplication
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.v2.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import kotlinx.coroutines.Job
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "en-rUS", application = TestOkouApplication::class)
class ConversationRouteTest {
    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()
    @get:Rule val temporary = TemporaryFolder()
    private val owners = ViewModelStore()
    private val fixture = ChatListApiFixture()
    private var cache: ChatCacheStore? = null
    private var ownerJob: Job? = null

    @After
    fun close() {
        try {
            compose.runOnIdle { owners.clear() }
            compose.waitUntil(10_000) { compose.runOnIdle { ownerJob?.isCompleted != false } }
        } finally {
            try {
                runBlocking { cache?.close() }
            } finally {
                fixture.close()
            }
        }
    }

    @Test
    fun visibleRouteTracksLateBindingAndAReopenedThreadBeforeTheNextFrame() {
        val model =
            compose.runOnIdle {
                val storage = ChatCacheStore(compose.activity.application, temporary.newFolder())
                cache = storage
                ViewModelProvider(
                        owners,
                        viewModelFactory {
                            initializer {
                                ChatListModel(
                                    fixture.service,
                                    storage,
                                    fixture.identity,
                                    { true },
                                    {},
                                )
                            }
                        },
                    )[ChatListModel::class.java]
                    .also {
                        ownerJob = it.viewModelScope.coroutineContext[Job]
                        it.refresh()
                    }
            }
        compose.setContent {
            val list by model.uiState.collectAsStateWithLifecycle()
            OkouTheme { ConversationRoute(model.history, CHAT_IN_PROJECT, list) }
        }
        compose.onNodeWithText("Loading conversation…").assertExists()
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.uiState.value.listPhase == ChatReadPhase.Ready }
        }
        compose.runOnIdle {
            model.history.open(model.uiState.value.threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
        compose
            .onNodeWithTag("conversation")
            .performScrollToNode(hasText("Native history", substring = true))
        compose.onNodeWithText("Native history", substring = true).assertExists()
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.readRequests.get() > 0 } }
        assertEquals(1, fixture.readRequests.get())
        compose.runOnIdle {
            val threads = model.uiState.value.threads
            model.history.open(threads.single { it.id == CHAT_PERSONAL })
            model.history.open(threads.single { it.id == CHAT_IN_PROJECT })
        }
        compose.waitUntil(10_000) {
            compose.runOnIdle { model.history.uiState.value.phase == HistoryPhase.Ready }
        }
        compose.onNodeWithText("Native history", substring = true).assertExists()
        compose.waitUntil(10_000) { compose.runOnIdle { fixture.readRequests.get() >= 2 } }
        assertEquals(2, fixture.readRequests.get())
    }
}
