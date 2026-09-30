#!/usr/bin/env python3
"""Comprueba el flujo web del ALB sin mostrar credenciales ni cookies."""
import http.cookiejar
import json
import pathlib
import re
import sys
import time
import urllib.parse
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[2]
STATE = json.loads((ROOT / ".local/aws/inventory.json").read_text())
CREDS = dict(line.split("=", 1) for line in (ROOT / ".local/aws/credentials.env").read_text().splitlines())
BASE = "http://" + STATE["alb_dns"]
JAR = http.cookiejar.CookieJar()
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(JAR), urllib.request.ProxyHandler({}))


def request(path, values=None):
    data = urllib.parse.urlencode(values).encode() if values is not None else None
    with OPENER.open(BASE + path, data=data, timeout=10) as response:
        return response.status, response.headers.get("X-Backend", ""), response.read().decode()


def csrf(html):
    found = re.search(r'name="_csrf" value="([^"]+)"', html)
    if not found:
        raise RuntimeError("Falta CSRF")
    return found.group(1)


def main():
    for attempt in range(12):
        try:
            status, backend, body = request("/health")
            if status == 200:
                break
        except Exception:
            time.sleep(5)
    else:
        raise RuntimeError("ALB /health no respondió en 60 s")
    print("health=200", flush=True)
    status, backend, body = request("/products")
    if status != 200 or "Iniciar sesión" not in body:
        raise RuntimeError("/products no redirigió al login")
    print("products_anon=login", flush=True)
    status, backend, body = request("/login")
    status, backend, body = request("/login", {"_csrf": csrf(body), "username": "ortiz", "password": CREDS["ADMIN_PASSWORD"]})
    if status != 200 or "Sesión de <strong>ortiz</strong>" not in body:
        raise RuntimeError("Login falló")
    print("login=ok", flush=True)
    seen = {backend}
    for _ in range(20):
        status, backend, body = request("/products")
        if status != 200 or "Sesión de <strong>ortiz</strong>" not in body:
            raise RuntimeError("Sesión no compartida")
        seen.add(backend)
        if len(seen) == 2:
            break
    print("session_backends=" + ",".join(sorted(seen)), flush=True)
    name = "Prueba AWS Ortiz " + str(int(time.time()))
    request("/products", {"_csrf": csrf(body), "name": name, "price": "12.50", "stock": "2"})
    status, backend, body = request("/products")
    row = next((r for r in re.findall(r"<tr>(.*?)</tr>", body, re.S) if name in r), None)
    if not row or "12.50" not in row or ">2<" not in row:
        raise RuntimeError("Create/read falló")
    product_id = re.search(r"/products/(\d+)/edit", row).group(1)
    print("crud_create_read=ok", flush=True)
    status, backend, edit_page = request(f"/products/{product_id}/edit")
    request(f"/products/{product_id}/edit", {"_csrf": csrf(edit_page), "name": name, "price": "14.50", "stock": "3"})
    status, backend, body = request("/products")
    row = next((r for r in re.findall(r"<tr>(.*?)</tr>", body, re.S) if name in r), None)
    if not row or "14.50" not in row or ">3<" not in row:
        raise RuntimeError("Update falló")
    print("crud_update=ok", flush=True)
    request(f"/products/{product_id}/delete", {"_csrf": csrf(body)})
    status, backend, body = request("/products")
    if name in body:
        raise RuntimeError("Delete falló")
    print("crud_delete=ok", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print("ERROR: " + str(e), file=sys.stderr)
        sys.exit(1)
