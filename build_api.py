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
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
API = os.path.join(ROOT, "api")
FUNCS = os.path.join(ROOT, ".vercel", "output", "functions")
OUT = os.path.join(FUNCS, "api")
GATE = os.path.join(ROOT, "gate", "middleware.js")
RUNTIME = "nodejs22.x"

VC_CONFIG = {
    "runtime": RUNTIME,
    "handler": "index.js",
    "launcherType": "Nodejs",
    "shouldAddHelpers": True,
    "supportsResponseStreaming": False,
}


def needed_packages():
    """Bare-import package names the routes actually require.  The Supabase
    rewrite talks to PostgREST over plain fetch, so this is normally empty and
    each function ships as a couple of KB instead of megabytes of node_modules."""
    pkgs = set()
    for name in os.listdir(API):
        if not name.endswith(".js"):
            continue
        with open(os.path.join(API, name), encoding="utf-8") as f:
            for m in re.finditer(r"require\(['\"]([^'\"]+)['\"]\)", f.read()):
                mod = m.group(1)
                if mod.startswith(".") or mod.startswith("node:"):
                    continue
                pkgs.add("/".join(mod.split("/")[:2]) if mod.startswith("@") else mod.split("/")[0])
    return sorted(pkgs)


def ensure_deps(pkgs):
    """Install the required packages once into a cache dir we copy per function."""
    if not pkgs:
        return None
    cache = os.path.join(ROOT, ".apideps")
    os.makedirs(cache, exist_ok=True)
    if not os.path.exists(os.path.join(cache, "package.json")):
        with open(os.path.join(cache, "package.json"), "w") as f:
            json.dump({"name": "spectrawolf-api-deps", "private": True}, f)
    missing = [p for p in pkgs
               if not os.path.isdir(os.path.join(cache, "node_modules", *p.split("/")))]
    if missing:
        print(f"  installing {', '.join(missing)} …")
        subprocess.run(["npm", "install", *missing, "--silent"], cwd=cache, check=True)
    return os.path.join(cache, "node_modules")


def build_gate():
    """Emit the passcode gate as an edge middleware function.

    The whole functions/ tree is rebuilt from scratch above, so anything placed
    in the output by hand is deleted on the next build.  The gate is the one
    thing that must never silently go missing -- without it the deployment is
    open -- so it is generated here from a tracked source file like everything
    else."""
    if not os.path.exists(GATE):
        sys.exit(f"missing {GATE} -- refusing to build an ungated deployment")
    d = os.path.join(FUNCS, "_middleware.func")
    os.makedirs(d, exist_ok=True)
    shutil.copy(GATE, os.path.join(d, "index.js"))
    with open(os.path.join(d, ".vc-config.json"), "w") as f:
        json.dump({"runtime": "edge", "entrypoint": "index.js",
                   "envVarsInUse": ["SITE_PASSCODE"]}, f, indent=2)
    print("  gate      -> _middleware.func  (edge)")


def main():
    routes = sorted(n[:-3] for n in os.listdir(API)
                    if n.endswith(".js") and not n.startswith("_"))
    if not routes:
        sys.exit("no routes in api/")
    pkgs = needed_packages()
    node_modules = ensure_deps(pkgs)
    print(f"  external packages required: {', '.join(pkgs) if pkgs else 'none'}")

    shutil.rmtree(FUNCS, ignore_errors=True)
    build_gate()
    for name in routes:
        d = os.path.join(OUT, name + ".func")
        os.makedirs(d, exist_ok=True)
        shutil.copy(os.path.join(API, name + ".js"), os.path.join(d, "index.js"))
        for helper in os.listdir(API):
            if helper.startswith("_") and helper.endswith(".js"):
                shutil.copy(os.path.join(API, helper), os.path.join(d, helper))
        if node_modules:
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
