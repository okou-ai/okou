package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_AUTHORIZATION_URL
import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.CONNECTOR_GMAIL_ACCOUNT
import ai.okou.android.CONNECTOR_OAUTH_ATTEMPT
import ai.okou.android.CONNECTOR_SLACK_ACCOUNT
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.api.ApiFailure
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectorServiceTest {
    @Test
    fun recommendationsAndCategoryBrowsesUseTheCanonicalDirectory() = runBlocking {
        ConnectorApiFixture().use { fixture ->
            val service = fixture.service
            val initial = service.discover(null, null)
            assertEquals(
                listOf(CONNECTOR_CALENDAR, "gmail", "slack"),
                recommendedConnectors(initial.entries).map { it.slug },
            )
            assertTrue("docs-files-knowledge" in initial.categories)
            assertEquals("google-drive", service.discover("Drive", null).entries.single().slug)
            assertEquals(
                listOf("google-drive"),
                service.discover(null, "docs-files-knowledge").entries.map { it.slug },
            )
            val inspection = service.inspect(service.connected())
            assertEquals(ConnectorAccountStatus.Reauthorize, inspection[CONNECTOR_SLACK_ACCOUNT])
        }
    }

    @Test
    fun accountWritesKeepTheExactConnectorAndDoNotChangeOtherAccounts() = runBlocking {
        ConnectorApiFixture().use { fixture ->
            val service = fixture.service
            val before = service.accounts(CONNECTOR_CALENDAR)
            assertEquals(
                ConnectorAccountStatus.UpdatePermissions,
                before.first { it.id == CONNECTOR_CALENDAR_SECONDARY }.status,
            )
            assertTrue(before.first { it.id == CONNECTOR_CALENDAR_PRIMARY }.defaultEnabled == true)
            assertFalse(
                service.setDefaultEnabled(CONNECTOR_CALENDAR, CONNECTOR_CALENDAR_PRIMARY, false)
            )
            assertEquals(
                "Renamed",
                service.rename(CONNECTOR_CALENDAR, CONNECTOR_CALENDAR_PRIMARY, "Renamed"),
            )
            val after = service.accounts(CONNECTOR_CALENDAR)
            assertEquals("Renamed", after.first { it.id == CONNECTOR_CALENDAR_PRIMARY }.displayName)
            assertEquals(before[1], after[1])
            assertEquals(2L, service.impact(CONNECTOR_CALENDAR, CONNECTOR_CALENDAR_PRIMARY))
            service.disconnect(CONNECTOR_CALENDAR, CONNECTOR_CALENDAR_PRIMARY)
            assertEquals(
                listOf(CONNECTOR_CALENDAR_SECONDARY),
                service.accounts(CONNECTOR_CALENDAR).map { it.id },
            )
            assertTrue("slack" in service.connected())
        }
    }

    @Test
    fun oauthReceiptIsBoundToTheAttemptAndConnector() = runBlocking {
        ConnectorApiFixture().use { fixture ->
            val service = fixture.service
            val method = service.detail("gmail").methods.single()
            val pending =
                service.start(ConnectorAccountTarget("gmail", null), method, emptyMap())
                    as ConnectorAuthorization.Browser
            assertEquals(CONNECTOR_AUTHORIZATION_URL, pending.url.toString())
            assertEquals(CONNECTOR_OAUTH_ATTEMPT, pending.attemptId)
            assertNull(service.oauthCompletion("gmail", pending.attemptId))
            fixture.authorizeGmail()
            assertNull(service.oauthCompletion(CONNECTOR_CALENDAR, pending.attemptId))
            val result = service.oauthCompletion("gmail", pending.attemptId)
            assertEquals(CONNECTOR_GMAIL_ACCOUNT, result)
            assertTrue(service.accountIsConnected("gmail", requireNotNull(result)))
        }
    }

    @Test
    fun externalLaunchAcceptsOnlyHttpsWithoutUserInfo() {
        listOf("myapp://secret", "http://provider.example/path", "https://user@provider.example")
            .forEach {
                assertThrows(ApiFailure.IncompatibleResponse::class.java) { authorizationUrl(it) }
            }
    }
}
