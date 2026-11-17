// SPDX-FileCopyrightText: Copyright (C) 2026 Eagle
// SPDX-License-Identifier: LicenseRef-Eagle-Proprietary

import Log from "@lichtblick/log";
import {
  IExtensionLoader,
  InstallExtensionProps,
  LoadedExtension,
  TypeExtensionLoader,
} from "@lichtblick/suite-base/services/extension/IExtensionLoader";
import { Namespace } from "@lichtblick/suite-base/types";
import { ExtensionInfo } from "@lichtblick/suite-base/types/Extensions";

const log = Log.getLogger(__filename);

type BuiltinManifestEntry = Omit<ExtensionInfo, "namespace" | "externalId"> & { bundle: string };

/**
 * Loads extensions that ship inside the web image (served next to index.html under
 * `radar-extension/`). They are always available, independent of the browser's IndexedDB.
 *
 * Registered as an "org"/"server" loader so the catalog refreshes it on every start without any
 * user action. The extension id doubles as externalId (see loadSingleExtension).
 */
export class BuiltinExtensionLoader implements IExtensionLoader {
  public readonly namespace: Namespace = "org";
  public readonly type: TypeExtensionLoader = "server";
  readonly #baseUrl: string;
  #manifest: Promise<BuiltinManifestEntry[]> | undefined;

  public constructor(baseUrl = "radar-extension") {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
  }

  async #entries(): Promise<BuiltinManifestEntry[]> {
    this.#manifest ??= (async () => {
      const res = await fetch(`${this.#baseUrl}/manifest.json`, { cache: "no-cache" });
      if (!res.ok) {
        throw new Error(`Built-in extension manifest not available (${res.status})`);
      }
      return ((await res.json()) as { extensions: BuiltinManifestEntry[] }).extensions;
    })();
    return await this.#manifest;
  }

  #toInfo(entry: BuiltinManifestEntry): ExtensionInfo {
    const { bundle: _bundle, ...rest } = entry;
    return { ...rest, namespace: this.namespace, externalId: entry.id };
  }

  public async getExtension(id: string): Promise<ExtensionInfo | undefined> {
    const entry = (await this.#entries()).find((e) => e.id === id);
    return entry ? this.#toInfo(entry) : undefined;
  }

  public async getExtensions(): Promise<ExtensionInfo[]> {
    try {
      return (await this.#entries()).map((e) => this.#toInfo(e));
    } catch (err) {
      log.warn("Built-in extensions unavailable", err);
      return [];
    }
  }

  public async loadExtension(id: string): Promise<LoadedExtension> {
    const entry = (await this.#entries()).find((e) => e.id === id);
    if (!entry) {
      throw new Error(`Unknown built-in extension ${id}`);
    }
    const res = await fetch(`${this.#baseUrl}/${entry.bundle}`, { cache: "no-cache" });
    if (!res.ok) {
      throw new Error(`Failed to load built-in extension ${id} (${res.status})`);
    }
    return { raw: await res.text() };
  }

  public async installExtension(_data: InstallExtensionProps): Promise<ExtensionInfo> {
    throw new Error("Built-in extensions cannot be installed.");
  }

  public async uninstallExtension(_id: string): Promise<void> {
    // Built-in extensions are part of the product and cannot be removed.
  }
}
