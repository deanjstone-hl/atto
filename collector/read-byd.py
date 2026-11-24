#!/usr/bin/env python3
"""Read the ATTO 1's state from the BYD cloud, once, and print it as JSON (ADR-006).

Read-only. It calls three pybyd methods, get_vehicles, get_vehicle_realtime and, only with
--with-location, the client's GPS read, and nothing else: no command method, no control PIN, no MQTT
push. It prints a fixed handful of fields, so doors and tyres never leave this process. The
position is read and printed only when the run was triggered from the phone's CarPlay connect
or disconnect (atto/6, the ADR-006 amendment); the 30-minute timer never asks for it.

Credentials come from BYD_USERNAME and BYD_PASSWORD in the environment (run.ts sets them
for this one child); they are never printed. Use the second account (`atto1-byd-username`), not
the owner's: BYD allows one app session per account, and a login here ends it.

  read-byd.py           print the reading
  read-byd.py --with-location
                        print the reading and the car's position (latitude, longitude);
                        a failed GPS read prints null for both and still prints the reading
  read-byd.py --audit   print which grant the account holds and which realtime fields came
                        back populated, by name only, for narrowing the grant (ADR-006)
"""

import asyncio
import datetime
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

from pybyd import BydClient, BydConfig  # noqa: E402
from pybyd.exceptions import BydAuthenticationError, BydEndpointNotSupportedError  # noqa: E402

AU_BASE_URL = "https://dilinkappoversea-au.byd.auto"
AU_COUNTRY = "AU"

# A new BYD account answers the login with 3008 "Wrong email or password" until it has been
# signed in to once in the BYD phone app, even with the right password (7 Nov 2026: the second
# account's first sign-in on the phone cleared it). BYD also serves each account from one
# regional node, so an account registered outside Australia needs ATTO1_BYD_BASE_URL and
# ATTO1_BYD_COUNTRY (default AU).
NEW_ACCOUNT_CODE = "3008"

# BYD's catch-all "not supported" code. From 12 Nov 2026 the cloud also answers it to a guest
# account (a car shared through Family and friends) on every request that reaches the car, unless
# the request declares the account as a guest; pybyd 0.0.80 and later do that from the vehicle
# list's sharing flag. pybyd 0.0.79 does not, so a collector on 0.0.79 reads the car as
# "not supported" (atto/3). pybyd's own message carries the VIN, so it is never printed.
NOT_SUPPORTED_CODE = "1001"


# BYD answers a placeholder realtime when the car's data is not ready: no timestamp, and charge,
# range and odometer all 0 (24 Nov 2026, atto/20, at the moment the charger stopped). It is not
# a reading. The reader polls again a few seconds later and, if the car still sends nothing, fails.
EMPTY_READING_POLLS = 3
EMPTY_READING_WAIT_SECONDS = float(os.environ.get("ATTO1_EMPTY_RETRY_SECONDS") or 5)


def is_empty_reading(reading):
    return reading["observed_at"] is None or (
        reading["soc_pct"] == 0 and reading["range_km"] == 0 and reading["odometer_km"] == 0
    )


def as_number(value):
    """A pybyd value as a plain number, or None for missing, for BYD's -1 'unknown' and for
    anything that is not a number or an enum (unit strings such as 'km', timestamps)."""
    if value is None:
        return None
    try:
        number = float(int(value)) if hasattr(value, "value") else float(value)
    except (TypeError, ValueError):
        return None
    return None if number == -1 else number


def as_iso(moment):
    if moment is None:
        return None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return moment.astimezone(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def scope_names(scopes):
    return [
        {"code": scope.code, "name": scope.name, "children": scope_names(scope.children)}
        for scope in scopes
    ]


async def main(audit, with_location):
    base_url = os.environ.get("ATTO1_BYD_BASE_URL") or AU_BASE_URL
    config = BydConfig.from_env(
        base_url=base_url,
        country_code=os.environ.get("ATTO1_BYD_COUNTRY") or AU_COUNTRY,
        time_zone="Australia/Sydney",
        mqtt_enabled=False,
    )
    async with BydClient(config) as client:
        try:
            vehicles = await client.get_vehicles()
        except BydAuthenticationError as error:
            if error.code == NEW_ACCOUNT_CODE:
                raise SystemExit(
                    "BYD login refused with code 3008 (Wrong email or password). A new BYD account answers "
                    "3008 until it has been signed in to once in the BYD phone app; check that first. For an "
                    f"account registered outside Australia, set ATTO1_BYD_BASE_URL and ATTO1_BYD_COUNTRY (now {base_url})."
                )
            raise SystemExit(f"BYD login failed: code={error.code}")
        wanted = os.environ.get("ATTO1_VIN")
        vehicle = next((v for v in vehicles if not wanted or v.vin == wanted), None)
        if vehicle is None:
            raise SystemExit("the account has no vehicle (is the car authorised to it?)")

        async def read_realtime():
            try:
                return await client.get_vehicle_realtime(vehicle.vin)
            except BydEndpointNotSupportedError as error:
                raise SystemExit(
                    f"BYD refused the realtime read with code {error.code or NOT_SUPPORTED_CODE} (endpoint not "
                    "supported for this vehicle). The usual cause is the car being shared to this second account: "
                    "since 12 Nov 2026 BYD refuses a shared (guest) account unless pybyd declares it, which needs "
                    "pybyd 0.0.80 or later (re-run scripts/owner-steps/77.sh to update the pin). If the venv is "
                    "already on 0.0.80 or later, the account's grant may exclude live vehicle data: run "
                    "read-byd.py --audit with the owner's approval and check the granted scopes."
                )

        realtime = await read_realtime()

        if audit:
            populated = {
                name: as_number(getattr(realtime, name, None)) is not None
                for name in type(realtime).model_fields
                if name != "raw"
            }
            print(
                json.dumps(
                    {
                        "is_shared": vehicle.is_shared,
                        "granted_scopes": scope_names(vehicle.range_detail_list),
                        "realtime_populated": populated,
                    },
                    indent=2,
                )
            )
            return

        def to_reading(realtime):
            return {
                "vin": vehicle.vin,
                "model_name": vehicle.model_name or None,
                "online": int(realtime.online_state) == 1,
                "observed_at": as_iso(realtime.timestamp),
                "soc_pct": as_number(realtime.elec_percent),
                "range_km": as_number(realtime.endurance_mileage),
                "odometer_km": as_number(realtime.total_mileage),
                "charge_state": as_number(realtime.charge_state),
            }

        reading = to_reading(realtime)
        for _ in range(EMPTY_READING_POLLS - 1):
            if not is_empty_reading(reading):
                break
            await asyncio.sleep(EMPTY_READING_WAIT_SECONDS)
            reading = to_reading(await read_realtime())
        if is_empty_reading(reading):
            raise SystemExit("the car sent an empty reading")
        if with_location:
            try:
                gps = await client.get_gps_info(vehicle.vin)
                reading["latitude"] = as_number(gps.latitude)
                reading["longitude"] = as_number(gps.longitude)
            except Exception as error:  # the reading is worth more than the position
                # The class name only: pybyd's message can carry the VIN.
                print(f"GPS read failed: {type(error).__name__}", file=sys.stderr)
                reading["latitude"] = None
                reading["longitude"] = None
        print(json.dumps(reading))


if __name__ == "__main__":
    arguments = sys.argv[1:]
    asyncio.run(main("--audit" in arguments, "--with-location" in arguments))
