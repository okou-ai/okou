package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_AUTHORIZATION_URL
import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_GMAIL_ACCOUNT
import ai.okou.android.CONNECTOR_SLACK_ACCOUNT
import ai.okou.android.ConnectorApiFixture
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import java.util.concurrent.Executors
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ConnectorModelTest {
    @Test
    fun browserReturnPublishesOnlyTheConfirmedAccount() =
        withModel("gmail") { fixture, model ->
            model.startAuthorization(null, "oauth", emptyMap())
            model.await {
                it.action?.busy == false &&
                    it.action.authorization is ConnectorAuthorization.Browser
            }
            model.openBrowser { url ->
                assertEquals(CONNECTOR_AUTHORIZATION_URL, url.toString())
                true
            }
            model.resume()
            val pending =
                model.await { it.action?.problem == ConnectorProblem.AuthorizationIncomplete }
            assertNull(pending.action?.result)
            assertFalse(pending.accountsFor("gmail").any { it.id == CONNECTOR_GMAIL_ACCOUNT })

            fixture.authorizeGmail()
            model.resume()
            val connected = model.await { it.action?.result == ConnectorResult.Authorized }
            assertEquals(CONNECTOR_GMAIL_ACCOUNT, connected.action?.target?.connectionId)
            assertEquals(
                ConnectorAccountStatus.Connected,
                connected.accountsFor("gmail").single().status,
            )
        }

    @Test
    fun renameWithLostResponseSettlesThroughAccountReadback() =
        withModel(CONNECTOR_CALENDAR) { fixture, model ->
            fixture.loseRenameReply = true
            model.rename(CONNECTOR_CALENDAR_PRIMARY, "Meeting calendar")
            val renamed = model.await { it.action?.result == ConnectorResult.Renamed }
            assertEquals(
                "Meeting calendar",
                renamed
                    .accountsFor(CONNECTOR_CALENDAR)
                    .first { it.id == CONNECTOR_CALENDAR_PRIMARY }
                    .displayName,
            )
            assertEquals(2, renamed.accountsFor(CONNECTOR_CALENDAR).size)
        }

    @Test
    fun disconnectingTheLastAccountKeepsTheSelectedService() =
        withModel("slack") { _, model ->
            model.await { it.connected.data?.containsKey("slack") == true }
            model.prepareDisconnect(CONNECTOR_SLACK_ACCOUNT)
            model.await { it.impact?.read?.data != null }

            model.disconnect(CONNECTOR_SLACK_ACCOUNT)

            val disconnected = model.await { it.action?.result == ConnectorResult.Disconnected }
            assertEquals("slack", disconnected.detail.data?.entry?.slug)
            assertEquals(emptyList<ConnectorSavedAccount>(), disconnected.accountsFor("slack"))
            assertFalse(requireNotNull(disconnected.connected.data).containsKey("slack"))
        }

    private fun withModel(
        slug: String,
        exercise: suspend (ConnectorApiFixture, ConnectorModel) -> Unit,
    ) = runBlocking {
        ConnectorApiFixture().use { fixture ->
            Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { main ->
                Dispatchers.setMain(main)
                try {
                    withContext(main) {
                        val store = ViewModelStore()
                        try {
                            val model =
                                ViewModelProvider.create(
                                        store,
                                        viewModelFactory {
                                            initializer {
                                                ConnectorModel(
                                                    fixture.service,
                                                    emptyFlow(),
                                                    { true },
                                                ) {
                                                    throw AssertionError(
                                                        "Unexpected session failure",
                                                        it,
                                                    )
                                                }
                                            }
                                        },
                                    )[ConnectorModel::class]
                            withTimeout(10.seconds) { model.enabled.first { it } }
                            model.setOpen(true)
                            model.select(slug)
                            model.await { it.detail.data != null && it.accounts.data != null }
                            exercise(fixture, model)
                        } finally {
                            store.clear()
                        }
                    }
                } finally {
                    Dispatchers.resetMain()
                }
            }
        }
    }

    private suspend fun ConnectorModel.await(predicate: (ConnectorUiState) -> Boolean) =
        withTimeout(10.seconds) { uiState.first(predicate) }
}
