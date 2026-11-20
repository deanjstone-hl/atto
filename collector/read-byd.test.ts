import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The reader is the only code that talks to the BYD cloud, and ADR-006 says it only reads.
// These checks are static: CI never runs it, because it needs the live account.
const source = readFileSync(join(import.meta.dirname, 'read-byd.py'), 'utf8')
const code = source
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n')

// get_gps_info is the one read added by atto/6, and only behind --with-location (see below).
const READS = ['get_vehicles', 'get_vehicle_realtime', 'get_gps_info']

describe('read-byd.py', () => {
  it('calls only the three read methods on the pybyd client', () => {
    const calls = [...code.matchAll(/\bclient\.([a-z_]+)\(/g)].map((match) => match[1])
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.filter((name) => !READS.includes(name))).toEqual([])
  })

  it.each([
    'lock',
    'unlock',
    'start_climate',
    'stop_climate',
    'flash_lights',
    'find_car',
    'open_windows',
    'close_windows',
    'open_trunk',
    'close_trunk',
    'start_charging',
    'stop_charging',
    'RemoteCommand',
    'set_',
    'save_charging_schedule',
    'toggle_smart_charging',
    'rename_vehicle',
    'verify_command_access',
    'control_password',
    'control_pin',
  ])('never mentions %s', (name) => {
    expect(code).not.toContain(name)
  })

  it('defaults to the AU node and lets ATTO1_BYD_BASE_URL and ATTO1_BYD_COUNTRY pick another', () => {
    expect(code).toContain('https://dilinkappoversea-au.byd.auto')
    expect(code).toContain('ATTO1_BYD_BASE_URL')
    expect(code).toContain('ATTO1_BYD_COUNTRY')
    expect(code).not.toMatch(/base_url\s*=\s*AU_BASE_URL/)
  })

  it('explains that code 3008 on a new account means it was never signed in to on the phone app', () => {
    expect(code).toContain('3008')
    expect(code).toMatch(/signed in .* phone app/i)
  })

  it('keeps MQTT push off', () => {
    expect(code).toMatch(/mqtt_enabled\s*=\s*False/)
  })

  it('does not print credentials or the location', () => {
    expect(code).not.toMatch(/print\([^)]*(password|username|latitude|longitude)/i)
  })

  // The position is read only when the run was triggered from the phone (atto/6, the ADR-006
  // amendment): the one GPS call sits behind the --with-location flag, and nowhere else.
  it('names the GPS call once, inside the branch that --with-location guards', () => {
    expect(code.match(/get_gps_info/g)).toHaveLength(1)
    const guard = code.lastIndexOf('if with_location', code.indexOf('get_gps_info'))
    expect(guard).toBeGreaterThan(-1)
    expect(code.slice(guard, code.indexOf('get_gps_info'))).not.toMatch(/\n\S/)
  })
})

// Run --audit against a stand-in for pybyd (no network, no account) whose realtime model
// carries a unit string, a number, an enum-like value and BYD's -1 "unknown".
describe('read-byd.py --audit', () => {
  const STUB = `
import enum
import os

class BydAuthenticationError(Exception):
    code = ""

class BydEndpointNotSupportedError(Exception):
    code = "1001"

class Unit(enum.IntEnum):
    on = 1

class Realtime:
    model_fields = {"elec_percent": 1, "endurance_mileage_unit": 1, "charge_state": 1, "cabin_temp": 1, "gear": 1, "raw": 1}
    elec_percent = 53
    online_state = Unit.on
    timestamp = None
    endurance_mileage = 164
    total_mileage = 3447
    endurance_mileage_unit = "km"
    charge_state = Unit.on
    cabin_temp = -1
    gear = None

class Scope:
    code, name, children = "1", "Privacy", []

class Vehicle:
    vin = "STUBVIN"
    model_name = "ATTO 1"
    is_shared = True
    range_detail_list = [Scope()]

class Gps:
    latitude = 0.5
    longitude = -0.5

class BydClient:
    def __init__(self, config): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *exc): return None
    async def get_vehicles(self): return [Vehicle()]
    async def get_vehicle_realtime(self, vin):
        if os.environ.get("STUB_REALTIME_REFUSED"):
            raise BydEndpointNotSupportedError(
                f"/vehicleInfo/vehicle/vehicleRealTimeRequest not supported for VIN {vin} (code=1001)"
            )
        return Realtime()
    async def get_gps_info(self, vin):
        import sys
        print("GPS-CALLED", file=sys.stderr)
        if os.environ.get("STUB_GPS_FAIL"):
            raise RuntimeError(f"GPS endpoint failed for VIN {vin}")
        return Gps()

class BydConfig:
    @staticmethod
    def from_env(**overrides): return overrides
`
  const run = (argv: string[] = ['--audit'], env: Record<string, string> = {}) => {
    const root = mkdtempSync(join(tmpdir(), 'read-byd-'))
    try {
      mkdirSync(join(root, 'pybyd'))
      writeFileSync(join(root, 'pybyd', '__init__.py'), STUB)
      writeFileSync(
        join(root, 'pybyd', 'exceptions.py'),
        'from pybyd import BydAuthenticationError, BydEndpointNotSupportedError\n',
      )
      const args = JSON.stringify(['read-byd.py', ...argv])
      return spawnSync('python3', ['-I', '-c', `import sys, runpy; sys.path.insert(0, sys.argv[1]); sys.argv = ${args}; runpy.run_path(${JSON.stringify(join(import.meta.dirname, 'read-byd.py'))}, run_name='__main__')`, root], {
        encoding: 'utf8',
        env: { ...process.env, ...env },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('does not crash on a unit string and counts only numeric and enum fields as populated', () => {
    const result = run()
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    const audit = JSON.parse(result.stdout)
    expect(audit.realtime_populated).toEqual({
      elec_percent: true,
      endurance_mileage_unit: false,
      charge_state: true,
      cabin_temp: false,
      gear: false,
    })
    expect(audit.granted_scopes).toEqual([{ code: '1', name: 'Privacy', children: [] }])
    expect(result.stdout).not.toContain('STUBVIN')
  })

  // Code 1001 is BYD's catch-all "not supported". Since 12 Nov 2026 it is also what the cloud
  // answers a guest account (a car shared through Family and friends) that does not declare
  // itself, which pybyd 0.0.80 fixes. The run must say so, not dump a traceback.
  it('turns a refused realtime read (code 1001) into a clear message that names no VIN', () => {
    const result = run([], { STUB_REALTIME_REFUSED: '1' })
    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('1001')
    expect(result.stderr).toMatch(/shared|guest/i)
    expect(result.stderr).toContain('pybyd')
    expect(result.stderr).not.toContain('Traceback')
    expect(result.stderr).not.toContain('STUBVIN')
  })

  describe('the position (atto/6)', () => {
    it('is never read or printed without --with-location', () => {
      const result = run([])
      expect(result.status).toBe(0)
      expect(result.stderr).toBe('')
      const printed = JSON.parse(result.stdout)
      expect(Object.keys(printed).sort()).toEqual(
        ['charge_state', 'model_name', 'observed_at', 'odometer_km', 'online', 'range_km', 'soc_pct', 'vin'],
      )
    })

    it('is read once and printed with --with-location', () => {
      const result = run(['--with-location'])
      expect(result.status).toBe(0)
      expect(result.stderr.match(/GPS-CALLED/g)).toHaveLength(1)
      expect(JSON.parse(result.stdout)).toMatchObject({ soc_pct: 53, latitude: 0.5, longitude: -0.5 })
    })

    it('does not stop the reading when the GPS read fails: the position is null and the log names no VIN', () => {
      const result = run(['--with-location'], { STUB_GPS_FAIL: '1' })
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ soc_pct: 53, latitude: null, longitude: null })
      expect(result.stderr).toContain('GPS read failed: RuntimeError')
      expect(result.stderr).not.toContain('STUBVIN')
    })

    it('is not part of --audit', () => {
      const result = run(['--audit', '--with-location'])
      expect(result.stderr).not.toContain('GPS-CALLED')
      expect(result.stdout).not.toMatch(/latitude|longitude/)
    })
  })

  it('does the same in --audit mode', () => {
    const result = run(['--audit'], { STUB_REALTIME_REFUSED: '1' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('1001')
    expect(result.stderr).not.toContain('STUBVIN')
  })
})
