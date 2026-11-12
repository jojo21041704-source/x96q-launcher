package com.x96q.launcher

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ResolveInfo
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Path
import android.graphics.RectF
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Pont exposé sous `window.AndroidBridge`.
 * Les méthodes @JavascriptInterface tournent sur un thread dédié de la WebView, jamais sur le thread UI.
 */
class AndroidBridge(private val activity: Activity) {

    private val pm: PackageManager = activity.packageManager
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val lock = Any()
    private val bannerCache = ConcurrentHashMap<String, String>()

    @Volatile private var cachedJson: String? = null

    fun warmUp() { executor.execute { getInstalledApps() } }

    fun invalidateCache() {
        synchronized(lock) { cachedJson = null }
        bannerCache.clear()
        warmUp()
    }

    fun shutdown() { executor.shutdownNow() }

    /**
     * [{ name, packageName, isTv, category, accentColor: "#RRGGBB", icon: "data:image/png;base64,…" }]
     * Icônes 128×128 ARGB_8888, coins arrondis, adaptatives rendues avec leurs deux calques.
     */
    @JavascriptInterface
    fun getInstalledApps(): String {
        cachedJson?.let { return it }
        synchronized(lock) {
            cachedJson?.let { return it }
            val json = try { buildAppsJson() } catch (t: Throwable) {
                Log.e(TAG, "getInstalledApps failed", t); "[]"
            }
            cachedJson = json
            return json
        }
    }

    /** Bannière Android TV (16:9, 480×270) en data URI, ou "" si l'application n'en a pas. */
    @JavascriptInterface
    fun getAppBanner(packageName: String): String {
        bannerCache[packageName]?.let { return it }
        val result = try {
            var banner: Drawable? = null
            pm.getLeanbackLaunchIntentForPackage(packageName)?.let { intent ->
                banner = pm.resolveActivity(intent, 0)?.activityInfo?.loadBanner(pm)
            }
            if (banner == null) banner = pm.getApplicationBanner(packageName)
            banner?.let { toDataUri(renderBanner(it)) } ?: ""
        } catch (t: Throwable) {
            Log.w(TAG, "Banner failed for $packageName", t); ""
        }
        bannerCache[packageName] = result
        return result
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

    private fun startSafely(intent: Intent): Boolean {
        if (intent.resolveActivity(pm) == null) return false
        activity.runOnUiThread {
            try { activity.startActivity(intent) }
            catch (e: ActivityNotFoundException) { Log.w(TAG, "No activity for $intent", e) }
            catch (e: SecurityException) { Log.w(TAG, "Not allowed to start $intent", e) }
        }
        return true
    }

    private fun buildAppsJson(): String {
        val self = activity.packageName
        val byPackage = LinkedHashMap<String, Pair<ResolveInfo, Boolean>>()

        query(Intent.CATEGORY_LEANBACK_LAUNCHER).forEach {
            val pkg = it.activityInfo.packageName
            if (pkg != self) byPackage[pkg] = it to true
        }
        query(Intent.CATEGORY_LAUNCHER).forEach {
            val pkg = it.activityInfo.packageName
            if (pkg != self && !byPackage.containsKey(pkg)) byPackage[pkg] = it to false
        }

        val apps = byPackage.values.map { (info, isTv) ->
            val label = info.loadLabel(pm)?.toString()?.trim().orEmpty().ifEmpty { info.activityInfo.packageName }
            Triple(label, info, isTv)
        }.sortedBy { it.first.lowercase(Locale.getDefault()) }

        val array = JSONArray()
        for ((label, info, isTv) in apps) {
            val obj = JSONObject()
            obj.put("name", label)
            obj.put("packageName", info.activityInfo.packageName)
            obj.put("isTv", isTv)
            obj.put("category", categoryOf(info.activityInfo.applicationInfo))
            val icon = extractIcon(info)
            obj.put("accentColor", icon?.let { dominantColor(it) } ?: DEFAULT_ACCENT)
            obj.put("icon", icon?.let { toDataUri(it) } ?: "")
            icon?.recycle()
            array.put(obj)
        }
        return array.toString()
    }

    /**
     * Icône native complète, en 128×128 :
     *  1) icône de l'activité lancée (celle qu'affiche le launcher Android),
     *  2) sinon icône de l'application (PackageManager.getApplicationIcon).
     * Une icône entièrement transparente est rejetée pour passer à la source suivante.
     */
    private fun extractIcon(info: ResolveInfo): Bitmap? {
        val pkg = info.activityInfo.packageName
        val sources = listOf<() -> Drawable?>(
            { info.activityInfo.loadIcon(pm) },
            { pm.getApplicationIcon(info.activityInfo.applicationInfo) },
            { pm.getApplicationIcon(pkg) }
        )
        for (source in sources) {
            try {
                val drawable = source() ?: continue
                val bitmap = renderIcon(drawable)
                if (isVisible(bitmap)) return bitmap
                bitmap.recycle()
            } catch (t: Throwable) {
                Log.w(TAG, "Icon source failed for $pkg", t)
            }
        }
        return null
    }

    /** Vrai si au moins quelques pixels sont opaques (échantillonnage d'une grille 16×16). */
    private fun isVisible(bitmap: Bitmap): Boolean {
        val step = bitmap.width / 16
        var opaque = 0
        var y = step / 2
        while (y < bitmap.height) {
            var x = step / 2
            while (x < bitmap.width) {
                if ((bitmap.getPixel(x, y) ushr 24) > 32) opaque++
                x += step
            }
            y += step
        }
        return opaque >= 8
    }

    private fun query(category: String): List<ResolveInfo> = try {
        pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(category), 0)
    } catch (t: Throwable) { emptyList() }

    private fun categoryOf(ai: ApplicationInfo?): String {
        if (ai == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return ""
        return when (ai.category) {
            ApplicationInfo.CATEGORY_VIDEO -> "video"
            ApplicationInfo.CATEGORY_AUDIO -> "audio"
            ApplicationInfo.CATEGORY_GAME -> "game"
            ApplicationInfo.CATEGORY_IMAGE -> "image"
            ApplicationInfo.CATEGORY_SOCIAL -> "social"
            ApplicationInfo.CATEGORY_NEWS -> "news"
            ApplicationInfo.CATEGORY_MAPS -> "maps"
            ApplicationInfo.CATEGORY_PRODUCTIVITY -> "productivity"
            else -> ""
        }
    }

    /**
     * Rend n'importe quel Drawable dans un Bitmap 128×128 ARGB_8888.
     * - AdaptiveIconDrawable : calques arrière + avant dessinés à 150 % puis découpés en carré arrondi
     *   (corrige les icônes « carrés blancs » où seul le calque avant blanc était visible).
     * - Autres : bornes explicites, proportions conservées, centré.
     */
    private fun renderIcon(source: Drawable): Bitmap {
        val s = ICON_SIZE
        val d = source.mutate()
        val bitmap = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && d is AdaptiveIconDrawable) {
            val radius = s * 0.24f
            val clip = Path().apply {
                addRoundRect(RectF(0f, 0f, s.toFloat(), s.toFloat()), radius, radius, Path.Direction.CW)
            }
            canvas.save()
            canvas.clipPath(clip)
            // Calques de 108 dp pour une zone visible de 72 dp → 25 % de débord de chaque côté.
            val inset = s / 4
            val bg = d.background
            if (bg != null) {
                bg.setBounds(-inset, -inset, s + inset, s + inset)
                bg.draw(canvas)
            } else {
                canvas.drawColor(Color.parseColor("#2A2F3A"))
            }
            d.foreground?.let {
                it.setBounds(-inset, -inset, s + inset, s + inset)
                it.draw(canvas)
            }
            canvas.restore()
            return bitmap
        }

        val iw = d.intrinsicWidth
        val ih = d.intrinsicHeight
        if (iw > 0 && ih > 0 && iw != ih) {
            val scale = minOf(s.toFloat() / iw, s.toFloat() / ih)
            val w = (iw * scale).toInt()
            val h = (ih * scale).toInt()
            val left = (s - w) / 2
            val top = (s - h) / 2
            d.setBounds(left, top, left + w, top + h)
        } else {
            d.setBounds(0, 0, s, s)
        }
        d.draw(canvas)
        return bitmap
    }

    private fun renderBanner(source: Drawable): Bitmap {
        val w = BANNER_W
        val h = BANNER_H
        val d = source.mutate()
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        d.setBounds(0, 0, w, h)
        d.draw(canvas)
        return bitmap
    }

    /**
     * Couleur dominante saturée : histogramme par teinte (24 secteurs) pondéré par saturation × luminosité.
     * Ignore la transparence, le blanc et le noir purs ainsi que les gris.
     */
    private fun dominantColor(bitmap: Bitmap): String {
        val w = bitmap.width
        val h = bitmap.height
        val pixels = IntArray(w * h)
        bitmap.getPixels(pixels, 0, w, 0, 0, w, h)

        val buckets = 24
        val weight = FloatArray(buckets)
        val sumR = FloatArray(buckets)
        val sumG = FloatArray(buckets)
        val sumB = FloatArray(buckets)
        val hsv = FloatArray(3)

        var i = 0
        while (i < pixels.size) {
            val p = pixels[i]
            i += 2 // un pixel sur deux : largement suffisant
            if (Color.alpha(p) < 160) continue
            val r = Color.red(p); val g = Color.green(p); val b = Color.blue(p)
            if (r > 240 && g > 240 && b > 240) continue
            if (r < 16 && g < 16 && b < 16) continue
            Color.RGBToHSV(r, g, b, hsv)
            if (hsv[1] < 0.22f || hsv[2] < 0.18f) continue
            val k = ((hsv[0] / 360f) * buckets).toInt().coerceIn(0, buckets - 1)
            val wgt = hsv[1] * hsv[2]
            weight[k] += wgt
            sumR[k] += r * wgt; sumG[k] += g * wgt; sumB[k] += b * wgt
        }

        var best = -1
        var bestW = 0f
        for (k in 0 until buckets) if (weight[k] > bestW) { bestW = weight[k]; best = k }
        if (best < 0 || bestW < 1f) return DEFAULT_ACCENT

        val r = (sumR[best] / bestW).toInt().coerceIn(0, 255)
        val g = (sumG[best] / bestW).toInt().coerceIn(0, 255)
        val b = (sumB[best] / bestW).toInt().coerceIn(0, 255)
        return String.format(Locale.US, "#%02X%02X%02X", r, g, b)
    }

    private fun toDataUri(bitmap: Bitmap): String {
        val out = ByteArrayOutputStream(16 * 1024)
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
        return "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
    }

    companion object {
        private const val TAG = "X96Q-Bridge"
        private const val ICON_SIZE = 128
        private const val BANNER_W = 480
        private const val BANNER_H = 270
        private const val DEFAULT_ACCENT = "#4A5468"
    }
}
