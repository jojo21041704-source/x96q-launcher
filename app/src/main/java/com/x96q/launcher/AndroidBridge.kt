package com.x96q.launcher

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Pont JavaScript exposé sous `window.AndroidBridge`.
 *
 * Les méthodes @JavascriptInterface s'exécutent sur un thread dédié de la WebView
 * (jamais sur le thread UI) : les appels synchrones ne figent donc pas l'affichage natif.
 */
class AndroidBridge(private val activity: Activity) {

    private val pm: PackageManager = activity.packageManager
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val lock = Any()

    @Volatile private var cachedJson: String? = null

    /** Pré-calcule la liste (et les icônes Base64) en arrière-plan, dès le démarrage. */
    fun warmUp() {
        executor.execute { getInstalledApps() }
    }

    fun invalidateCache() {
        synchronized(lock) { cachedJson = null }
        warmUp()
    }

    fun shutdown() {
        executor.shutdownNow()
    }

    /**
     * Retourne un tableau JSON :
     * [{ "name": "...", "packageName": "...", "icon": "data:image/png;base64,...", "isTv": true }]
     */
    @JavascriptInterface
    fun getInstalledApps(): String {
        cachedJson?.let { return it }
        synchronized(lock) {
            cachedJson?.let { return it }
            val json = try {
                buildAppsJson()
            } catch (t: Throwable) {
                Log.e(TAG, "getInstalledApps failed", t)
                "[]"
            }
            cachedJson = json
            return json
        }
    }

    @JavascriptInterface
    fun launchApp(packageName: String): Boolean {
        val intent = pm.getLeanbackLaunchIntentForPackage(packageName)
            ?: pm.getLaunchIntentForPackage(packageName)
            ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
        return startSafely(intent)
    }

    @JavascriptInterface
    fun openSystemSettings(): Boolean {
        val flags = Intent.FLAG_ACTIVITY_NEW_TASK
        return startSafely(Intent(Settings.ACTION_SETTINGS).addFlags(flags)) ||
            startSafely(Intent(Settings.ACTION_WIRELESS_SETTINGS).addFlags(flags))
    }

    // ------------------------------------------------------------------ internes

    /** Démarre l'activité sur le thread UI ; aucune exception ne peut remonter et faire planter le launcher. */
    private fun startSafely(intent: Intent): Boolean {
        if (intent.resolveActivity(pm) == null) return false
        activity.runOnUiThread {
            try {
                activity.startActivity(intent)
            } catch (e: ActivityNotFoundException) {
                Log.w(TAG, "No activity for $intent", e)
            } catch (e: SecurityException) {
                Log.w(TAG, "Not allowed to start $intent", e)
            }
        }
        return true
    }

    private fun buildAppsJson(): String {
        val self = activity.packageName
        val byPackage = LinkedHashMap<String, Pair<ResolveInfo, Boolean>>()

        // 1) Applications TV (Leanback) en priorité, 2) applications classiques.
        queryLaunchables(Intent.CATEGORY_LEANBACK_LAUNCHER).forEach {
            val pkg = it.activityInfo.packageName
            if (pkg != self) byPackage[pkg] = it to true
        }
        queryLaunchables(Intent.CATEGORY_LAUNCHER).forEach {
            val pkg = it.activityInfo.packageName
            if (pkg != self && !byPackage.containsKey(pkg)) byPackage[pkg] = it to false
        }

        val apps = byPackage.values.map { (info, isTv) ->
            val label = info.loadLabel(pm)?.toString()?.trim().orEmpty()
                .ifEmpty { info.activityInfo.packageName }
            Triple(label, info, isTv)
        }.sortedBy { it.first.lowercase(Locale.getDefault()) }

        val array = JSONArray()
        for ((label, info, isTv) in apps) {
            val obj = JSONObject()
            obj.put("name", label)
            obj.put("packageName", info.activityInfo.packageName)
            obj.put("isTv", isTv)
            obj.put("icon", encodeIcon(info))
            array.put(obj)
        }
        return array.toString()
    }

    private fun queryLaunchables(category: String): List<ResolveInfo> {
        val intent = Intent(Intent.ACTION_MAIN).addCategory(category)
        return try {
            pm.queryIntentActivities(intent, 0)
        } catch (t: Throwable) {
            emptyList()
        }
    }

    /** Icône redimensionnée en 96x96 px, encodée en PNG Base64 (data URI). */
    private fun encodeIcon(info: ResolveInfo): String {
        return try {
            val drawable = info.loadIcon(pm) ?: return ""
            val bitmap = drawableToBitmap(drawable, ICON_SIZE)
            val out = ByteArrayOutputStream(8 * 1024)
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            bitmap.recycle()
            "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } catch (t: Throwable) {
            Log.w(TAG, "Icon failed for ${info.activityInfo.packageName}", t)
            ""
        }
    }

    private fun drawableToBitmap(drawable: Drawable, size: Int): Bitmap {
        if (drawable is BitmapDrawable && drawable.bitmap != null) {
            val src = drawable.bitmap
            if (src.width == size && src.height == size) return src.copy(Bitmap.Config.ARGB_8888, false)
            return Bitmap.createScaledBitmap(src, size, size, true)
        }
        // AdaptiveIconDrawable, VectorDrawable, etc.
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val old = drawable.copyBounds()
        drawable.setBounds(0, 0, size, size)
        drawable.draw(canvas)
        drawable.bounds = old
        return bitmap
    }

    companion object {
        private const val TAG = "X96Q-Bridge"
        private const val ICON_SIZE = 96
    }
}
