const {
  withAndroidManifest,
  withMainApplication,
  withDangerousMod,
} = require("@expo/config-plugins");
const fs = require("node:fs/promises");
const path = require("node:path");

const recoverySource = (packageName) => String.raw`package ${packageName}

import android.content.Context
import android.content.Intent
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.os.Build
import org.json.JSONObject
import java.io.File

object DispatchLocationRecovery {
  fun install(context: Context) {
    val guard = context.getSharedPreferences("DispatchLocationRecovery", Context.MODE_PRIVATE)
    var recovering = guard.getBoolean("locationCrash", false)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) runCatching {
      val manager = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
      val latest = manager.getHistoricalProcessExitReasons(context.packageName, 0, 5).firstOrNull {
        it.timestamp > guard.getLong("lastExitSeen", 0L) && it.reason in listOf(
          ApplicationExitInfo.REASON_CRASH, ApplicationExitInfo.REASON_CRASH_NATIVE, ApplicationExitInfo.REASON_ANR)
      }
      if (latest != null) {
        recovering = true
        guard.edit().putLong("lastExitSeen", latest.timestamp).commit()
        val detail = latest.traceInputStream?.bufferedReader()?.use { reader ->
          val chars = CharArray(10000)
          val count = reader.read(chars)
          if (count > 0) String(chars, 0, count) else ""
        } ?: ""
        File(context.filesDir, "dispatch-native-crash.txt").writeText(
          "App " + BuildConfig.VERSION_NAME + " / Android " + Build.VERSION.RELEASE + " / " + Build.MODEL + System.lineSeparator() +
          "Previous exit reason: " + latest.reason + System.lineSeparator() + (latest.description ?: "") + System.lineSeparator() + detail
        )
      }
    }
    val tasks = context.getSharedPreferences("TaskManagerModule", Context.MODE_PRIVATE)
    var removed = false
    val edit = tasks.edit()
    for ((scope, value) in tasks.all) {
      if (value !is String) continue
      try {
        val config = JSONObject(value)
        val registered = config.optJSONObject("tasks") ?: continue
        val names = registered.keys().asSequence().toList()
        for (name in names) {
          if (name == "bareun-dispatch-background-location" ||
            (recovering && name.startsWith("bareun-dispatch-background-location"))) {
            registered.remove(name)
            removed = true
          }
        }
        if (registered.length() == 0) edit.remove(scope)
        else edit.putString(scope, config.toString())
      } catch (_: Exception) {
        // Leave unrelated or unknown preference formats untouched.
      }
    }
    if (removed || recovering) {
      edit.commit()
      runCatching { context.stopService(Intent().setClassName(context, "expo.modules.location.services.LocationTaskService")) }
      runCatching { File(context.filesDir, "dispatch-location-recovery.txt").writeText("이전 위치 공유 등록을 정리했습니다. 코스와 로그인은 유지됩니다. 위치 공유를 다시 켜 주세요.") }
    }
    guard.edit().putBoolean("locationCrash", false).commit()
    val previous = Thread.getDefaultUncaughtExceptionHandler()
    Thread.setDefaultUncaughtExceptionHandler { thread, error ->
      val trace = error.stackTraceToString().take(14000)
        .replace(Regex("""(?i)Bearer\s+\S+"""), "Bearer [redacted]")
      if (trace.contains("LocationTaskService") || trace.contains("ForegroundService"))
        guard.edit().putBoolean("locationCrash", true).commit()
      runCatching {
        File(context.filesDir, "dispatch-native-crash.txt").writeText(
          "Android " + Build.VERSION.RELEASE + " / " + Build.MODEL + System.lineSeparator() + trace
        )
      }
      previous?.uncaughtException(thread, error)
    }
  }
}
`;

// Keep this plugin before expo-location / expo-notifications: manifest mods compose in reverse order.
module.exports = function withLocationServiceSafety(config) {
  config = withAndroidManifest(config, (result) => {
    const application = result.modResults.manifest.application[0];
    const metadata = (application["meta-data"] ||= []);
    for (const name of [
      "expo.modules.location.foreground_service_icon",
      "expo.modules.notifications.default_notification_icon",
    ]) {
      const existing = metadata.find(
        (entry) => entry.$["android:name"] === name,
      );
      if (existing)
        existing.$["android:resource"] =
          "@drawable/dispatch_location_notification";
      else
        metadata.push({
          $: {
            "android:name": name,
            "android:resource": "@drawable/dispatch_location_notification",
          },
        });
    }
    return result;
  });
  config = withMainApplication(config, (result) => {
    if (result.modResults.language !== "kt")
      throw new Error(
        "Location recovery requires the Kotlin application template.",
      );
    if (
      !result.modResults.contents.includes(
        "DispatchLocationRecovery.install(this)",
      )
    )
      result.modResults.contents = result.modResults.contents.replace(
        "super.onCreate()",
        "super.onCreate()\n    DispatchLocationRecovery.install(this)",
      );
    return result;
  });
  return withDangerousMod(config, [
    "android",
    async (result) => {
      const root = result.modRequest.platformProjectRoot;
      const packageName = result.android.package;
      const java = path.join(
        root,
        "app/src/main/java",
        ...packageName.split("."),
      );
      const drawable = path.join(root, "app/src/main/res/drawable");
      await fs.mkdir(java, { recursive: true });
      await fs.mkdir(drawable, { recursive: true });
      await fs.writeFile(
        path.join(java, "DispatchLocationRecovery.kt"),
        recoverySource(packageName),
      );
      await fs.writeFile(
        path.join(drawable, "dispatch_location_notification.xml"),
        `<?xml version="1.0" encoding="utf-8"?>
<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24"><path android:fillColor="#FFFFFFFF" android:pathData="M12,2a7,7 0,0 0,-7 7c0,5 7,13 7,13s7,-8 7,-13a7,7 0,0 0,-7 -7M12,6a3,3 0,1 1,0 6a3,3 0,1 1,0 -6"/></vector>`,
      );
      return result;
    },
  ]);
};
