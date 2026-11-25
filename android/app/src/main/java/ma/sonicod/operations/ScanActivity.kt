package ma.sonicod.operations

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Size
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Scanner intégré (caméra + lecture de code-barres DANS l'application).
 * Ne dépend pas du module « scanner Google » qui échoue sur certains téléphones (« Failed to scan code »).
 */
class ScanActivity : ComponentActivity() {

    private lateinit var preview: PreviewView
    private lateinit var torchBtn: TextView
    private var camera: Camera? = null
    private var torchOn = false
    private lateinit var analyzerExec: ExecutorService
    private var scanner: BarcodeScanner? = null
    @Volatile private var done = false
    private var last: String? = null
    private var lastCount = 0

    private val askCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { ok ->
        if (ok) startCamera() else fail("Autorisez la caméra pour scanner.")
    }

    private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics).toInt()

    @SuppressLint("SetTextI18n")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.statusBarColor = Color.BLACK
        analyzerExec = Executors.newSingleThreadExecutor()

        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        preview = PreviewView(this).apply { scaleType = PreviewView.ScaleType.FILL_CENTER }
        root.addView(preview, FrameLayout.LayoutParams(-1, -1))

        // cadre de visée
        val frame = View(this).apply {
            background = GradientDrawable().apply {
                setStroke(dp(3f), Color.parseColor("#FFD60A")); cornerRadius = dp(18f).toFloat(); setColor(Color.TRANSPARENT)
            }
        }
        root.addView(frame, FrameLayout.LayoutParams(dp(290f), dp(170f), Gravity.CENTER))

        val hint = TextView(this).apply {
            text = "Visez le code-barres du colis"
            setTextColor(Color.WHITE); textSize = 16f; gravity = Gravity.CENTER
            setPadding(dp(16f), dp(10f), dp(16f), dp(10f))
            background = GradientDrawable().apply { setColor(Color.parseColor("#99000000")); cornerRadius = dp(20f).toFloat() }
        }
        root.addView(hint, FrameLayout.LayoutParams(-2, -2, Gravity.CENTER_HORIZONTAL or Gravity.BOTTOM).apply { bottomMargin = dp(120f) })

        fun roundBtn(label: String) = TextView(this).apply {
            text = label; setTextColor(Color.WHITE); textSize = 22f; gravity = Gravity.CENTER
            background = GradientDrawable().apply { setColor(Color.parseColor("#80000000")); cornerRadius = dp(28f).toFloat() }
        }
        val close = roundBtn("✕").apply { setOnClickListener { cancel() } }
        root.addView(close, FrameLayout.LayoutParams(dp(56f), dp(56f), Gravity.TOP or Gravity.START).apply { topMargin = dp(24f); leftMargin = dp(16f) })
        torchBtn = roundBtn("🔦").apply { setOnClickListener { toggleTorch() } }
        root.addView(torchBtn, FrameLayout.LayoutParams(dp(56f), dp(56f), Gravity.TOP or Gravity.END).apply { topMargin = dp(24f); rightMargin = dp(16f) })

        setContentView(root)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) startCamera()
        else askCamera.launch(Manifest.permission.CAMERA)
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                val prev = Preview.Builder().build().also { it.setSurfaceProvider(preview.surfaceProvider) }
                val analysis = ImageAnalysis.Builder()
                    .setTargetResolution(Size(1280, 720))
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                val sc = BarcodeScanning.getClient(BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_ALL_FORMATS).build())
                scanner = sc
                analysis.setAnalyzer(analyzerExec) { proxy ->
                    val media = proxy.image
                    if (media == null || done) { proxy.close(); return@setAnalyzer }
                    val img = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
                    sc.process(img)
                        .addOnSuccessListener { list ->
                            val v = list.firstOrNull { !it.rawValue.isNullOrBlank() }?.rawValue?.trim()
                            if (v != null) onCode(v)
                        }
                        .addOnCompleteListener { proxy.close() }
                }
                provider.unbindAll()
                camera = provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, prev, analysis)
                camera?.cameraControl?.setLinearZoom(0.15f)
            } catch (e: Exception) {
                fail("Caméra indisponible : " + (e.message ?: ""))
            }
        }, ContextCompat.getMainExecutor(this))
    }

    /** Un code est accepté quand il est lu 2 fois de suite (évite les erreurs de lecture). */
    private fun onCode(v: String) {
        if (done) return
        if (v == last) lastCount++ else { last = v; lastCount = 1 }
        if (lastCount < 2) return
        done = true
        setResult(RESULT_OK, Intent().putExtra("value", v))
        finish()
    }

    private fun toggleTorch() {
        val cam = camera ?: return
        if (!cam.cameraInfo.hasFlashUnit()) return
        torchOn = !torchOn
        cam.cameraControl.enableTorch(torchOn)
        torchBtn.alpha = if (torchOn) 1f else 0.7f
    }

    private fun cancel() {
        done = true
        setResult(RESULT_CANCELED)
        finish()
    }

    private fun fail(msg: String) {
        done = true
        setResult(RESULT_FIRST_USER, Intent().putExtra("error", msg))
        finish()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() = cancel()

    override fun onDestroy() {
        super.onDestroy()
        try { scanner?.close() } catch (e: Exception) {}
        analyzerExec.shutdown()
    }
}
