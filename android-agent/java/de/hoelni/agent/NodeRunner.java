package de.hoelni.agent;

/** Node.js embedded in the app (libnode.so from nodejs-mobile). Can run once per process. */
final class NodeRunner {
  static {
    System.loadLibrary("c++_shared");
    System.loadLibrary("node");
    System.loadLibrary("hoelni");
  }

  private NodeRunner() {}

  /** Runs Node with these arguments (args[0] = "node", args[1] = script) until it ends. */
  static native int start(String[] args);
}
