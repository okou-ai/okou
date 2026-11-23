plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.room) apply false
    alias(libs.plugins.spotless)
}

spotless {
    val ktfmtVersion = libs.ktfmt.get().versionConstraint.requiredVersion
    kotlin {
        target("**/src/**/*.kt")
        ktfmt(ktfmtVersion).kotlinlangStyle()
    }
    kotlinGradle {
        target("*.gradle.kts", "**/build.gradle.kts")
        ktfmt(ktfmtVersion).kotlinlangStyle()
    }
}
