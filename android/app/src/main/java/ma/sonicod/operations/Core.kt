package ma.sonicod.operations

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.Matrix
import android.net.Uri
import android.util.Base64
import androidx.exifinterface.media.ExifInterface
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/** Lien EXACT du groupe WhatsApp SONICOD. */
const val WHATSAPP_GROUP_LINK = "https://chat.whatsapp.com/LP2gQjIm7R95AYBLIj27Ad"

/**
 * Adresse du script Google (…/exec). Collez-la ici avant de construire l'APK
 * pour que les téléphones n'aient rien à configurer. Sinon : Paramètres dans l'app.
 */
const val DEFAULT_SERVER_URL = "https://script.google.com/macros/s/AKfycbwJ1PN16V9WjRuOVN9cky7pKRTyufnSGlPCpw-gi4BKfGoXOQS1kn8pbcrrhPimt4sx/exec"

/** Clé partagée avec le script Google (même valeur que APP_KEY dans Code.gs). */
const val APP_KEY = "SNC-1b7ae4568269c1f64afde3ce18d9639c"

/** Session et réglages stockés sur le téléphone. */
object Session {
    private const val PREFS = "sonicod"

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun serverUrl(ctx: Context): String =
        (prefs(ctx).getString("serverUrl", "") ?: "").ifEmpty { DEFAULT_SERVER_URL }
    fun setServerUrl(ctx: Context, url: String) = prefs(ctx).edit().putString("serverUrl", url.trim()).apply()

    /** Nom facultatif affiché dans la colonne PHOTOS (« 📷 1 · Nom »). */
    fun name(ctx: Context): String = prefs(ctx).getString("name", "") ?: ""
    fun setName(ctx: Context, name: String) = prefs(ctx).edit().putString("name", name.trim()).apply()
}

/** Erreur renvoyée par le serveur (données refusées, session expirée…) – à ne PAS remettre en file d'attente. */
class ServerException(message: String, val code: String = "error") : Exception(message)

/** Appels HTTP vers le Web App Google Apps Script. */
object Api {

    /** Envoie [body] (JSON) et renvoie l'objet JSON de réponse. IOException = problème réseau. */
    @Throws(IOException::class, ServerException::class)
    fun post(url: String, body: String): JSONObject {
        if (!url.startsWith("https://")) throw ServerException("Adresse du serveur non configurée.", "config")
        var conn = (URL(url).openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = false
            requestMethod = "POST"
            doOutput = true
            connectTimeout = 20_000
            readTimeout = 180_000
            setRequestProperty("Content-Type", "text/plain;charset=utf-8")
        }
        conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
        var code = conn.responseCode
        var hops = 0
        // Apps Script répond par une redirection 302 vers googleusercontent : on la suit en GET.
        while (code in 300..399 && hops < 5) {
            val location = conn.getHeaderField("Location") ?: break
            val next = URL(URL(conn.url.toString()), location)
            conn.disconnect()
            conn = (next.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                requestMethod = "GET"
                connectTimeout = 20_000
                readTimeout = 180_000
            }
            code = conn.responseCode
            hops++
        }
        val text = try {
            (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
        } finally {
            conn.disconnect()
        }
        if (code >= 500) throw IOException("Serveur indisponible (HTTP $code)")
        if (code !in 200..299) throw ServerException("Erreur serveur (HTTP $code). Vérifiez le déploiement du script.", "config")
        return try {
            JSONObject(text)
        } catch (e: Exception) {
            throw ServerException("Réponse inattendue du serveur. Vérifiez l'adresse et l'accès « Tout le monde ».", "config")
        }
    }
}

/** Photos compressées et stockées dans l'application (files/photos). */
object PhotoStore {
    private const val MAX_SIDE = 1280
    private val ID_RE = Regex("^[a-f0-9-]{36}$")

    fun dir(ctx: Context): File = File(ctx.filesDir, "photos").apply { mkdirs() }

    fun file(ctx: Context, id: String): File? {
        if (!ID_RE.matches(id)) return null
        val f = File(dir(ctx), "$id.jpg")
        return if (f.exists()) f else null
    }

    private fun sampleSize(w: Int, h: Int, target: Int): Int {
        var s = 1
        while (w / (s * 2) >= target && h / (s * 2) >= target) s *= 2
        return s
    }

    /** Importe une image (caméra ou galerie), la redresse, la réduit et l'enregistre. Renvoie l'id. */
    fun importImage(ctx: Context, open: () -> InputStream?): String? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val first = open() ?: return null
        first.use { BitmapFactory.decodeStream(it, null, bounds) }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, MAX_SIDE) }
        var bmp = open()?.use { BitmapFactory.decodeStream(it, null, opts) } ?: return null

        val orientation = try {
            open()?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
                ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_ROTATE_90 -> m.postRotate(90f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.postRotate(180f)
            ExifInterface.ORIENTATION_ROTATE_270 -> m.postRotate(270f)
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.postScale(-1f, 1f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.postScale(1f, -1f)
        }
        val longest = maxOf(bmp.width, bmp.height)
        if (longest > MAX_SIDE) {
            val k = MAX_SIDE.toFloat() / longest
            m.postScale(k, k)
        }
        if (!m.isIdentity) {
            val out = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
            if (out != bmp) bmp.recycle()
            bmp = out
        }
        val id = UUID.randomUUID().toString()
        File(dir(ctx), "$id.jpg").outputStream().use { bmp.compress(Bitmap.CompressFormat.JPEG, 75, it) }
        bmp.recycle()
        return id
    }

    fun importUri(ctx: Context, uri: Uri): String? =
        importImage(ctx) { ctx.contentResolver.openInputStream(uri) }

    fun importFile(ctx: Context, f: File): String? =
        importImage(ctx) { if (f.exists()) f.inputStream() else null }

    /** Miniature (data URL) pour l'aperçu dans l'écran. */
    fun thumbDataUrl(ctx: Context, id: String): String {
        val f = file(ctx, id) ?: return ""
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(f.path, bounds)
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, 360) }
        val bmp = BitmapFactory.decodeFile(f.path, opts) ?: return ""
        val bos = ByteArrayOutputStream()
        bmp.compress(Bitmap.CompressFormat.JPEG, 70, bos)
        bmp.recycle()
        return "data:image/jpeg;base64," + Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP)
    }

    fun base64(ctx: Context, id: String): String? {
        val f = file(ctx, id) ?: return null
        return Base64.encodeToString(f.readBytes(), Base64.NO_WRAP)
    }

    /**
     * Copie de la photo pour WhatsApp, avec un bandeau noir en bas :
     *   ligne 1 (blanc)  : « OUARZAZAT · 111 colis scannés »
     *   ligne 2 (jaune)  : « Retour validé · 23/11/2026 · photo 2/3 »
     * L'original (envoyé dans Google Drive) n'est pas modifié.
     */
    fun stamped(ctx: Context, id: String, line1: String, line2: String): File? {
        val src = file(ctx, id) ?: return null
        val bmp = BitmapFactory.decodeFile(src.path) ?: return null
        val w = bmp.width
        val h = bmp.height
        val pad = w * 0.04f
        val p1 = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.WHITE
            textSize = w * 0.062f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        val p2 = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = 0xFFFFC629.toInt()
            textSize = w * 0.052f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
        }
        val maxW = w - 2 * pad
        while (p1.measureText(line1) > maxW && p1.textSize > 12f) p1.textSize = p1.textSize - 1f
        while (p2.measureText(line2) > maxW && p2.textSize > 12f) p2.textSize = p2.textSize - 1f
        val band = (pad * 2.2f + p1.textSize * 1.15f + p2.textSize * 1.35f).toInt()

        val out = Bitmap.createBitmap(w, h + band, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        c.drawColor(Color.BLACK)
        c.drawBitmap(bmp, 0f, 0f, null)
        bmp.recycle()
        val y1 = h + pad + p1.textSize * 0.95f
        c.drawText(line1, pad, y1, p1)
        c.drawText(line2, pad, y1 + p2.textSize * 1.4f, p2)

        val dir = File(ctx.cacheDir, "share").apply { mkdirs() }
        val f = File(dir, "SONICOD_" + id.take(8) + "_" + System.currentTimeMillis() + ".jpg")
        f.outputStream().use { out.compress(Bitmap.CompressFormat.JPEG, 85, it) }
        out.recycle()
        return f
    }

    fun delete(ctx: Context, id: String) {
        file(ctx, id)?.delete()
    }

    /** Supprime les photos de plus de 3 jours qui ne sont plus en attente d'envoi. */
    fun cleanup(ctx: Context, keep: Set<String>) {
        val limit = System.currentTimeMillis() - 3L * 24 * 3600 * 1000
        dir(ctx).listFiles()?.forEach { f ->
            val id = f.nameWithoutExtension
            if (id !in keep && f.lastModified() < limit) f.delete()
        }
        File(ctx.cacheDir, "camera").listFiles()?.forEach { if (it.lastModified() < limit) it.delete() }
        val dayAgo = System.currentTimeMillis() - 24L * 3600 * 1000
        File(ctx.cacheDir, "share").listFiles()?.forEach { if (it.lastModified() < dayAgo) it.delete() }
    }
}

/** File d'attente hors ligne : chaque opération non envoyée est gardée dans files/queue. */
object OpQueue {
    private val lock = Any()

    private fun dir(ctx: Context): File = File(ctx.filesDir, "queue").apply { mkdirs() }

    fun add(ctx: Context, op: JSONObject, photoIds: JSONArray, error: String?) = synchronized(lock) {
        val item = JSONObject()
            .put("op", op)
            .put("photoIds", photoIds)
            .put("createdAt", System.currentTimeMillis())
            .put("attempts", 0)
            .put("lastError", error ?: "")
        File(dir(ctx), op.getString("opId") + ".json").writeText(item.toString())
    }

    fun list(ctx: Context): List<JSONObject> = synchronized(lock) {
        dir(ctx).listFiles()
            ?.filter { it.name.endsWith(".json") }
            ?.mapNotNull { f -> try { JSONObject(f.readText()) } catch (e: Exception) { null } }
            ?.sortedBy { it.optLong("createdAt") }
            ?: emptyList()
    }

    fun remove(ctx: Context, opId: String) = synchronized(lock) {
        File(dir(ctx), "$opId.json").delete()
    }

    fun markError(ctx: Context, opId: String, error: String) = synchronized(lock) {
        val f = File(dir(ctx), "$opId.json")
        if (!f.exists()) return@synchronized
        val item = JSONObject(f.readText())
        item.put("attempts", item.optInt("attempts") + 1).put("lastError", error)
        f.writeText(item.toString())
    }

    fun photoIdsInQueue(ctx: Context): Set<String> {
        val ids = HashSet<String>()
        list(ctx).forEach { item ->
            val arr = item.optJSONArray("photoIds") ?: return@forEach
            for (i in 0 until arr.length()) ids.add(arr.getString(i))
        }
        return ids
    }
}

/** Envoi d'une opération (+ photos) vers le Google Sheet. */
object Submitter {

    @Throws(IOException::class, ServerException::class)
    fun send(ctx: Context, op: JSONObject, photoIds: JSONArray): JSONObject {
        val photos = JSONArray()
        for (i in 0 until photoIds.length()) {
            val b64 = PhotoStore.base64(ctx, photoIds.getString(i)) ?: continue
            photos.put(JSONObject().put("b64", b64))
        }
        val payload = JSONObject()
            .put("action", "submit")
            .put("key", APP_KEY)
            .put("who", Session.name(ctx))
            .put("op", op)
            .put("photos", photos)
        val res = Api.post(Session.serverUrl(ctx), payload.toString())
        if (!res.optBoolean("ok")) {
            throw ServerException(res.optString("error", "Erreur inconnue"), res.optString("code", "error"))
        }
        return res.getJSONObject("data")
    }

    /** Envoie toutes les opérations en attente. Renvoie false si le réseau manque encore. */
    fun flushQueue(ctx: Context): Boolean {
        for (item in OpQueue.list(ctx)) {
            val op = item.getJSONObject("op")
            val opId = op.getString("opId")
            try {
                send(ctx, op, item.optJSONArray("photoIds") ?: JSONArray())
                OpQueue.remove(ctx, opId)
            } catch (e: IOException) {
                OpQueue.markError(ctx, opId, "Pas de connexion : " + (e.message ?: ""))
                return false
            } catch (e: ServerException) {
                // Donnée refusée : on garde l'opération, visible dans « Synchronisation ».
                OpQueue.markError(ctx, opId, e.message ?: "Erreur")
            }
        }
        return true
    }
}
