plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "ai.okou.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "ai.okou.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    buildTypes { debug { applicationIdSuffix = ".debug" } }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    sourceSets["main"].res.srcDir(layout.buildDirectory.dir("generated/brand/res"))
    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/brand/assets"))
    testOptions { unitTests.isIncludeAndroidResources = true }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

val generateBrandFonts by
    tasks.registering(Sync::class) {
        from("../../ios/Okou/Resources/Fonts/Geist.ttf") { rename { "geist.ttf" } }
        into(layout.buildDirectory.dir("generated/brand/res/font"))
    }

tasks.named("preBuild") { dependsOn(generateBrandFonts) }

val generateLicenseAssets by
    tasks.registering(Sync::class) {
        from("../../ios/Okou/Resources/Fonts") { include("*-LICENSE.txt") }
        into(layout.buildDirectory.dir("generated/brand/assets/licenses"))
    }

tasks.named("preBuild") { dependsOn(generateLicenseAssets) }

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.material3)
    implementation(libs.compose.foundation)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.coroutines.android)
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
    testImplementation(libs.robolectric)
    testImplementation(libs.compose.ui.test)
    testImplementation(libs.lifecycle.runtime.testing)
    debugImplementation(libs.compose.ui.test.manifest)
}
