#!/usr/bin/env python3
"""Package api/*.js into Vercel Build Output API functions.

The site ships as a prebuilt deployment (the 114 MB of scans and overlays are
generated locally and cannot be rebuilt on Vercel), so the serverless routes
have to be assembled by hand into .vercel/output/functions/ rather than being
discovered from source.  Each route gets its own .func directory with the
handler, the shared lib, and the @vercel/blob dependency.

Usage:  python3 build_api.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
API = os.path.join(ROOT, "api")
OUT = os.path.join(ROOT, ".vercel", "output", "functions", "api")
RUNTIME = "nodejs22.x"

VC_CONFIG = {
    "runtime": RUNTIME,
    "handler": "index.js",
    "launcherType": "Nodejs",
    "shouldAddHelpers": True,
    "supportsResponseStreaming": False,
}


def ensure_deps():
    """Install @vercel/blob once into a cache dir we can copy per function."""
    cache = os.path.join(ROOT, ".apideps")
    if os.path.isdir(os.path.join(cache, "node_modules", "@vercel", "blob")):
        return os.path.join(cache, "node_modules")
    os.makedirs(cache, exist_ok=True)
    if not os.path.exists(os.path.join(cache, "package.json")):
        with open(os.path.join(cache, "package.json"), "w") as f:
            json.dump({"name": "spectrawolf-api-deps", "private": True}, f)
    print("  installing @vercel/blob …")
    subprocess.run(["npm", "install", "@vercel/blob", "--silent"],
                   cwd=cache, check=True)
    return os.path.join(cache, "node_modules")


def main():
    routes = sorted(n[:-3] for n in os.listdir(API)
                    if n.endswith(".js") and not n.startswith("_"))
    if not routes:
        sys.exit("no routes in api/")
    node_modules = ensure_deps()

    shutil.rmtree(os.path.join(ROOT, ".vercel", "output", "functions"),
                  ignore_errors=True)
    for name in routes:
        d = os.path.join(OUT, name + ".func")
        os.makedirs(d, exist_ok=True)
        shutil.copy(os.path.join(API, name + ".js"), os.path.join(d, "index.js"))
        for helper in os.listdir(API):
            if helper.startswith("_") and helper.endswith(".js"):
                shutil.copy(os.path.join(API, helper), os.path.join(d, helper))
        shutil.copytree(node_modules, os.path.join(d, "node_modules"),
                        dirs_exist_ok=True)
        with open(os.path.join(d, ".vc-config.json"), "w") as f:
            json.dump(VC_CONFIG, f, indent=2)
        size = sum(os.path.getsize(os.path.join(dp, f))
                   for dp, _, fs in os.walk(d) for f in fs)
        print(f"  /api/{name:<8} -> {name}.func  ({size / 1e6:.1f} MB)")
    print(f"built {len(routes)} functions on {RUNTIME}")


if __name__ == "__main__":
    main()
