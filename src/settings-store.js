import { dirname } from 'node:path'
import { atomicWrite, ensureDataDir, readJsonFile } from './stores.js'

/** Toggles owned by the gateway settings page. */
export const GATEWAY_SETTING_KEYS = ['pwa', 'hostMode']

/**
 * User-facing gateway preferences, kept separate from auth.json/session.json.
 *
 * These deliberately do not live in dsh's own settings store: turning Host
 * mode off removes the browser's Host-settings transport, and this page must
 * still be able to turn it back on. A small JSON file owned by the gateway is
 * the only bootstrap-safe place for the switch.
 */
export class GatewaySettingsStore {
  constructor(file) {
    this.file = file
    this.values = {}
    this.writeQueue = Promise.resolve()
  }

  async init() {
    await ensureDataDir(dirname(this.file))
    const data = await readJsonFile(this.file)
    this.values = {}
    for (const key of GATEWAY_SETTING_KEYS) {
      if (typeof data?.[key] === 'boolean') this.values[key] = data[key]
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
