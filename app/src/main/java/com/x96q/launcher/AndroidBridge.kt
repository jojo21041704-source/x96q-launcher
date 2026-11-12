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
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Pont exposé sous `window.AndroidBridge`.
 *
 * Démarrage à froid sans attente :
 *  - le JS affiche d'abord sa copie `localStorage` (cached_apps_v1), puis appelle
 *    [requestApps] avec la signature de cette copie ; l'appel rend la main immédiatement ;
 *  - le scan PackageManager tourne sur un thread d'arrière-plan dédié, jamais sur le thread UI ;
 *  - les icônes déjà converties sont relues depuis un cache disque (une seule conversion PNG par
 *    version d'application) ;
 *  - `window.onAppsUpdated({sig, apps})` n'est appelé que si la liste a changé ou si le JS n'avait rien.
 *
 * @param pushJs exécute un script dans la WebView courante (fourni par MainActivity, thread UI).
 */
class AndroidBridge(
    private val activity: Activity,
    private val pushJs: (String) -> Unit
) {

    private val pm: PackageManager = activity.packageManager
    private val scanExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val netExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private val bannerCache = ConcurrentHashMap<String, String>()
    private val iconDir: File by lazy { File(activity.cacheDir, "icons").apply { mkdirs() } }

    @Volatile private var cachedJson: String? = null      // tableau d'apps (API synchrone historique)
    @Volatile private var cachedSig: String? = null
    @Volatile private var deliveredSig: String? = null    // ce que le JS affiche actuellement

    /** Lance un scan dès onCreate, en parallèle du chargement de la WebView. */
    fun warmUp() { scanExecutor.execute { scan() } }

    /** Installation / désinstallation : rescan en tâche de fond, notification seulement si nécessaire. */
    fun onPackagesChanged() {
        bannerCache.clear()
        scanExecutor.execute {
            val (sig, _) = scan()
            if (sig != deliveredSig) deliver()
        }
    }

    fun shutdown() {
        scanExecutor.shutdownNow()
        netExecutor.shutdownNow()
    }

    // ------------------------------------------------------------------ API JavaScript

    /**
     * Non bloquant. [knownSignature] = signature de la liste affichée par le JS ("" si aucune).
     * Notifie `window.onAppsUpdated` uniquement si la liste réelle diffère.
     */
    @JavascriptInterface
    fun requestApps(knownSignature: String?) {
        deliveredSig = knownSignature?.takeIf { it.isNotEmpty() }
        scanExecutor.execute {
            val (sig, _) = scan()
            if (sig != deliveredSig) deliver()
        }
    }

    /** API synchrone conservée pour compatibilité (n'est plus utilisée au démarrage). */
    @JavascriptInterface
    fun getInstalledApps(): String = cachedJson ?: scan().second

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

    /**
     * Lit l'en-tête HTTP `Date` d'Open-Meteo (impossible depuis le JS : en-tête non exposé en CORS)
     * et renvoie l'écart avec l'horloge du boîtier : `window.onNetworkTime(offsetMs)`.
     * Utile au boot quand l'horloge interne n'est pas encore synchronisée. Jusqu'à 5 essais.
     */
    @JavascriptInterface
    fun syncNetworkTime() {
        netExecutor.execute {
            for (attempt in 0 until 5) {
                if (Thread.currentThread().isInterrupted) return@execute
                try {
                    val t0 = System.currentTimeMillis()
                    val conn = URL(TIME_URL).openConnection() as HttpURLConnection
                    conn.requestMethod = "GET"
                    conn.connectTimeout = 5000
                    conn.readTimeout = 5000
                    conn.useCaches = false
                    conn.connect()
                    val serverDate = conn.date
                    conn.disconnect()
                    val t1 = System.currentTimeMillis()
                    if (serverDate > 0) {
                        // L'en-tête est à la seconde près : on vise le milieu de la seconde et de l'aller-retour.
                        val offset = serverDate + 500 + (t1 - t0) / 2 - t1
                        pushJs("window.onNetworkTime && window.onNetworkTime($offset)")
                        return@execute
                    }
                } catch (t: Throwable) {
                    Log.i(TAG, "Network time unavailable (attempt ${attempt + 1})")
                }
                try { Thread.sleep(20_000) } catch (_: InterruptedException) { return@execute }
            }
        }
    }

    // ------------------------------------------------------------------ Scan

    private fun deliver() {
        val json = cachedJson ?: return
        val sig = cachedSig ?: return
        deliveredSig = sig
        // \u2028 / \u2029 sont valides en JSON mais pas dans un littéral JS ancien.
        val payload = "{\"sig\":" + JSONObject.quote(sig) + ",\"apps\":" + json + "}"
        pushJs("window.onAppsUpdated && window.onAppsUpdated(" +
            payload.replace("\u2028", "\\u2028").replace("\u2029", "\\u2029") + ")")
    }

    private data class Entry(val info: ResolveInfo, val isTv: Boolean, val updated: Long)

    /**
     * Retourne (signature, json). La signature (paquets + dates de mise à jour) se calcule en
     * quelques millisecondes ; les icônes ne sont reconverties que pour les apps nouvelles ou mises à jour.
     */
    @Synchronized
    private fun scan(): Pair<String, String> {
        val entries = try { collect() } catch (t: Throwable) {
            Log.e(TAG, "scan failed", t); emptyList()
        }
        val sig = entries.map { it.info.activityInfo.packageName + ":" + it.updated }.sorted()
            .joinToString("|").hashCode().toString(16) + "-" + entries.size

        if (sig == cachedSig) cachedJson?.let { return sig to it }

        val apps = entries.map { e ->
            val label = e.info.loadLabel(pm)?.toString()?.trim().orEmpty().ifEmpty { e.info.activityInfo.packageName }
            label to e
        }.sortedBy { it.first.lowercase(Locale.getDefault()) }

        val array = JSONArray()
        val keep = HashSet<String>()
        for ((label, e) in apps) {
            val pkg = e.info.activityInfo.packageName
            val (accent, icon) = iconFor(e)
            keep.add(iconFile(pkg).name)
            array.put(JSONObject().apply {
                put("name", label)
                put("packageName", pkg)
                put("isTv", e.isTv)
                put("category", categoryOf(e.info.activityInfo.applicationInfo))
                put("accentColor", accent)
                put("icon", icon)
            })
        }
        // Ménage : icônes d'applications désinstallées.
        iconDir.listFiles()?.forEach { if (it.name !in keep) it.delete() }

        val json = array.toString()
        cachedJson = json
        cachedSig = sig
        return sig to json
    }

    private fun collect(): List<Entry> {
        val self = activity.packageName
        val map = LinkedHashMap<String, Entry>()
        fun add(info: ResolveInfo, tv: Boolean) {
            val pkg = info.activityInfo.packageName
            if (pkg == self || map.containsKey(pkg)) return
            val updated = try { pm.getPackageInfo(pkg, 0).lastUpdateTime } catch (_: Throwable) { 0L }
            map[pkg] = Entry(info, tv, updated)
        }
        query(Intent.CATEGORY_LEANBACK_LAUNCHER).forEach { add(it, true) }
        query(Intent.CATEGORY_LAUNCHER).forEach { add(it, false) }
        return map.values.toList()
    }

    private fun iconFile(pkg: String) = File(iconDir, "$pkg.$ICON_CACHE_VERSION")

    /** (accentColor, dataUri) : cache disque si la version de l'app n'a pas changé, sinon conversion. */
    private fun iconFor(e: Entry): Pair<String, String> {
        val pkg = e.info.activityInfo.packageName
        val file = iconFile(pkg)
        try {
            if (file.exists()) {
                val parts = file.readText().split('\n', limit = 3)
                if (parts.size == 3 && parts[0] == e.updated.toString()) return parts[1] to parts[2]
            }
        } catch (_: Throwable) { }

        val bitmap = extractIcon(e.info)
        val accent = bitmap?.let { dominantColor(it) } ?: DEFAULT_ACCENT
        val uri = bitmap?.let { toDataUri(it) } ?: ""
        bitmap?.recycle()
        try { file.writeText(e.updated.toString() + "\n" + accent + "\n" + uri) } catch (_: Throwable) { }
        return accent to uri
    }

    private fun startSafely(intent: Intent): Boolean {
        if (intent.resolveActivity(pm) == null) return false
        activity.runOnUiThread {
            try { activity.startActivity(intent) }
            catch (e: ActivityNotFoundException) { Log.w(TAG, "No activity for $intent", e) }
            catch (e: SecurityException) { Log.w(TAG, "Not allowed to start $intent", e) }
        }
        return true
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
        private const val ICON_CACHE_VERSION = "v1"
        private const val TIME_URL = "https://api.open-meteo.com/v1/forecast?latitude=33.92&longitude=-6.91&current_weather=true"
    }
}
