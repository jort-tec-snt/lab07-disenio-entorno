#!/usr/bin/env python3
"""Elimina solo los recursos identificados y etiquetados de este laboratorio."""
import json
import pathlib
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = json.loads((ROOT / ".local/aws/inventory.json").read_text())
REGION = "us-east-1"
PROJECT = "lab07-disenio-entorno"


def call(*args):
    p = subprocess.run(["aws", *args, "--region", REGION, "--output", "json"],
                       capture_output=True, text=True, timeout=600)
    if p.returncode:
        if any(s in p.stderr for s in ("NotFound", "InvalidInstanceID.NotFound",
                                     "InvalidGroup.NotFound", "InvalidVolume.NotFound")):
            return None
        raise RuntimeError(p.stderr[-500:])
    return json.loads(p.stdout) if p.stdout.strip() else {}


def owned(tags):
    values = {x["Key"]: x["Value"] for x in tags}
    if values.get("Project") != PROJECT or values.get("ManagedBy") != "codex":
        raise RuntimeError("Recurso sin etiquetas propias; limpieza detenida")


def ec2_tags(resource_id):
    result = call("ec2", "describe-tags", "--filters", f"Name=resource-id,Values={resource_id}")
    return [] if result is None else [{"Key": x["Key"], "Value": x["Value"]} for x in result["Tags"]]


def main():
    if "alb_arn" in STATE:
        result = call("elbv2", "describe-tags", "--resource-arns", STATE["alb_arn"])
        if result:
            owned(result["TagDescriptions"][0]["Tags"])
            call("elbv2", "delete-load-balancer", "--load-balancer-arn", STATE["alb_arn"])
            subprocess.run(["aws", "elbv2", "wait", "load-balancers-deleted",
                            "--load-balancer-arns", STATE["alb_arn"], "--region", REGION],
                           check=True, timeout=600)
            print("ALB eliminado", flush=True)
    if "tg_arn" in STATE:
        result = call("elbv2", "describe-tags", "--resource-arns", STATE["tg_arn"])
        if result:
            owned(result["TagDescriptions"][0]["Tags"])
            call("elbv2", "delete-target-group", "--target-group-arn", STATE["tg_arn"])
            print("Target Group eliminado", flush=True)
    ids = [v["id"] for v in STATE.get("hosts", {}).values()]
    if ids:
        for instance_id in ids:
            owned(ec2_tags(instance_id))
        call("ec2", "terminate-instances", "--instance-ids", *ids)
        subprocess.run(["aws", "ec2", "wait", "instance-terminated", "--instance-ids", *ids,
                        "--region", REGION], check=True, timeout=600)
        print("EC2 terminadas", flush=True)
    for host in STATE.get("hosts", {}).values():
        volume_id = host.get("volume_id")
        if not volume_id:
            continue
        result = call("ec2", "describe-volumes", "--volume-ids", volume_id)
        if result and result.get("Volumes"):
            volume = result["Volumes"][0]
            owned(volume["Tags"])
            if volume["State"] != "available":
                raise RuntimeError("Volumen propio aún no disponible: " + volume_id)
            call("ec2", "delete-volume", "--volume-id", volume_id)
    for key in ("db_sg", "app_sg", "alb_sg"):
        if key in STATE:
            group_id = STATE[key]
            result = call("ec2", "describe-security-groups", "--group-ids", group_id)
            if result and result.get("SecurityGroups"):
                owned(result["SecurityGroups"][0]["Tags"])
                for attempt in range(12):
                    try:
                        call("ec2", "delete-security-group", "--group-id", group_id)
                        break
                    except RuntimeError as e:
                        if "DependencyViolation" not in str(e) or attempt == 11:
                            raise
                        time.sleep(10)
    if "key_name" in STATE:
        result = call("ec2", "describe-key-pairs", "--key-names", STATE["key_name"])
        if result and result.get("KeyPairs"):
            owned(result["KeyPairs"][0]["Tags"])
            call("ec2", "delete-key-pair", "--key-name", STATE["key_name"])
    print("Limpieza AWS completada. Los archivos privados locales permanecen en .local/aws/.")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR: " + str(e), file=sys.stderr)
        sys.exit(1)
