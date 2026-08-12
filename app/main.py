"""Berlman Spectra Digitizer — interactive web app.

Upload a fluorescence spectrum image, auto-digitize it with the Berlman
pipeline, then fine-tune by adding/erasing dots before exporting.
"""
import io, os, sys, base64, json, csv, tempfile
import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import berlman as B

app = FastAPI(title="Berlman Spectra Digitizer")
app.mount("/static", StaticFiles(directory=os.path.join(os.path.dirname(__file__), "static")), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    with open(os.path.join(os.path.dirname(__file__), "static", "index.html")) as f:
        return f.read()


@app.post("/api/digitize")
async def digitize(file: UploadFile = File(...)):
    raw = await file.read()
    arr = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        return JSONResponse({"error": "Could not decode image"}, status_code=400)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.write(raw)
    tmp.close()
    try:
        r = B.digitize(tmp.name)
    finally:
        os.unlink(tmp.name)

    fr = r["frame"]
    xcal = r.get("xcal")

    # Build curve data for the frontend
    curves = []
    for c in r["curves"]:
        px = np.asarray(c["px"]).tolist()
        py = np.asarray(c["py"]).tolist()
        role = c.get("role", "emission")

        wn = c.get("wavenumber")
        inten = c.get("intensity")
        wl = (1e7 / wn).tolist() if wn is not None else []
        inten = inten.tolist() if inten is not None else []

        curves.append({
            "role": role,
            "px": px,
            "py": py,
            "wl": wl,
            "intensity": inten,
        })

    # Downscale image for web display (max 1800px wide)
    h, w = img.shape[:2]
    scale = min(1800 / w, 1.0)
    if scale < 1.0:
        img_small = cv2.resize(img, (int(w * scale), int(h * scale)))
    else:
        img_small = img
        scale = 1.0

    _, buf = cv2.imencode(".png", img_small)
    img_b64 = base64.b64encode(buf).decode()

    mol = ""
    try:
        mol = B._ocr_name(gray, fr) or ""
    except Exception:
        pass

    m = B.evaluate(r["cmask"], B.reconstruct_mask(r["cmask"].shape, r["curves"]), fr)

    return {
        "image": img_b64,
        "width": img_small.shape[1],
        "height": img_small.shape[0],
        "scale": scale,
        "frame": {k: int(v * scale) for k, v in fr.items()},
        "frame_orig": {k: int(v) for k, v in fr.items()},
        "curves": curves,
        "molecule": mol,
        "f1": round(m["f1"], 3),
        "strategy": r.get("strategy", ""),
        "has_xcal": xcal is not None,
        "xcal": {
            "a": xcal["a"], "b": xcal["b"],
            "lo": xcal["lo"], "hi": xcal["hi"],
        } if xcal else None,
    }


@app.post("/api/export")
async def export(data: dict):
    """Export edited curves as CSV."""
    curves = data.get("curves", [])
    xcal = data.get("xcal")
    frame_orig = data.get("frame_orig", {})
    scale = data.get("scale", 1.0)

    output = io.StringIO()
    w = csv.writer(output)
    w.writerow(["curve", "role", "wavelength_nm", "intensity"])

    for i, c in enumerate(curves):
        role = c.get("role", "emission")
        px_list = c.get("px", [])
        py_list = c.get("py", [])

        yt = frame_orig.get("y_top", 0)
        yb = frame_orig.get("y_bottom", 1)

        for px, py in zip(px_list, py_list):
            real_px = px / scale
            real_py = py / scale
            intensity = (yb - real_py) / (yb - yt) if yb != yt else 0

            if xcal:
                wn = xcal["a"] * real_px + xcal["b"]
                wl = 1e7 / wn if wn > 0 else 0
            else:
                wl = 0

            w.writerow([i, role, f"{wl:.1f}", f"{intensity:.6f}"])

    output.seek(0)
    return StreamingResponse(
        io.BytesIO(output.getvalue().encode()),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=spectrum.csv"},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8770)
