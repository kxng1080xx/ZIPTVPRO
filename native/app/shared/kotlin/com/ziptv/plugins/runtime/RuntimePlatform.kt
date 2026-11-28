package com.ziptv.plugins.runtime

import com.dokar.quickjs.QuickJs
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/** Plugins run here (Nuvio: Dispatchers.Default on desktop, a low-priority pool on Android). */
internal val pluginDispatcher: CoroutineDispatcher = Dispatchers.Default

/** PluginRuntime already wraps every run in withTimeout(PLUGIN_TIMEOUT_MS). */
internal fun QuickJs.configurePluginRuntime() = Unit
