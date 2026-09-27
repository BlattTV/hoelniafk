/** Subset of Mojang's launcher metadata formats (version manifest v2, version json, asset index, Java runtime). */

export interface VersionManifest {
  latest: { release: string; snapshot: string };
  versions: Array<{ id: string; type: string; url: string; sha1?: string; releaseTime?: string }>;
}

export interface Artifact {
  path?: string;
  sha1?: string;
  size?: number;
  url: string;
}

export interface Rule {
  action: 'allow' | 'disallow';
  os?: { name?: string; arch?: string; version?: string };
  features?: Record<string, boolean>;
}

export interface Library {
  name: string;
  /** Fabric-style libraries: maven repository base instead of `downloads`. */
  url?: string;
  sha1?: string;
  size?: number;
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> };
  rules?: Rule[];
  natives?: Record<string, string>;
  extract?: { exclude?: string[] };
}

export type ArgumentValue = string | { rules?: Rule[]; value: string | string[] };

export interface VersionJson {
  id: string;
  inheritsFrom?: string;
  type?: string;
  mainClass: string;
  assets?: string;
  assetIndex?: { id: string; sha1: string; size?: number; totalSize?: number; url: string };
  downloads?: { client?: Artifact; [k: string]: Artifact | undefined };
  javaVersion?: { component: string; majorVersion: number };
  libraries: Library[];
  arguments?: { game?: ArgumentValue[]; jvm?: ArgumentValue[] };
  /** Pre-1.13 style arguments. */
  minecraftArguments?: string;
  logging?: { client?: { argument: string; file: { id: string; sha1: string; size?: number; url: string }; type?: string } };
}

export interface AssetIndex {
  objects: Record<string, { hash: string; size: number }>;
  map_to_resources?: boolean;
  virtual?: boolean;
}

export interface JavaRuntimeIndex {
  [platform: string]: Record<string, Array<{ manifest: { sha1: string; size?: number; url: string }; version: { name: string } }>>;
}

export interface JavaRuntimeManifest {
  files: Record<
    string,
    | { type: 'directory' }
    | { type: 'file'; executable?: boolean; downloads: { raw: { sha1: string; size?: number; url: string } } }
    | { type: 'link'; target: string }
  >;
}
