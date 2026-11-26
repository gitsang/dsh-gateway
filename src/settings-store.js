import { access, mkdir, rename } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWrite, readJsonFile } from './stores.js'

/** Toggles owned by the gateway settings page. */
export const GATEWAY_SETTING_KEYS = ['pwa', 'hostMode']

/**
 * User-facing gateway preferences: profile-scoped configuration stored at
 * `<profile dir>/gateway/settings.json`, so the file travels with the
 * profile's config repository. Credentials (`token.txt`) are a different
 * scope and stay in the home-level data directory, git-ignored.
 *
 * These deliberately do not live in dsh's own settings store: turning Host
 * mode off removes the browser's Host-settings transport, and this page must
 * still be able to turn it back on. A small JSON file owned by the gateway is
 * the only bootstrap-safe place for the switch.
 */
export class GatewaySettingsStore {
  /**
   * @param file - current settings path (`<profile dir>/gateway/settings.json`).
   * @param legacyFiles - pre-0.5.0 locations, newest first; adopted on init.
   */
  constructor(file, legacyFiles = []) {
    this.file = file
    this.legacyFiles = legacyFiles.filter((candidate) => candidate !== file)
    this.values = {}
    this.writeQueue = Promise.resolve()
  }

  async init() {
    await mkdir(dirname(this.file), { recursive: true })
    await this.adoptLegacyFile()
    const data = await readJsonFile(this.file)
    this.values = {}
    for (const key of GATEWAY_SETTING_KEYS) {
      if (typeof data?.[key] === 'boolean') this.values[key] = data[key]
    }
  }

  /**
   * Move a pre-0.5.0 settings file to the profile-scoped location once. The
   * current file always wins; a failed move is non-fatal because the legacy
   * copy stays readable and the next init retries.
   */
  async adoptLegacyFile() {
    const exists = async (file) => {
      try {
        await access(file)
        return true
      } catch {
        return false
      }
    }
    if (await exists(this.file)) return
    for (const legacy of this.legacyFiles) {
      if (!(await exists(legacy))) continue
      try {
        await rename(legacy, this.file)
      } catch {
        // Leave the legacy copy in place; values below still fall back to it.
      }
      return
    }
  }

  has(key) {
    return Object.prototype.hasOwnProperty.call(this.values, key)
  }

  get(key) {
    return this.values[key]
  }

  snapshot() {
    return { ...this.values }
  }

  async update(patch) {
    for (const key of GATEWAY_SETTING_KEYS) {
      if (patch?.[key] === undefined) continue
      if (typeof patch[key] !== 'boolean') throw new TypeError(`${key} must be a boolean`)
      this.values[key] = patch[key]
    }
    await this.save()
    return this.snapshot()
  }

  async save() {
    const data = `${JSON.stringify(this.values, null, 2)}\n`
    const write = () => atomicWrite(this.file, data)
    this.writeQueue = this.writeQueue.then(write, write)
    return this.writeQueue
  }
}