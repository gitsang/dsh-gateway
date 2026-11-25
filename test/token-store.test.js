import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installLaunchToken } from '../src/index.js'
import { isValidToken, LaunchTokenStore } from '../src/token-store.js'

test('isValidToken accepts base64url secrets and rejects weak ones', () => {
  assert.equal(isValidToken('A'.repeat(43)), true)
  assert.equal(isValidToken('abc-DEF_1234567890abcdef'), true)
  assert.equal(isValidToken('short'), false)
  assert.equal(isValidToken('has spaces in it!!!!!!'), false)
  assert.equal(isValidToken('contains+plus/and=pad!!'), false)
  assert.equal(isValidToken(undefined), false)
  assert.equal(isValidToken(''), false)
})

test('LaunchTokenStore generates once and reuses the persisted token', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gateway-token-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'token.txt')

  const first = new LaunchTokenStore(file)
  await first.init()
  assert.equal(first.source, 'generated')
  assert.equal(isValidToken(first.token), true)
  assert.equal((await readFile(file, 'utf8')).trim(), first.token)
  // The credential file is owner-only.
  assert.equal((await stat(file)).mode & 0o777, 0o600)

  const second = new LaunchTokenStore(file)
  await second.init()
  assert.equal(second.source, 'file')
  assert.equal(second.token, first.token)
})

test('LaunchTokenStore prefers a valid DSH_GATEWAY_TOKEN', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gateway-token-env-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'token.txt')
  const envToken = 'env-chosen-token-0123456789'

  const store = new LaunchTokenStore(file, envToken)
  await store.init()
  assert.equal(store.source, 'env')
  assert.equal(store.token, envToken)
  // The env token is not written to disk; removing the env falls back to a
  // generated secret rather than silently persisting the env value.
  await assert.rejects(() => readFile(file, 'utf8'), { code: 'ENOENT' })
})

test('LaunchTokenStore ignores an invalid env token with a warning', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gateway-token-bad-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const warnings = []
  const store = new LaunchTokenStore(join(dir, 'token.txt'), 'weak', {
    warn: (message) => warnings.push(message)
  })
  await store.init()
  assert.equal(store.source, 'generated')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /DSH_GATEWAY_TOKEN/)
})

test('LaunchTokenStore regenerates over a corrupt token file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gateway-token-corrupt-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, 'token.txt')
  await writeFile(file, 'not a valid token!\n')

  const store = new LaunchTokenStore(file)
  await store.init()
  assert.equal(store.source, 'generated')
  assert.equal((await readFile(file, 'utf8')).trim(), store.token)
})

test('installLaunchToken swaps the token dsh advertises', () => {
  const auth = { launchToken: 'process-random-token' }
  const connection = {
    browserAuth: auth,
    authenticatedUrl(base) {
      const url = new URL(base)
      url.searchParams.set('token', auth.launchToken)
      return url.href
    }
  }
  const token = 'persistent-token-0123456789'
  assert.equal(installLaunchToken(connection, token), true)
  assert.equal(auth.launchToken, token)
  assert.equal(new URL(connection.authenticatedUrl('http://127.0.0.1:3080/')).searchParams.get('token'), token)
})

test('installLaunchToken degrades with a warning on an unknown dsh shape', () => {
  const warnings = []
  const logger = { warn: (message) => warnings.push(message) }

  assert.equal(installLaunchToken({}, 'persistent-token-0123456789', logger), false)
  assert.equal(installLaunchToken(undefined, 'persistent-token-0123456789', logger), false)

  // A dsh whose authenticatedUrl ignores the property must not report success.
  const stubborn = {
    browserAuth: { launchToken: 'process-random-token' },
    authenticatedUrl: () => 'http://127.0.0.1/?token=something-else'
  }
  assert.equal(installLaunchToken(stubborn, 'persistent-token-0123456789', logger), false)
  assert.equal(warnings.length, 3)
})
