/*
 * JNI bridge: starts Node.js (libnode.so from nodejs-mobile) with the given arguments.
 * Built without the NDK: clang --target=aarch64-linux-android, no C library needed
 * (see scripts/build-android.mjs).
 *
 * node::Start expects all argv strings in ONE contiguous block (libuv reuses that memory for the
 * process title), so they are copied into a single buffer first.
 */
#include <jni.h>

extern int _ZN4node5StartEiPPc(int argc, char **argv); /* node::Start(int, char**) */

#define MAX_ARGS 32
#define BUF_SIZE 16384

static char buffer[BUF_SIZE];
static char *argv_ptrs[MAX_ARGS + 1];

JNIEXPORT jint JNICALL Java_de_hoelni_agent_NodeRunner_start(JNIEnv *env, jclass cls, jobjectArray args) {
  (void)cls;
  jsize n = (*env)->GetArrayLength(env, args);
  if (n < 1 || n > MAX_ARGS) return -2;
  unsigned long pos = 0;
  for (jsize i = 0; i < n; i++) {
    jstring s = (jstring)(*env)->GetObjectArrayElement(env, args, i);
    const char *utf = (*env)->GetStringUTFChars(env, s, 0);
    argv_ptrs[i] = buffer + pos;
    for (const char *c = utf; *c; c++) {
      if (pos >= BUF_SIZE - 2) {
        (*env)->ReleaseStringUTFChars(env, s, utf);
        return -3;
      }
      buffer[pos++] = *c;
    }
    buffer[pos++] = 0;
    (*env)->ReleaseStringUTFChars(env, s, utf);
    (*env)->DeleteLocalRef(env, s);
  }
  argv_ptrs[n] = 0;
  return _ZN4node5StartEiPPc((int)n, argv_ptrs);
}
