#!/usr/bin/env python3
"""Despliegue acotado del laboratorio en la VPC predeterminada existente."""
import json
import os
import pathlib
import secrets
import subprocess
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
PRIVATE = ROOT / ".local/aws"
STATE = PRIVATE / "inventory.json"
CREDS = PRIVATE / "credentials.env"
KEY = PRIVATE / "lab07-aws.pem"
REGION = "us-east-1"
SETTINGS = json.loads((PRIVATE / "settings.json").read_text())
VPC = SETTINGS["vpc_id"]
SUBNETS = tuple(SETTINGS["subnet_ids"])
AMI = SETTINGS["ami_id"]
TAGS = [{"Key": "Project", "Value": "lab07-disenio-entorno"},
        {"Key": "ManagedBy", "Value": "codex"}]


def run(*args, secret=False):
    p = subprocess.run(args, text=True, capture_output=True, timeout=600)
    if p.returncode:
        raise RuntimeError(f"{args[0]} failed ({p.returncode}): {p.stderr[-800:]}")
    return p.stdout.strip()


def aws(*args):
    output = run("aws", *args, "--region", REGION, "--output", "json")
    return json.loads(output) if output else {}


def save(state):
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    PRIVATE.chmod(0o700)
    fd = os.open(STATE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(state, f, indent=2)
    STATE.chmod(0o600)


def tag_spec(kind, name=None):
    tags = TAGS + ([{"Key": "Name", "Value": name}] if name else [])
    return json.dumps([{"ResourceType": kind, "Tags": tags}])


def ensure_sg(state, key, name, description):
    if key not in state:
        result = aws("ec2", "create-security-group", "--group-name", name,
                     "--description", description, "--vpc-id", VPC,
                     "--tag-specifications", tag_spec("security-group", name))
        state[key] = result["GroupId"]
        save(state)
    return state[key]


def allow(sg, port, source):
    permission = {"IpProtocol": "tcp", "FromPort": port, "ToPort": port}
    if source.startswith("sg-"):
        permission["UserIdGroupPairs"] = [{"GroupId": source}]
    else:
        permission["IpRanges"] = [{"CidrIp": source}]
    existing = aws("ec2", "describe-security-groups", "--group-ids", sg)["SecurityGroups"][0]["IpPermissions"]
    if permission in existing:
        return
    try:
        aws("ec2", "authorize-security-group-ingress", "--group-id", sg,
            "--ip-permissions", json.dumps([permission]))
    except RuntimeError as e:
        if "InvalidPermission.Duplicate" not in str(e):
            raise


def ssh(state, name, command):
    host = state["hosts"][name]["public_ip"]
    return run("ssh", "-i", str(KEY), "-o", "StrictHostKeyChecking=accept-new",
               "-o", "ConnectTimeout=8", f"ubuntu@{host}", command)


def scp(state, name, source, target):
    host = state["hosts"][name]["public_ip"]
    run("scp", "-i", str(KEY), "-o", "StrictHostKeyChecking=accept-new",
        str(source), f"ubuntu@{host}:{target}")


def wait_ssh(state, name):
    for _ in range(8):
        try:
            ssh(state, name, "true")
            return
        except RuntimeError:
            time.sleep(5)
    raise RuntimeError(f"SSH no disponible: {name}")


def install_docker(state, name):
    marker = ssh(state, name, "command -v docker >/dev/null && echo ok || true")
    if marker == "ok":
        return
    ssh(state, name, "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io >/dev/null && sudo systemctl enable --now docker")


def env_file(path, values):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        for k, v in values.items():
            f.write(f"{k}={v}\n")
    path.chmod(0o600)


def main():
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    PRIVATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not CREDS.exists():
        env_file(CREDS, {
            "POSTGRES_DB": "lab07",
            "POSTGRES_USER": "lab07",
            "POSTGRES_PASSWORD": secrets.token_urlsafe(32),
            "SESSION_SECRET": secrets.token_urlsafe(48),
            "ADMIN_PASSWORD": secrets.token_urlsafe(24),
        })
    creds = dict(line.split("=", 1) for line in CREDS.read_text().splitlines())
    CREDS.chmod(0o600)
    if "my_ip" not in state:
        state["my_ip"] = run("curl", "-fsS", "--max-time", "20", "https://api.ipify.org").strip() + "/32"
        save(state)

    print("Fase 1: grupos de seguridad", flush=True)
    alb_sg = ensure_sg(state, "alb_sg", "lab07-alb-sg", "Lab07 ALB")
    app_sg = ensure_sg(state, "app_sg", "lab07-app-sg", "Lab07 apps")
    db_sg = ensure_sg(state, "db_sg", "lab07-db-sg", "Lab07 database")
    allow(alb_sg, 80, state["my_ip"])
    allow(app_sg, 3000, alb_sg)
    allow(db_sg, 5432, app_sg)
    for sg in (app_sg, db_sg):
        allow(sg, 22, state["my_ip"])
    if "key_name" not in state:
        material = aws("ec2", "create-key-pair", "--key-name", "lab07-aws",
                       "--key-type", "rsa",
                       "--tag-specifications", tag_spec("key-pair", "lab07-aws"))["KeyMaterial"]
        fd = os.open(KEY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(material)
        state["key_name"] = "lab07-aws"
        save(state)
    KEY.chmod(0o600)

    print("Fase 2: tres EC2", flush=True)
    state.setdefault("hosts", {})
    for name, subnet, sg in (("lab07-db", SUBNETS[0], db_sg),
                             ("lab07-app-1", SUBNETS[0], app_sg),
                             ("lab07-app-2", SUBNETS[1], app_sg)):
        if name not in state["hosts"]:
            result = aws("ec2", "run-instances", "--image-id", AMI,
                         "--instance-type", "t3.micro", "--count", "1",
                         "--key-name", state["key_name"],
                         "--credit-specification", "CpuCredits=standard",
                         "--network-interfaces", json.dumps([{
                             "DeviceIndex": 0, "SubnetId": subnet, "Groups": [sg],
                             "AssociatePublicIpAddress": True}]),
                         "--block-device-mappings", json.dumps([{
                             "DeviceName": "/dev/sda1", "Ebs": {
                                 "VolumeSize": 8, "VolumeType": "gp3",
                                 "DeleteOnTermination": True}}]),
                         "--tag-specifications", json.dumps(
                             json.loads(tag_spec("instance", name)) +
                             json.loads(tag_spec("volume", name + "-root"))))
            state["hosts"][name] = {"id": result["Instances"][0]["InstanceId"]}
            save(state)
        instance_id = state["hosts"][name]["id"]
        run("aws", "ec2", "wait", "instance-running", "--instance-ids", instance_id,
            "--region", REGION)
        info = aws("ec2", "describe-instances", "--instance-ids", instance_id)["Reservations"][0]["Instances"][0]
        state["hosts"][name]["public_ip"] = info["PublicIpAddress"]
        state["hosts"][name]["private_ip"] = info["PrivateIpAddress"]
        state["hosts"][name]["volume_id"] = info["BlockDeviceMappings"][0]["Ebs"]["VolumeId"]
        save(state)
        wait_ssh(state, name)

    print("Fase 3: Docker y PostgreSQL", flush=True)
    for name in state["hosts"]:
        install_docker(state, name)
    db_env = PRIVATE / "db.env"
    env_file(db_env, {k: creds[k] for k in ("POSTGRES_DB", "POSTGRES_USER", "POSTGRES_PASSWORD")})
    scp(state, "lab07-db", db_env, "lab07-db.env")
    ssh(state, "lab07-db", "chmod 600 lab07-db.env; sudo docker volume create lab07_pgdata >/dev/null; sudo docker inspect lab07-db >/dev/null 2>&1 || sudo docker run -d --name lab07-db --restart unless-stopped --env-file /home/ubuntu/lab07-db.env -p 5432:5432 -v lab07_pgdata:/var/lib/postgresql/data postgres:17-bookworm >/dev/null")
    for _ in range(30):
        try:
            ssh(state, "lab07-db", "sudo docker exec lab07-db pg_isready -U lab07 -d lab07 >/dev/null")
            break
        except RuntimeError:
            time.sleep(5)
    else:
        raise RuntimeError("PostgreSQL no quedó listo")

    print("Fase 4: imagen y aplicaciones", flush=True)
    image_tar = PRIVATE / "lab07-app.tar.gz"
    app1 = "lab07-app-1"
    scp(state, app1, ROOT / "app/Dockerfile", "Dockerfile")
    scp(state, app1, ROOT / "app/package.json", "package.json")
    scp(state, app1, ROOT / "app/package-lock.json", "package-lock.json")
    scp(state, app1, ROOT / "app/server.js", "server.js")
    ssh(state, app1, "sudo docker image inspect lab07-app:latest >/dev/null 2>&1 || sudo docker build -t lab07-app:latest /home/ubuntu")
    if not image_tar.exists():
        host = state["hosts"][app1]["public_ip"]
        with image_tar.open("wb") as f:
            p = subprocess.run(["ssh", "-i", str(KEY), "-o", "StrictHostKeyChecking=accept-new",
                                f"ubuntu@{host}", "sudo docker save lab07-app:latest | gzip -1"], stdout=f)
            if p.returncode:
                raise RuntimeError("No se pudo exportar la imagen")
        image_tar.chmod(0o600)
    if ssh(state, "lab07-app-2", "sudo docker image inspect lab07-app:latest >/dev/null 2>&1 && echo ok || true") != "ok":
        scp(state, "lab07-app-2", image_tar, "lab07-app.tar.gz")
        ssh(state, "lab07-app-2", "gunzip -c lab07-app.tar.gz | sudo docker load >/dev/null")
    for index, name in enumerate(("lab07-app-1", "lab07-app-2"), 1):
        app_env = PRIVATE / f"app-{index}.env"
        env_file(app_env, {**creds, "PGHOST": state["hosts"]["lab07-db"]["private_ip"],
                           "SERVER_NAME": f"app-aws-{index}"})
        scp(state, name, app_env, "lab07-app.env")
        ssh(state, name, "chmod 600 lab07-app.env; sudo docker container inspect lab07-app >/dev/null 2>&1 || sudo docker run -d --name lab07-app --restart unless-stopped --env-file /home/ubuntu/lab07-app.env -p 3000:3000 lab07-app:latest >/dev/null")
        for _ in range(24):
            try:
                ssh(state, name, "curl -fsS http://127.0.0.1:3000/health >/dev/null")
                break
            except RuntimeError:
                time.sleep(5)
        else:
            raise RuntimeError(f"App sin health: {name}")

    print("Fase 5: ALB y Target Group", flush=True)
    if "tg_arn" not in state:
        tg = aws("elbv2", "create-target-group", "--name", "lab07-tg",
                 "--protocol", "HTTP", "--port", "3000", "--vpc-id", VPC,
                 "--target-type", "instance", "--health-check-path", "/health",
                 "--health-check-protocol", "HTTP", "--health-check-interval-seconds", "15",
                 "--healthy-threshold-count", "2", "--unhealthy-threshold-count", "2",
                 "--matcher", "HttpCode=200", "--tags", json.dumps(TAGS))["TargetGroups"][0]
        state["tg_arn"] = tg["TargetGroupArn"]
        save(state)
    aws("elbv2", "modify-target-group-attributes", "--target-group-arn", state["tg_arn"],
        "--attributes", "Key=stickiness.enabled,Value=false")
    aws("elbv2", "register-targets", "--target-group-arn", state["tg_arn"],
        "--targets", *[f"Id={state['hosts'][n]['id']},Port=3000" for n in ("lab07-app-1", "lab07-app-2")])
    if "alb_arn" not in state:
        alb = aws("elbv2", "create-load-balancer", "--name", "lab07-alb",
                  "--type", "application", "--scheme", "internet-facing",
                  "--ip-address-type", "ipv4", "--security-groups", alb_sg,
                  "--subnets", *SUBNETS, "--tags", json.dumps(TAGS))["LoadBalancers"][0]
        state["alb_arn"] = alb["LoadBalancerArn"]
        state["alb_dns"] = alb["DNSName"]
        save(state)
    if "listener_arn" not in state:
        listener = aws("elbv2", "create-listener", "--load-balancer-arn", state["alb_arn"],
                       "--protocol", "HTTP", "--port", "80", "--default-actions",
                       f"Type=forward,TargetGroupArn={state['tg_arn']}")["Listeners"][0]
        state["listener_arn"] = listener["ListenerArn"]
        save(state)
    print("ALB: http://" + state["alb_dns"], flush=True)
    print("Identificadores privados: " + str(STATE), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)
