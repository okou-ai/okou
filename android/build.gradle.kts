plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.room) apply false
    alias(libs.plugins.spotless)
}

spotless {
    kotlin {
        target("**/src/**/*.kt")
        ktfmt("0.54").kotlinlangStyle()
    }
    kotlinGradle {
        target("*.gradle.kts", "**/build.gradle.kts")
        ktfmt("0.54").kotlinlangStyle()
    }
}
