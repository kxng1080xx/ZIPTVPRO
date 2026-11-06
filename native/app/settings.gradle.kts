pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "ziptv"
// Both apps compile the same UI + core bindings from shared/kotlin (see each build file).
include(":androidApp", ":desktopApp")
