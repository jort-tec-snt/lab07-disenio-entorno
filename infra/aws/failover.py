#!/usr/bin/env python3
"""Detiene una app, comprueba el ALB y la restaura siempre."""
import json
import pathlib
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = json.loads((ROOT / ".local/aws/inventory.json").read_text())
KEY = ROOT / ".local/aws/lab07-aws.pem"
REGION = "us-east-1"


def command(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=30)
    if p.returncode:
        raise RuntimeError(p.stderr[-400:])
    return p.stdout


def ssh(cmd):
    host = STATE["hosts"]["lab07-app-1"]["public_ip"]
    return command(["ssh", "-i", str(KEY), "-o", "StrictHostKeyChecking=accept-new",
                    "-o", "ConnectTimeout=8", f"ubuntu@{host}", cmd])


def states():
    data = json.loads(command(["aws", "elbv2", "describe-target-health", "--region", REGION,
                               "--target-group-arn", STATE["tg_arn"], "--output", "json"]))
    return {entry["Target"]["Id"]: entry["TargetHealth"]["State"]
            for entry in data["TargetHealthDescriptions"]}


def await_states(expected, limit=120):
    end = time.monotonic() + limit
    while time.monotonic() < end:
        current = states()
        if all(current.get(k) == v for k, v in expected.items()):
            return
        time.sleep(5)
    raise RuntimeError("Estados de targets no alcanzados: " + str(list(current.values())))


def main():
    app1 = STATE["hosts"]["lab07-app-1"]["id"]
    app2 = STATE["hosts"]["lab07-app-2"]["id"]
    stopped = False
    try:
        ssh("sudo docker stop lab07-app >/dev/null")
        stopped = True
        print("app_1_stopped=ok", flush=True)
        await_states({app1: "unhealthy", app2: "healthy"})
        print("targets=unhealthy,healthy", flush=True)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://" + STATE["alb_dns"] + "/health", timeout=10) as response:
            if response.status != 200 or json.load(response)["server"] != "app-aws-2":
                raise RuntimeError("Servicio no disponible en app-aws-2")
        print("service_on_app_2=200", flush=True)
    finally:
        if stopped:
            ssh("sudo docker start lab07-app >/dev/null")
            print("app_1_restored=ok", flush=True)
            await_states({app1: "healthy", app2: "healthy"})
            print("targets=healthy,healthy", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR: " + str(e), file=sys.stderr)
        sys.exit(1)
