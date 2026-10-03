package de.hoelni.agent;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.system.Os;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Foreground service in its own process (":agent"): unpacks the agent (assets/agent.zip) once per
 * app version and runs it on the embedded Node.js. A partial wake lock and a Wi-Fi lock keep the
 * sessions online with the screen off. Started on boot and restarted by Android if it is killed.
 */
public class AgentService extends Service {
  static final String TAG = "HoelniAgent";
  static final String CHANNEL = "agent";
  static final String PREFS = "agent";
  private static boolean nodeStarted = false;

  private PowerManager.WakeLock wake;
  private WifiManager.WifiLock wifi;

  static boolean enabled(Context ctx) {
    return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("enabled", true);
  }

  static void setEnabled(Context ctx, boolean on) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("enabled", on).commit();
    Intent i = new Intent(ctx, AgentService.class);
    if (on) {
      if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
      else ctx.startService(i);
    } else {
      ctx.stopService(i);
    }
  }

  static File dataDir(Context ctx) {
    return new File(ctx.getFilesDir(), "agent");
  }

  @Override
  public void onCreate() {
    super.onCreate();
    startForeground(1, notification());
    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
    wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "hoelni:agent");
    wake.setReferenceCounted(false);
    wake.acquire();
    WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
    if (wm != null) {
      wifi = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "hoelni:agent");
      wifi.setReferenceCounted(false);
      wifi.acquire();
    }
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (!enabled(this)) {
      stopSelf();
      return START_NOT_STICKY;
    }
    startNode();
    return START_STICKY;
  }

  private synchronized void startNode() {
    if (nodeStarted) return;
    nodeStarted = true;
    final Context ctx = this;
    Thread t = new Thread(null, new Runnable() {
      @Override
      public void run() {
        int code;
        try {
          File app = unpack(ctx);
          File data = dataDir(ctx);
          data.mkdirs();
          File tmp = new File(getCacheDir(), "tmp");
          tmp.mkdirs();
          Os.setenv("TMPDIR", tmp.getAbsolutePath(), true);
          Os.setenv("HOME", data.getAbsolutePath(), true);
          Os.setenv("HOELNI_AGENT_DIR", data.getAbsolutePath(), true);
          String[] args = {
            "node",
            new File(app, "dist/agent/android.js").getAbsolutePath(),
            "--data", data.getAbsolutePath(),
            "--vault-key", VaultKey.get(ctx),
            "--device-name", deviceName(),
            "--app-version", versionName(ctx),
          };
          code = NodeRunner.start(args);
        } catch (Throwable e) {
          Log.e(TAG, "agent could not start", e);
          note(ctx, "start failed: " + e);
          code = -1;
        }
        Log.w(TAG, "agent ended with code " + code);
        if (code != 0) note(ctx, "agent ended with code " + code);
        // Node runs only once per process: end the process, Android starts the service again
        // (START_STICKY) as long as the agent is switched on.
        System.exit(code == 0 ? 0 : 1);
      }
    }, "node", 16L * 1024 * 1024);
    t.start();
  }

  /** Why the agent did not start / ended – shown in the app ("Agent startet …" for too long). */
  static void note(Context ctx, String text) {
    try {
      java.io.FileWriter w = new java.io.FileWriter(new File(dataDir(ctx), "start-error.txt"), true);
      try {
        w.write(new java.util.Date() + "  " + text + "  (Android " + Build.VERSION.RELEASE + ", API " + Build.VERSION.SDK_INT + ", " + Build.MODEL + ", " + java.util.Arrays.toString(Build.SUPPORTED_ABIS) + ")\n");
      } finally {
        w.close();
      }
    } catch (Exception ignored) {
      // diagnostics only
    }
  }

  static String deviceName() {
    String m = Build.MODEL == null ? "Android" : Build.MODEL;
    String brand = Build.MANUFACTURER == null ? "" : Build.MANUFACTURER;
    if (!brand.isEmpty() && !m.toLowerCase().startsWith(brand.toLowerCase())) m = brand.substring(0, 1).toUpperCase() + brand.substring(1) + " " + m;
    return m;
  }

  static String versionName(Context ctx) {
    try {
      PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
      return pi.versionName + " (" + pi.versionCode + ")";
    } catch (Exception e) {
      return "?";
    }
  }

  /** assets/agent.zip → files/app/<versionCode> (once per app version; older versions removed). */
  static File unpack(Context ctx) throws Exception {
    PackageInfo pi = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0);
    File root = new File(ctx.getFilesDir(), "app");
    File dir = new File(root, String.valueOf(pi.versionCode));
    File done = new File(dir, ".complete");
    if (done.exists()) return dir;
    deleteTree(root);
    dir.mkdirs();
    String base = dir.getCanonicalPath() + File.separator;
    byte[] buf = new byte[65536];
    InputStream in = ctx.getAssets().open("agent.zip");
    ZipInputStream zip = new ZipInputStream(in);
    try {
      ZipEntry e;
      while ((e = zip.getNextEntry()) != null) {
        File f = new File(dir, e.getName());
        if (!f.getCanonicalPath().startsWith(base)) throw new IOException("bad entry " + e.getName());
        if (e.isDirectory()) {
          f.mkdirs();
          continue;
        }
        f.getParentFile().mkdirs();
        FileOutputStream out = new FileOutputStream(f);
        try {
          int n;
          while ((n = zip.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
          out.close();
        }
      }
    } finally {
      zip.close();
    }
    new FileOutputStream(done).close();
    return dir;
  }

  static void deleteTree(File f) {
    File[] children = f.listFiles();
    if (children != null) for (File c : children) deleteTree(c);
    f.delete();
  }

  private Notification notification() {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    Notification.Builder b;
    if (Build.VERSION.SDK_INT >= 26) {
      NotificationChannel ch = new NotificationChannel(CHANNEL, "Agent im Hintergrund", NotificationManager.IMPORTANCE_LOW);
      ch.setShowBadge(false);
      nm.createNotificationChannel(ch);
      b = new Notification.Builder(this, CHANNEL);
    } else {
      b = new Notification.Builder(this);
    }
    PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    return b.setSmallIcon(R.drawable.ic_notify)
        .setContentTitle("Hoelni Agent läuft")
        .setContentText("AFK-Sessions laufen im Hintergrund – tippen zum Öffnen")
        .setContentIntent(open)
        .setOngoing(true)
        .build();
  }

  @Override
  public void onDestroy() {
    if (wake != null && wake.isHeld()) wake.release();
    if (wifi != null && wifi.isHeld()) wifi.release();
    // Switched off: let Node close the sessions cleanly (SIGTERM), then end the process.
    android.os.Process.sendSignal(android.os.Process.myPid(), 15);
    new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
      @Override
      public void run() {
        android.os.Process.killProcess(android.os.Process.myPid());
      }
    }, 4000);
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
