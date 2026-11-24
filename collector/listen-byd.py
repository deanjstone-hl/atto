#!/usr/bin/env python3
"""Listen for the ATTO 1's charge state on the BYD push channel and print it (atto/8, ADR-006
Amendment 2).

Read-only, and it reads nothing: it signs in as the second account, lets pybyd open its MQTT
push connection, and prints one JSON line, {"charging": true} or {"charging": false}, each time
a push for the car carries a charge state. It calls two pybyd methods, get_vehicles (to sign in
and pick the car) and ensure_session (to renew the sign-in before it expires), and nothing else:
no command method, no control PIN, no realtime or GPS read. Nothing else a push carries (doors,
tyres, the position) leaves this process, and neither does the VIN.

collector/push.ts runs it, turns a change of state into charge_start or charge_stop, and runs the
collector once for it. Credentials come from BYD_USERNAME and BYD_PASSWORD in the environment
(push.ts sets them for this one child); they are never printed. Use the second account, as the
reader does.

It never ends by itself: systemd restarts it if it dies, and push.ts exits when it does.

  ATTO1_VIN                       pick this car when the account has several (as read-byd.py)
  ATTO1_BYD_BASE_URL / _COUNTRY   as read-byd.py
  ATTO1_PUSH_REFRESH_SECONDS      how often to renew an expiring sign-in (default 600)
"""

import asyncio
import json
import os
import sys
import warnings

warnings.filterwarnings("ignore")

from pybyd import BydClient, BydConfig  # noqa: E402
from pybyd.exceptions import BydAuthenticationError  # noqa: E402

AU_BASE_URL = "https://dilinkappoversea-au.byd.auto"
AU_COUNTRY = "AU"

# See read-byd.py: a new BYD account answers 3008 until it was signed in to once in the phone app.
NEW_ACCOUNT_CODE = "3008"

CHARGING = 1
REFRESH_SECONDS = float(os.environ.get("ATTO1_PUSH_REFRESH_SECONDS") or 600)


def as_number(value):
    """A pushed value as a number, or None for missing, for BYD's -1 'unknown' and for anything
    that is not a number."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return None if value == -1 else float(value)


def charging_from(payload):
    """Whether a push says the car is charging: True, False, or None when it carries no charge
    state. A full realtime push has chargeState at the top; a partial push has the charge
    section (chargeStatusDto); a smart-charge push has chargingState. 1 is charging, anything
    else (0, and 15 for connected but idle) is not."""
    if not isinstance(payload, dict):
        return None
    for source in (payload, payload.get("chargeStatusDto")):
        if not isinstance(source, dict):
            continue
        for key in ("chargeState", "chargingState"):
            state = as_number(source.get(key))
            if state is not None:
                return state == CHARGING
    return None


async def main():
    base_url = os.environ.get("ATTO1_BYD_BASE_URL") or AU_BASE_URL
    config = BydConfig.from_env(
        base_url=base_url,
        country_code=os.environ.get("ATTO1_BYD_COUNTRY") or AU_COUNTRY,
        time_zone="Australia/Sydney",
        mqtt_enabled=True,
    )
    wanted = os.environ.get("ATTO1_VIN")
    chosen = {"vin": None}

    def on_push(_event, vin, payload):
        # Before the car is picked, or for another car on the account, a push is not ours.
        if chosen["vin"] is None or vin != chosen["vin"]:
            return
        charging = charging_from(payload)
        # One line per push for our car, to find out why a charge stop was not heard (atto/20):
        # the charge state only, never the VIN, the position or the payload.
        label = "none" if charging is None else str(charging).lower()
        print(f"push: charging={label}", file=sys.stderr, flush=True)
        if charging is not None:
            print(json.dumps({"charging": charging}), flush=True)

    async with BydClient(config, on_mqtt_event=on_push) as client:
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
        vehicle = next((v for v in vehicles if not wanted or v.vin == wanted), None)
        if vehicle is None:
            raise SystemExit("the account has no vehicle (is the car authorised to it?)")
        chosen["vin"] = vehicle.vin
        print("listening for charge pushes", file=sys.stderr, flush=True)

        # pybyd's push connection lives as long as its sign-in. Renewing it restarts the
        # connection with fresh credentials, so a push is not missed after the session expires.
        while True:
            await asyncio.sleep(REFRESH_SECONDS)
            await client.ensure_session()


if __name__ == "__main__":
    asyncio.run(main())
