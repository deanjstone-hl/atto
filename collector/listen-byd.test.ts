import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// listen-byd.py (atto/8) holds one BYD push connection and prints whether the car is charging
// each time a push says so. Like the reader, it only reads: ADR-006, Amendment 2.
const source = readFileSync(join(import.meta.dirname, 'listen-byd.py'), 'utf8')
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')

describe('listen-byd.py source', () => {
  it('calls only get_vehicles and ensure_session on the pybyd client', () => {
    const calls = [...code.matchAll(/\bclient\.([a-z_]+)\(/g)].map((match) => match[1])
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((name) => !['get_vehicles', 'ensure_session'].includes(name))).toEqual([])
  })

  it.each([
    'lock',
    'unlock',
    'start_climate',
    'flash_lights',
    'find_car',
    'start_charging',
    'stop_charging',
    'RemoteCommand',
    'set_',
    'verify_command_access',
    'control_password',
    'control_pin',
    'get_gps_info',
    'get_vehicle_realtime',
  ])('never mentions %s', (name) => {
    expect(code).not.toContain(name)
  })

  it('turns MQTT push on', () => {
    expect(code).toMatch(/mqtt_enabled\s*=\s*True/)
  })

  it('does not print credentials, the VIN or the position', () => {
    expect(code).not.toMatch(/print\([^)]*(password|username|latitude|longitude|vin)/i)
  })
})

// Run it against a stand-in for pybyd (no network, no account). The stand-in delivers the
// events in STUB_EVENTS to the on_mqtt_event callback once the listener is idle, as pybyd does
// from its MQTT runtime, and ends the run at the first session refresh.
const STUB = `
import json
import os

class BydAuthenticationError(Exception):
    code = ""

class Vehicle:
    vin = "STUBVIN"

class OtherVehicle:
    vin = "OTHERVIN"

class BydClient:
    def __init__(self, config, on_mqtt_event=None):
        assert config["mqtt_enabled"] is True
        self.callback = on_mqtt_event
    async def __aenter__(self): return self
    async def __aexit__(self, *exc): return None
    async def get_vehicles(self):
        if os.environ.get("STUB_LOGIN_REFUSED"):
            error = BydAuthenticationError("refused")
            error.code = os.environ["STUB_LOGIN_REFUSED"]
            raise error
        return [OtherVehicle(), Vehicle()] if os.environ.get("STUB_TWO_VEHICLES") else [Vehicle()]
    async def ensure_session(self):
        for event, vin, data in json.loads(os.environ.get("STUB_EVENTS", "[]")):
            self.callback(event, vin, data)
        raise SystemExit(0)

class BydConfig:
    @staticmethod
    def from_env(**overrides): return overrides
`

function run(events: unknown[], env: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'listen-byd-'))
  try {
    mkdirSync(join(root, 'pybyd'))
    writeFileSync(join(root, 'pybyd', '__init__.py'), STUB)
    writeFileSync(join(root, 'pybyd', 'exceptions.py'), 'from pybyd import BydAuthenticationError\n')
    const script = join(import.meta.dirname, 'listen-byd.py')
    return spawnSync(
      'python3',
      ['-I', '-c', `import sys, runpy; sys.path.insert(0, sys.argv[1]); sys.argv = ['listen-byd.py']; runpy.run_path(${JSON.stringify(script)}, run_name='__main__')`, root],
      {
        encoding: 'utf8',
        env: { ...process.env, ATTO1_PUSH_REFRESH_SECONDS: '0.01', STUB_EVENTS: JSON.stringify(events), ...env },
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const printed = (stdout: string) => stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line))

describe('listen-byd.py', { timeout: 30_000 }, () => {
  it('prints charging true for a push whose chargeState is 1, and false for 0', () => {
    const result = run([
      ['vehicleInfo', 'STUBVIN', { chargeState: 1, elecPercent: 50 }],
      ['vehicleInfo', 'STUBVIN', { chargeState: 0, elecPercent: 51 }],
    ])
    expect(result.status).toBe(0)
    expect(printed(result.stdout)).toEqual([{ charging: true }, { charging: false }])
  })

  it('counts the idle value 15 as not charging', () => {
    expect(printed(run([['vehicleInfo', 'STUBVIN', { chargeState: 15 }]]).stdout)).toEqual([{ charging: false }])
  })

  it('reads the charge section of a partial push', () => {
    const result = run([
      ['vehicleStatusPush', 'STUBVIN', { chargeStatusDto: { chargingState: 1, soc: 40 } }],
      ['smartCharge', 'STUBVIN', { chargingState: 0 }],
    ])
    expect(printed(result.stdout)).toEqual([{ charging: true }, { charging: false }])
  })

  it.each([
    ['a push with no charge field', { elecPercent: 50 }],
    ['an unknown charge state (-1)', { chargeState: -1 }],
    ['a charge state that is not a number', { chargeState: 'on' }],
    ['a payload that is not an object', 'x'],
  ])('prints nothing for %s', (_label, data) => {
    expect(run([['vehicleInfo', 'STUBVIN', data]]).stdout).toBe('')
  })

  it('ignores a push for another vehicle on the account', () => {
    const result = run(
      [
        ['vehicleInfo', 'OTHERVIN', { chargeState: 1 }],
        ['vehicleInfo', 'STUBVIN', { chargeState: 0 }],
      ],
      { STUB_TWO_VEHICLES: '1', ATTO1_VIN: 'STUBVIN' },
    )
    expect(printed(result.stdout)).toEqual([{ charging: false }])
  })

  it('names no VIN on stdout or stderr', () => {
    const result = run([['vehicleInfo', 'STUBVIN', { chargeState: 1 }]])
    expect(result.stdout + result.stderr).not.toContain('STUBVIN')
  })

  it('explains a login refused with 3008 and prints nothing', () => {
    const result = run([], { STUB_LOGIN_REFUSED: '3008' })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('3008')
    expect(result.stderr).not.toContain('Traceback')
  })
})
