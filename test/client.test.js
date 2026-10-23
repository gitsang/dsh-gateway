import assert from 'node:assert/strict'
import test from 'node:test'

const factories = new Map()
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      factories.set(id, factory)
    },
  },
}

await import('../src/client.js')
const factory = factories.get('@gitsang/dsh-gateway')
assert.equal(typeof factory, 'function')
const client = factory((specifier) => {
  if (specifier === 'react') {
    return {
      Fragment: {},
      createElement() { return null },
      useCallback: (fn) => fn,
      useEffect: () => {},
      useState: (value) => [value, () => {}],
    }
  }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
    return {
      Button: () => null,
      SettingsForm: () => null,
      SettingsSecretField: () => null,
      Switch: () => null,
    }
  }
  throw new Error(`unexpected require ${specifier}`)
})

test('uptime formatting uses the active locale suffixes', () => {
  const t = (key) => ({ day: 'd', hour: 'h', minute: 'm', second: 's' })[key]
  assert.equal(client.__test.formatUptime(1_000, t), '1s')
  assert.equal(client.__test.formatUptime(61_000, t), '1m 1s')
  assert.equal(client.__test.formatUptime(3_661_000, t), '1h 1m')
})

test('apply registers the gateway row configuration page', () => {
  const events = []
  const ctx = {
    effect(fn, name) {
      events.push(['effect', name])
      return fn()
    },
    locale: {
      register(ns, dictionaries) {
        events.push(['locale', ns, Object.keys(dictionaries).sort()])
        return () => {}
      },
    },
    slots: {
      inject(name, register) {
        events.push(['inject', name])
        return register()
      },
      register(options) {
        events.push(['register', options])
        return () => {}
      },
    },
  }
  client.apply(ctx)
  assert.deepEqual(events.find((event) => event[0] === 'locale'), ['locale', 'gatewaySettings', ['en', 'zh']])
  assert.deepEqual(events.find((event) => event[0] === 'inject'), ['inject', 'plugins.row.config'])
  const registration = events.find((event) => event[0] === 'register')[1]
  assert.equal(registration.name, 'plugins.row.config')
  assert.equal(registration.key, '@gitsang/dsh-gateway#gateway')
  assert.equal(registration.key, client.__test.ROW_KEY)
  assert.equal(registration.locale, 'gatewaySettings')
})
