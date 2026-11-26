import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { migrateLegacyDataDir } from '../src/index.js'

/** Run `fn` with DSH_HOME pointed at `home` and the data-dir env cleared. */
async function withHome(home, fn) {
  const savedHome = process.env.DSH_HOME
  const savedDir = process.env.DSH_GATEWAY_DATA_DIR
  process.env.DSH_HOME = home
  delete process.env.DSH_GATEWAY_DATA_DIR
  try {
    await fn()
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
    if (savedDir === undefined) delete process.env.DSH_GATEWAY_DATA_DIR
    else process.env.DSH_GATEWAY_DATA_DIR = savedDir
  }
}

test('migrateLegacyDataDir copies only the token out of profiles/', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gateway-home-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const legacy = join(home, 'profiles', 'gateway')
  const next = join(home, 'gateway')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'token.txt'), 'legacy-token-0123456789abcdef\n')
  await writeFile(join(legacy, 'settings.json'), '{"pwa":false}')
  // Profile scaffolding must not be copied.
  await writeFile(join(legacy, 'cordis.yml'), '[]')

  const notices = []
  await withHome(home, () => migrateLegacyDataDir(next, { info: (m) => notices.push(m) }))

  assert.equal((await readFile(join(next, 'token.txt'), 'utf8')).trim(), 'legacy-token-0123456789abcdef')
  // Settings migrate into the profile directory via GatewaySettingsStore, not here.
  await assert.rejects(() => readFile(join(next, 'settings.json'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(() => readFile(join(next, 'cordis.yml'), 'utf8'), { code: 'ENOENT' })
  // Old copies are left in place: the legacy dir may be a real profile.
  assert.equal((await readFile(join(legacy, 'token.txt'), 'utf8')).trim(), 'legacy-token-0123456789abcdef')
  assert.equal(notices.length, 1)
})

test('migrateLegacyDataDir never overwrites the new location', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gateway-home-keep-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const legacy = join(home, 'profiles', 'gateway')
  const next = join(home, 'gateway')
  await mkdir(legacy, { recursive: true })
  await mkdir(next, { recursive: true })
  await writeFile(join(legacy, 'token.txt'), 'old-token-0123456789abcdef\n')
  await writeFile(join(next, 'token.txt'), 'new-token-0123456789abcdef\n')

  await withHome(home, () => migrateLegacyDataDir(next))
  assert.equal((await readFile(join(next, 'token.txt'), 'utf8')).trim(), 'new-token-0123456789abcdef')
})

test('migrateLegacyDataDir is a no-op without legacy files or with an explicit dir', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gateway-home-noop-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const next = join(home, 'gateway')

  await withHome(home, () => migrateLegacyDataDir(next))
  await assert.rejects(() => readFile(join(next, 'token.txt'), 'utf8'), { code: 'ENOENT' })

  // An explicit DSH_GATEWAY_DATA_DIR opts out of migration entirely.
  const legacy = join(home, 'profiles', 'gateway')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'token.txt'), 'legacy-token-0123456789abcdef\n')
  await withHome(home, async () => {
    process.env.DSH_GATEWAY_DATA_DIR = next
    await migrateLegacyDataDir(next)
  })
  await assert.rejects(() => readFile(join(next, 'token.txt'), 'utf8'), { code: 'ENOENT' })
})
