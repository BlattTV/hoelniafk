package de.hoelni.agent;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.security.KeyStore;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Key of the agent's vault (device token, proxy): a random passphrase, stored only encrypted with a
 * key of the Android keystore (never leaves the device's secure hardware where available).
 */
final class VaultKey {
  private static final String ALIAS = "hoelni-agent-vault";
  private static final String PREFS = "vault";

  private VaultKey() {}

  static synchronized String get(Context ctx) throws Exception {
    SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    SecretKey key = keystoreKey();
    String stored = p.getString("passphrase", null);
    String iv = p.getString("iv", null);
    if (stored != null && iv != null) {
      Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
      c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)));
      return new String(c.doFinal(Base64.decode(stored, Base64.NO_WRAP)), "UTF-8");
    }
    byte[] raw = new byte[32];
    new SecureRandom().nextBytes(raw);
    StringBuilder hex = new StringBuilder();
    for (byte b : raw) hex.append(String.format("%02x", b));
    String passphrase = hex.toString();
    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
    c.init(Cipher.ENCRYPT_MODE, key);
    byte[] enc = c.doFinal(passphrase.getBytes("UTF-8"));
    p.edit()
        .putString("passphrase", Base64.encodeToString(enc, Base64.NO_WRAP))
        .putString("iv", Base64.encodeToString(c.getIV(), Base64.NO_WRAP))
        .commit();
    return passphrase;
  }

  private static SecretKey keystoreKey() throws Exception {
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
