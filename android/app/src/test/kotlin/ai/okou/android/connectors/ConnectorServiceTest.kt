package ai.okou.android.connectors

import ai.okou.android.CONNECTOR_AUTHORIZATION_URL
import ai.okou.android.CONNECTOR_CALENDAR
import ai.okou.android.CONNECTOR_CALENDAR_PRIMARY
import ai.okou.android.CONNECTOR_CALENDAR_SECONDARY
import ai.okou.android.CONNECTOR_GMAIL_ACCOUNT
import ai.okou.android.CONNECTOR_OAUTH_ATTEMPT
import ai.okou.android.CONNECTOR_SLACK_ACCOUNT
import ai.okou.android.ConnectorApiFixture
import ai.okou.android.FixtureConnectorIcon
import ai.okou.android.api.ApiFailure
import ai.okou.android.api.generated.ConnectorAccountPolicyRequestPolicy
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectorServiceTest {
    @Test
    fun memberPolicyUsesTheSameAccountAcrossSettingsAndComposer() = runBlocking {
        ConnectorApiFixture().use { fixture ->
            val service = fixture.service
            fixture.memberAccess = true
            val saved =
                service.setAccountPolicy(
                    CONNECTOR_CALENDAR,
                    CONNECTOR_CALENDAR_SECONDARY,
                    ConnectorAccountPolicyRequestPolicy.ALLOW_24H,
                )
            assertTrue(saved.enabled)
            assertTrue(saved.expiresAt != null)

            val accounts = service.accounts(CONNECTOR_CALENDAR)
            assertEquals(saved, accounts.first { it.id == CONNECTOR_CALENDAR_SECONDARY }.policy)
            val chatAccounts = service.chatAccounts(null)
            val group = chatAccounts.groups.single { it.entry.slug == CONNECTOR_CALENDAR }
            assertTrue(chatAccounts.memberAccess)
            assertEquals(
                saved,
                group.accounts
                    .first { it.account.id == CONNECTOR_CALENDAR_SECONDARY }
                    .account
                    .policy,
            )
            assertTrue(fixture.chatOverrideRequests.isEmpty())

            fixture.memberAccess = false
            val legacy =
                service.accounts(CONNECTOR_CALENDAR).first { it.id == CONNECTOR_CALENDAR_SECONDARY }
            assertNull(legacy.policy)
            assertEquals(false, legacy.defaultEnabled)
        }
    }

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
    fun discoveryOverviewAndDetailCarryTheCurrentCatalogArtwork() = runBlocking {
        ConnectorApiFixture().use { fixture ->
            val service = fixture.service
            fixture.omittedFromDefaultBrowse = setOf("slack")
            val artwork = FixtureConnectorIcon("slack-v1", invertInDarkMode = true, scale = 2.2)
            fixture.icons = mapOf("slack" to artwork)

            assertFalse(service.discover(null, null).entries.any { it.slug == "slack" })
            val connected = checkNotNull(service.connected().getValue("slack").entry.icon)
            assertEquals("slack-v1.svg", connected.url.pathSegments.last())
            assertTrue(connected.invertInDarkMode)
            assertEquals(2.2f, connected.scale, 0f)
            assertEquals(connected, service.discover("slack", null).entries.single().icon)
            assertEquals(connected, service.detail("slack").entry.icon)

            fixture.icons = mapOf("slack" to artwork.copy(asset = "slack-v2", scale = null))
            val updated = checkNotNull(service.detail("slack").entry.icon)
            assertEquals("slack-v2.svg", updated.url.pathSegments.last())
            assertEquals(1f, updated.scale, 0f)
            assertEquals(updated, service.connected().getValue("slack").entry.icon)
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
                service.setDefaultEnabled(CONNECTOR_CALENDAR, CONNECTOR_CALENDAR_PRIMARY, false),
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
