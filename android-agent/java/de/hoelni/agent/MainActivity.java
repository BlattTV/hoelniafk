package de.hoelni.agent;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.File;
import java.io.FileInputStream;

/**
 * The app screen (assets/ui/index.html in a WebView). It talks to the agent process over its
 * control server on 127.0.0.1 – port and token come from control.json through the bridge below.
 */
public class MainActivity extends Activity {
  private WebView web;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    // light / dark like the phone (theme "Control" sets the bars); the page follows prefers-color-scheme
    boolean dark = (getResources().getConfiguration().uiMode & android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES;
    web = new WebView(this);
    web.setBackgroundColor(dark ? Color.BLACK : Color.WHITE);
    WebSettings s = web.getSettings();
    // the page has its own dark design – no automatic darkening
    if (android.os.Build.VERSION.SDK_INT >= 33) s.setAlgorithmicDarkeningAllowed(false);
    else if (android.os.Build.VERSION.SDK_INT >= 29) s.setForceDark(WebSettings.FORCE_DARK_OFF);
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    web.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, String url) {
        if (url.startsWith("file:///android_asset/")) return false;
        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        return true;
      }
    });
    web.addJavascriptInterface(new Bridge(this), "HoelniApp");
    web.loadUrl("file:///android_asset/ui/index.html");
    setContentView(web);

    if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 1);
    }
    if (AgentService.enabled(this)) AgentService.setEnabled(this, true);
  }

  @Override
  public void onBackPressed() {
    moveTaskToBack(true); // the agent keeps running; the screen only shows it
  }

  /** Called from the page (window.HoelniApp). */
  static final class Bridge {
    private final Activity a;

    Bridge(Activity a) {
      this.a = a;
    }

    @JavascriptInterface
    public String control() {
      File f = new File(AgentService.dataDir(a), "control.json");
      try {
        FileInputStream in = new FileInputStream(f);
        try {
          byte[] b = new byte[(int) Math.min(f.length(), 4096)];
          int n = in.read(b);
          return n > 0 ? new String(b, 0, n, "UTF-8") : "";
        } finally {
          in.close();
        }
      } catch (Exception e) {
        return "";
      }
    }

    /** Start problems: the last start errors and the end of the agent log (no secrets are logged). */
    @JavascriptInterface
    public String diagnostics() {
      File dir = AgentService.dataDir(a);
      return "Android " + Build.VERSION.RELEASE + " (API " + Build.VERSION.SDK_INT + "), " + Build.MANUFACTURER + " " + Build.MODEL + ", ABI " + java.util.Arrays.toString(Build.SUPPORTED_ABIS)
          + "\n\n" + tail(new File(dir, "start-error.txt"), 2000) + "\n" + tail(new File(dir, "agent.log"), 4000);
    }

    private String tail(File f, int max) {
      try {
        java.io.RandomAccessFile r = new java.io.RandomAccessFile(f, "r");
        try {
          long start = Math.max(0, r.length() - max);
          byte[] b = new byte[(int) (r.length() - start)];
          r.seek(start);
          r.readFully(b);
          return new String(b, "UTF-8");
        } finally {
          r.close();
        }
      } catch (Exception e) {
        return "";
      }
    }

    @JavascriptInterface
    public boolean isEnabled() {
      return AgentService.enabled(a);
    }

    @JavascriptInterface
    public void setEnabled(final boolean on) {
      if (!on) new File(AgentService.dataDir(a), "control.json").delete();
      AgentService.setEnabled(a, on);
    }

    @JavascriptInterface
    public boolean batteryRestricted() {
      PowerManager pm = (PowerManager) a.getSystemService(Context.POWER_SERVICE);
      return !pm.isIgnoringBatteryOptimizations(a.getPackageName());
    }

    @JavascriptInterface
    public void allowBackground() {
      try {
        Intent i = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + a.getPackageName()));
        a.startActivity(i);
      } catch (Exception e) {
        a.startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
      }
    }

    @JavascriptInterface
    public void openUrl(String url) {
      if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    }

    @JavascriptInterface
    public String deviceName() {
      return AgentService.deviceName();
    }

    @JavascriptInterface
    public String appVersion() {
      return AgentService.versionName(a);
    }
  }
}
