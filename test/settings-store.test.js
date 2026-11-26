import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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

test('a pre-0.5.0 settings file is adopted into the profile-scoped location', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gateway-adopt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const legacyData = join(dir, 'data', 'settings.json')
  const legacyProfile = join(dir, 'profiles', 'gateway', 'settings.json')
  const file = join(dir, 'profiles', 'web', 'gateway', 'settings.json')
  await mkdir(join(dir, 'data'), { recursive: true })
  await writeFile(legacyData, JSON.stringify({ pwa: false, hostMode: true }))

  const store = new GatewaySettingsStore(file, [legacyData, legacyProfile])
  await store.init()
  assert.deepEqual(store.snapshot(), { pwa: false, hostMode: true })
  assert.equal(existsSync(legacyData), false, 'the legacy file moved')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { pwa: false, hostMode: true })
})

test('the newer legacy location wins, and the current file wins over both', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gateway-precedence-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const legacyData = join(dir, 'data', 'settings.json')
  const legacyProfile = join(dir, 'profiles', 'gateway', 'settings.json')
  const file = join(dir, 'profiles', 'web', 'gateway', 'settings.json')
  await mkdir(join(dir, 'data'), { recursive: true })
  await mkdir(join(dir, 'profiles', 'gateway'), { recursive: true })
  await writeFile(legacyData, JSON.stringify({ pwa: false }))
  await writeFile(legacyProfile, JSON.stringify({ hostMode: false }))

  const first = new GatewaySettingsStore(file, [legacyData, legacyProfile])
  await first.init()
  assert.deepEqual(first.snapshot(), { pwa: false }, 'first listed legacy wins')
  await rm(file)

  const second = new GatewaySettingsStore(file, [legacyData, legacyProfile])
  await second.init()
  assert.deepEqual(second.snapshot(), { hostMode: false }, 'falls through to the next legacy')

  await writeFile(file, JSON.stringify({ pwa: true, hostMode: true }))
  const third = new GatewaySettingsStore(file, [legacyData, legacyProfile])
  await third.init()
  assert.deepEqual(third.snapshot(), { pwa: true, hostMode: true }, 'current file always wins')
})
