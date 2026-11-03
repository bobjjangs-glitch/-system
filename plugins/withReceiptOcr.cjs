const { withAppBuildGradle, withMainApplication, withDangerousMod } = require("@expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");

const gateSource = (packageName) => String.raw`package ${packageName}

// A settled/cancelled generation can never resolve a newer receipt's Promise.
internal class DispatchReceiptOcrGate<T : Any> {
  private var active: T? = null
  private var closed = false
  @Synchronized fun begin(value: T): Boolean {
    if (closed || active != null) return false
    active = value
    return true
  }
  @Synchronized fun isCurrent(value: T): Boolean = active === value
  @Synchronized fun take(value: T): Boolean {
    if (active !== value) return false
    active = null
    return true
  }
  @Synchronized fun cancel(): T? = active.also { active = null }
  @Synchronized fun close(): T? {
    closed = true
    return cancel()
  }
}
`;

const moduleSource = (packageName) => String.raw`package ${packageName}

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.ImageDecoder
import android.graphics.Color
import android.graphics.Matrix
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import androidx.exifinterface.media.ExifInterface
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.module.annotations.ReactModule
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import java.io.File
import java.io.FileOutputStream
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

@ReactModule(name = DispatchReceiptOcrModule.NAME)
class DispatchReceiptOcrModule(context: ReactApplicationContext) : ReactContextBaseJavaModule(context) {
  companion object {
    const val NAME = "DispatchReceiptOcr"
    const val TIMEOUT_MS = 4500L
    const val MAX_EDGE = 2200
    @JvmStatic fun sampleSize(width: Int, height: Int): Int {
      require(width > 0 && height > 0) { "Invalid receipt dimensions" }
      var sample = 1
      while (maxOf(width, height) / sample > MAX_EDGE) sample *= 2
      return sample
    }
  }

  private class Job(val promise: Promise) {
    val started = SystemClock.elapsedRealtime()
    @Volatile var timer: ScheduledFuture<*>? = null
    @Volatile var engine: TextRecognizer? = null
    @Volatile var file: File? = null
  }
  private data class Decoded(val bitmap: Bitmap, val rotation: Int)
  private val gate = DispatchReceiptOcrGate<Job>()
  private val engineLock = Any()
  private val background = Executors.newSingleThreadExecutor { runnable ->
    Thread(runnable, "DispatchReceiptOcrImage").apply { isDaemon = true }
  }
  private val deadlines = Executors.newSingleThreadScheduledExecutor { runnable ->
    Thread(runnable, "DispatchReceiptOcrDeadline").apply { isDaemon = true }
  }
  // Completion must still release bitmaps after module invalidation/shutdown.
  private val direct = Executor { it.run() }
  @Volatile private var destroyed = false
  private var cachedEngine: TextRecognizer? = null
  private val closedEngines = java.util.WeakHashMap<TextRecognizer, Boolean>()

  override fun getName() = NAME
  override fun getConstants(): MutableMap<String, Any> = mutableMapOf(
    "timeoutMs" to TIMEOUT_MS.toDouble(), "model" to "korean-bundled", "maxEdge" to MAX_EDGE
  )

  private fun execute(work: () -> Unit): Boolean {
    return try { background.execute(work); true }
    catch (_: RejectedExecutionException) { false }
  }
  private fun engine(): TextRecognizer {
    synchronized(engineLock) { cachedEngine?.let { return it } }
    val created = TextRecognition.getClient(KoreanTextRecognizerOptions.Builder().build())
    return synchronized(engineLock) {
      if (destroyed) {
        runCatching { created.close() }
        throw IllegalStateException("Receipt recognizer closed")
      }
      val previous = cachedEngine
      if (previous != null) {
        runCatching { created.close() }
        previous
      } else created.also { cachedEngine = it }
    }
  }
  private fun reset(engine: TextRecognizer?) {
    if (engine == null) return
    val close = synchronized(engineLock) {
      if (cachedEngine === engine) cachedEngine = null
      closedEngines.put(engine, true) == null
    }
    if (!close) return
    if (!execute { runCatching { engine.close() } }) runCatching { engine.close() }
  }
  private fun prepareEngine(promise: Promise?) {
    if (!execute {
      var bitmap: Bitmap? = null
      var current: TextRecognizer? = null
      try {
        if (destroyed) { promise?.resolve(false); return@execute }
        current = engine()
        bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.WHITE) }
        val warmingImage = bitmap
        val warmingEngine = current
        current.process(InputImage.fromBitmap(warmingImage, 0)).addOnCompleteListener(direct) { task ->
          if (!warmingImage.isRecycled) warmingImage.recycle()
          if (!task.isSuccessful) reset(warmingEngine)
          promise?.resolve(task.isSuccessful && !destroyed)
        }
      } catch (_: Exception) {
        bitmap?.let { if (!it.isRecycled) it.recycle() }
        reset(current)
        promise?.resolve(false)
      } catch (_: OutOfMemoryError) {
        bitmap?.let { if (!it.isRecycled) it.recycle() }
        reset(current)
        promise?.resolve(false)
      }
    }) promise?.resolve(false)
  }
  @ReactMethod fun warmUp(promise: Promise) = prepareEngine(promise)

  private fun readableBitmap(bitmap: Bitmap): Bitmap {
    if (!bitmap.hasAlpha() && bitmap.config == Bitmap.Config.ARGB_8888) return bitmap
    val flattened = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
    Canvas(flattened).apply { drawColor(Color.WHITE); drawBitmap(bitmap, 0f, 0f, null) }
    bitmap.recycle()
    return flattened
  }

  @ReactMethod fun recognize(uri: String, promise: Promise) {
    if (destroyed) { promise.reject("E_OCR_UNAVAILABLE", "전표 인식 기능이 종료됐습니다. 앱을 다시 열어 주세요."); return }
    val job = Job(promise)
    if (!gate.begin(job)) { promise.reject("E_OCR_BUSY", "앞선 전표 사진을 확인한 뒤 다시 촬영해 주세요."); return }
    try {
      job.timer = deadlines.schedule({
        fail(job, "E_OCR_TIMEOUT", "기기에서 전표를 읽는 시간이 초과됐습니다. 사진을 다시 선택해 주세요.")
      }, TIMEOUT_MS, TimeUnit.MILLISECONDS)
    } catch (_: RejectedExecutionException) {
      fail(job, "E_OCR_UNAVAILABLE", "전표 인식 기능이 종료됐습니다. 앱을 다시 열어 주세요.")
      return
    }
    if (!execute { recognizeImage(job, uri) })
      fail(job, "E_OCR_UNAVAILABLE", "전표 인식 기능을 사용할 수 없습니다. 앱을 다시 열어 주세요.")
  }

  private fun decode(uri: Uri): Decoded {
    require(uri.scheme == "file" || uri.scheme == "content") { "Receipt must be a local image" }
    if (Build.VERSION.SDK_INT >= 28) {
      val source = ImageDecoder.createSource(reactApplicationContext.contentResolver, uri)
      val bitmap = ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
        val width = info.size.width
        val height = info.size.height
        require(width > 0 && height > 0) { "Invalid receipt dimensions" }
        val scale = minOf(1.0, MAX_EDGE.toDouble() / maxOf(width, height))
        decoder.setTargetSize(maxOf(1, (width * scale).toInt()), maxOf(1, (height * scale).toInt()))
        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      }
      return Decoded(readableBitmap(bitmap), 0) // ImageDecoder applies EXIF orientation itself.
    }
    val resolver = reactApplicationContext.contentResolver
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    resolver.openInputStream(uri).use { stream ->
      requireNotNull(stream) { "Image is unavailable" }
      BitmapFactory.decodeStream(stream, null, bounds)
    }
    val options = BitmapFactory.Options().apply {
      inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight)
      inPreferredConfig = Bitmap.Config.ARGB_8888
    }
    var bitmap = resolver.openInputStream(uri).use { stream ->
      requireNotNull(stream) { "Image is unavailable" }
      requireNotNull(BitmapFactory.decodeStream(stream, null, options)) { "Cannot decode image" }
    }
    var rotation = 0
    var flip = false
    runCatching { resolver.openInputStream(uri).use { stream ->
      if (stream != null) {
        val exif = ExifInterface(stream)
        rotation = exif.rotationDegrees
        flip = exif.isFlipped
      }
    } }
    if (flip) {
      val previous = bitmap
      bitmap = Bitmap.createBitmap(previous, 0, 0, previous.width, previous.height,
        Matrix().apply { setScale(-1f, 1f) }, true)
      if (bitmap !== previous) previous.recycle()
    }
    return Decoded(readableBitmap(bitmap), rotation)
  }

  private fun recognizeImage(job: Job, uri: String) {
    if (!gate.isCurrent(job)) return
    var decoded: Decoded? = null
    var handedToRecognizer = false
    try {
      val decodedImage = decode(Uri.parse(uri))
      decoded = decodedImage
      if (!gate.isCurrent(job)) return
      val cache = File.createTempFile("dispatch-ocr-", ".jpg", reactApplicationContext.cacheDir)
      job.file = cache
      // JPEG encoding is part of the same deadline; no second JS decode is needed.
      // Physically rotate legacy Android bitmaps so the saved preview matches OCR.
      var output = decodedImage.bitmap
      if (decodedImage.rotation != 0) output = Bitmap.createBitmap(decodedImage.bitmap, 0, 0,
        decodedImage.bitmap.width, decodedImage.bitmap.height, Matrix().apply { postRotate(decodedImage.rotation.toFloat()) }, true)
      try {
        FileOutputStream(cache).use { stream ->
          check(output.compress(Bitmap.CompressFormat.JPEG, 85, stream)) { "Cannot prepare preview" }
        }
      } finally { if (output !== decodedImage.bitmap) output.recycle() }
      if (!gate.isCurrent(job)) return
      val current = engine()
      job.engine = current
      if (!gate.isCurrent(job)) return
      val image = decodedImage.bitmap
      val width = if (decodedImage.rotation % 180 == 0) image.width else image.height
      val height = if (decodedImage.rotation % 180 == 0) image.height else image.width
      val task = current.process(InputImage.fromBitmap(image, decodedImage.rotation))
      handedToRecognizer = true
      task.addOnCompleteListener(direct) { complete ->
        try {
          if (!gate.isCurrent(job)) return@addOnCompleteListener
          if (SystemClock.elapsedRealtime() - job.started >= TIMEOUT_MS) {
            fail(job, "E_OCR_TIMEOUT", "기기에서 전표를 읽는 시간이 초과됐습니다. 사진을 다시 선택해 주세요.")
          } else if (!complete.isSuccessful) {
            fail(job, "E_OCR_FAILED", "전표 글자를 읽지 못했습니다. 다시 촬영해 주세요.")
          } else {
            val text = complete.result.text.trim().take(100000)
            if (text.isBlank()) fail(job, "E_OCR_EMPTY", "전표의 글자가 보이지 않습니다. 글자가 나오도록 다시 촬영해 주세요.")
            else if (gate.take(job)) {
              job.timer?.cancel(false)
              val result = Arguments.createMap().apply {
                putString("text", text)
                putDouble("durationMs", (SystemClock.elapsedRealtime() - job.started).toDouble())
                putString("imageUri", Uri.fromFile(cache).toString())
                putInt("width", width)
                putInt("height", height)
              }
              job.promise.resolve(result)
            }
          }
        } catch (_: OutOfMemoryError) {
          fail(job, "E_OCR_IMAGE", "사진을 읽을 메모리가 부족합니다. 앱을 다시 열고 촬영해 주세요.")
        } catch (_: Exception) {
          fail(job, "E_OCR_FAILED", "전표를 읽지 못했습니다. 다시 촬영해 주세요.")
        } finally {
          if (!image.isRecycled) image.recycle()
          // A successful file is transferred to JS; every failed/stale job owns
          // and deletes its own preview without touching the original source.
          if (!gate.isCurrent(job) && !complete.isSuccessful) cache.delete()
        }
      }
    } catch (_: OutOfMemoryError) {
      fail(job, "E_OCR_IMAGE", "사진을 읽을 메모리가 부족합니다. 앱을 다시 열고 촬영해 주세요.")
    } catch (_: Exception) {
      fail(job, "E_OCR_IMAGE", "전표 사진을 열지 못했습니다. 사진을 다시 선택해 주세요.")
    } finally {
      if (!handedToRecognizer) {
        decoded?.bitmap?.let { if (!it.isRecycled) it.recycle() }
        if (!gate.isCurrent(job)) job.file?.delete()
      }
    }
  }

  private fun settleError(job: Job, code: String, message: String) {
    job.timer?.cancel(false)
    reset(job.engine)
    job.file?.delete()
    job.promise.reject(code, message)
  }
  private fun fail(job: Job, code: String, message: String) {
    if (gate.take(job)) settleError(job, code, message)
  }
  @ReactMethod fun cancel(promise: Promise) {
    gate.cancel()?.let { settleError(it, "E_OCR_CANCELLED", "전표 읽기를 취소했습니다.") }
    promise.resolve(null)
  }
  override fun invalidate() {
    destroyed = true
    gate.close()?.let { settleError(it, "E_OCR_UNAVAILABLE", "전표 인식 기능이 종료됐습니다.") }
    val current = synchronized(engineLock) { cachedEngine.also { cachedEngine = null } }
    reset(current)
    deadlines.shutdownNow()
    background.shutdown()
    super.invalidate()
  }
}
`;

const packageSource = (packageName) => String.raw`package ${packageName}

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class DispatchReceiptOcrPackage : BaseReactPackage() {
  override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
    if (name == DispatchReceiptOcrModule.NAME) DispatchReceiptOcrModule(reactContext) else null
  override fun getReactModuleInfoProvider() = ReactModuleInfoProvider {
    mapOf(DispatchReceiptOcrModule.NAME to ReactModuleInfo(
      DispatchReceiptOcrModule.NAME, DispatchReceiptOcrModule::class.java.name,
      false, true, false, false
    ))
  }
}
`;

module.exports = function withReceiptOcr(config) {
  config = withAppBuildGradle(config, (result) => {
    const dependency = 'implementation("com.google.mlkit:text-recognition-korean:16.0.1")';
    if (!result.modResults.contents.includes("com.google.mlkit:text-recognition-korean:")) {
      if (!/dependencies\s*\{/.test(result.modResults.contents))
        throw new Error("Cannot register bundled receipt OCR dependency: dependencies block missing");
      result.modResults.contents = result.modResults.contents.replace(/dependencies\s*\{/, `dependencies {\n    ${dependency}`);
    }
    return result;
  });
  config = withMainApplication(config, (result) => {
    if (result.modResults.language !== "kt") throw new Error("Receipt OCR requires the Kotlin application template.");
    if (!result.modResults.contents.includes("add(DispatchReceiptOcrPackage())")) {
      const anchor = /PackageList\(this\)\.packages\.apply\s*\{/;
      if (!anchor.test(result.modResults.contents)) throw new Error("Cannot register bundled receipt OCR package: package list missing");
      result.modResults.contents = result.modResults.contents.replace(anchor, (match) => match + "\n          add(DispatchReceiptOcrPackage())");
    }
    return result;
  });
  return withDangerousMod(config, ["android", async (result) => {
    const packageName = result.android.package;
    const directory = path.join(result.modRequest.platformProjectRoot, "app/src/main/java", ...packageName.split("."));
    await fs.mkdir(directory, { recursive: true });
    for (const [name, source] of [
      ["DispatchReceiptOcrGate.kt", gateSource(packageName)],
      ["DispatchReceiptOcrModule.kt", moduleSource(packageName)],
      ["DispatchReceiptOcrPackage.kt", packageSource(packageName)],
    ]) await fs.writeFile(path.join(directory, name), source);
    return result;
  }]);
};
