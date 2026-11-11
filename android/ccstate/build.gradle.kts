plugins { alias(libs.plugins.kotlin.jvm) }

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

tasks.withType<JavaCompile>().configureEach {
    sourceCompatibility = "17"
    targetCompatibility = "17"
}

dependencies {
    testImplementation(libs.junit)
    testImplementation(libs.coroutines.test)
}

tasks.test {
    maxHeapSize = "512m"
    maxParallelForks = 1
}

tasks.processResources { from("THIRD_PARTY_NOTICES.md") { into("META-INF") } }
