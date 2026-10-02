package de.hoelni.control;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Backend address and sign-in of this phone. The device token is stored encrypted with a key of the
 * Android keystore (it lets the widgets talk to the backend without the app being open).
 */
final class Store {
  static final String DEFAULT_BACKEND = "https://afk.hoelni.de";
  private static final String PREFS = "control";
  private static final String ALIAS = "hoelni-control-token";

  private Store() {}

  private static SharedPreferences prefs(Context c) {
    return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
  }

  static String backend(Context c) {
    return prefs(c).getString("backend", null);
  }

  static void setBackend(Context c, String url) {
    prefs(c).edit().putString("backend", url).remove("token").remove("iv").remove("user").commit();
  }

  static String user(Context c) {
    return prefs(c).getString("user", null);
  }

  static synchronized void setToken(Context c, String token, String user) {
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.ENCRYPT_MODE, key());
      byte[] enc = cipher.doFinal(token.getBytes("UTF-8"));
      prefs(c).edit()
          .putString("token", Base64.encodeToString(enc, Base64.NO_WRAP))
          .putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
          .putString("user", user)
          .commit();
    } catch (Exception e) {
      clear(c);
    }
  }

  static synchronized String token(Context c) {
    String t = prefs(c).getString("token", null);
    String iv = prefs(c).getString("iv", null);
    if (t == null || iv == null) return null;
    try {
      Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
      cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
      return new String(cipher.doFinal(Base64.decode(t, Base64.NO_WRAP)), "UTF-8");
    } catch (Exception e) {
      return null;
    }
  }

  static void clear(Context c) {
    prefs(c).edit().remove("token").remove("iv").remove("user").commit();
  }

  private static SecretKey key() throws Exception {
    KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
    ks.load(null);
    if (ks.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(ALIAS, null)).getSecretKey();
    KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
    g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build());
    return g.generateKey();
  }
}
