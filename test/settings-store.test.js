import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { GatewaySettingsStore } from '../src/settings-store.js'

test('GatewaySettingsStore persists only known boolean toggles', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gateway-settings-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'settings.json')

  await writeFile(file, JSON.stringify({ pwa: false, hostMode: true, ignored: 'x' }))
  const store = new GatewaySettingsStore(file)
  await store.init()
  assert.deepEqual(store.snapshot(), { pwa: false, hostMode: true })
  assert.equal(store.has('pwa'), true)

  await store.update({ hostMode: false })
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { pwa: false, hostMode: false })

  await assert.rejects(() => store.update({ pwa: 'yes' }), /pwa must be a boolean/)
})
