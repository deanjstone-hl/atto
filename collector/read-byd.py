#!/usr/bin/env python3
"""Read the ATTO 1's state from the BYD cloud, once, and print it as JSON (ADR-006).

Read-only. It calls two pybyd methods, get_vehicles and get_vehicle_realtime, and nothing
else: no command method, no control PIN, no GPS call, no MQTT push. It prints a fixed
handful of fields, so location, doors and tyres never leave this process.

Credentials come from BYD_USERNAME and BYD_PASSWORD in the environment (run.ts sets them
for this one child); they are never printed. Use the second account (`atto1-byd-username`), not
the owner's: BYD allows one app session per account, and a login here ends it.

  read-byd.py           print the reading
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
from pybyd.exceptions import BydAuthenticationError  # noqa: E402

AU_BASE_URL = "https://dilinkappoversea-au.byd.auto"
AU_COUNTRY = "AU"

# A new BYD account answers the login with 3008 "Wrong email or password" until it has been
# signed in to once in the BYD phone app, even with the right password (7 Nov 2026: the second
# account's first sign-in on the phone cleared it). BYD also serves each account from one
# regional node, so an account registered outside Australia needs ATTO1_BYD_BASE_URL and
# ATTO1_BYD_COUNTRY (default AU).
NEW_ACCOUNT_CODE = "3008"


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


async def main(audit):
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

        realtime = await client.get_vehicle_realtime(vehicle.vin)

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

        print(
            json.dumps(
                {
                    "vin": vehicle.vin,
                    "model_name": vehicle.model_name or None,
                    "online": int(realtime.online_state) == 1,
                    "observed_at": as_iso(realtime.timestamp),
                    "soc_pct": as_number(realtime.elec_percent),
                    "range_km": as_number(realtime.endurance_mileage),
                    "odometer_km": as_number(realtime.total_mileage),
                    "charge_state": as_number(realtime.charge_state),
                }
            )
        )


if __name__ == "__main__":
    asyncio.run(main("--audit" in sys.argv[1:]))
