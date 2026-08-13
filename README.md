# SpectraWolf Digitizer

Automated digitization of fluorescence and absorption spectra from scanned images, with an interactive web editor for human refinement.

Built to digitize all 308 spectra from Berlman's *Handbook of Fluorescence Spectra of Aromatic Molecules* (2nd Edition, 1971) at 600 DPI. The pipeline auto-detects plot frames, OCRs axis labels, isolates ink curves, traces them, and converts pixel coordinates to physical units (wavelength in nm, normalized intensity, extinction coefficients).

## What's in this repo

| Path | Description |
|------|-------------|
| `berlman.py` | Core digitization engine (~1400 lines) |
| `app/` | Interactive web app (FastAPI + canvas editor) |
| `data/spectra_all.json` | All 308 digitized spectra (wavelength, intensity, extinction) |
| `data/Berlman_Master_Index.xlsx` | Master Excel workbook with index + all emission/absorption data |
| `data/spectra/` | 308 per-compound Excel workbooks with scatter charts |
| `overlays/` | 308 validation PNGs showing digitized curves overlaid on original scans |

## Pipeline

1. **Binary thresholding** — Otsu + adaptive Gaussian fallbacks
2. **Frame detection** — locates the plot boundary (axes rectangle)
3. **X-axis calibration** — OCRs wavenumber tick labels, fits linear pixel-to-wavenumber mapping, splits merged OCR tokens
4. **Right Y-axis calibration** — OCRs molar extinction coefficient scale
5. **Page-type detection** — OCRs the plot for ABSORPTION/EMISSION labels; emission-only comparison pages (CURVE I / CURVE II) are handled separately so a second emission variant is never exported as absorption
6. **Curve isolation** — connected-component analysis with text blob removal
7. **Multi-strategy tracing** — tries 4 strategies (single-pass, columnar scan, skeleton, seed-grow), picks best by F1 + column coverage
8. **Classification** — labels curves as emission vs. absorption by position, with printed-label positions as ground truth for hard cases
9. **Refinement** — spike-aware recovery of narrow vibronic peaks (run-top representation + raw-ink bridging), swallowed-curve splitting at deep valleys on mirror-image pages, dotted overlap-tail projection, frame-top peak restoration
10. **Physical conversion** — pixel coordinates to wavenumber/wavelength (nm) and normalized intensity; every standard curve is snapped to its Berlman normalization (peak = 1.0) once the trace demonstrably reaches the ink apex

## Self-evaluation protocol

Every change to the pipeline is validated on a **fresh random sample of 40 pages (~13%)**: automated checks (calibration sanity, peak = 1.0 on both curves, role/page-type consistency, F1 ≥ 0.85) plus a per-page visual verification of the trace-on-ink overlays. The pipeline is only accepted when a fresh round comes back clean apart from the documented limitations below.

## Interactive Web App

Upload any spectrum image, auto-digitize it, then manually add or erase dots before exporting to CSV.

### Run locally

```bash
pip install -r requirements.txt
cd SpectraWolf
python -m uvicorn app.main:app --reload --port 8770
```

Open `http://localhost:8770` in your browser.

### Controls

| Action | How |
|--------|-----|
| Upload | Drag-and-drop or click "Upload Image" |
| Add dots | Press `1` or click "Add Dots", then click on the canvas |
| Erase dots | Press `2` or click "Erase Dots", then click near a dot |
| Pan | Press `3` or click "Pan", then drag |
| Zoom | Scroll wheel, or `+` / `-` keys |
| Switch curve | Press `E` (emission) or `A` (absorption) |
| Undo | `Ctrl+Z` or click "Undo" |
| Export | Click "Export CSV" |

## Coverage

- **306/308** pages have successful x-axis calibration (2 pages have severely garbled OCR)
- **306/308** have emission data — **every one with its peak at exactly 1.0** (Berlman normalization)
- **286/308** have absorption data (282 with peak at exactly 1.0); 19 pages are emission-only
  CURVE I / CURVE II comparison plots that genuinely have no absorption panel — earlier versions
  wrongly exported their second emission variant as absorption
- **18** secondary emission variants (curve II) captured separately as `em2`
- Mean digitization F1 score: **0.973** (median 0.989)

## Known limitations

| Pages | Issue |
|-------|-------|
| graph-289, graph-291 | x-axis tick OCR too garbled to calibrate — no exported data |
| graph-396 (chrysene) | emission and absorption 0-0 bands coincide at the same wavelength; absorption is not exported rather than exporting a wrong split |
| graph-235, 328, 342, 427 | absorption peak below 1.0 — part of a complex vibronic structure remains untraced |
| a few pages (e.g. graph-142, 290, 355) | the short dotted overlap tail where the curves cross is left untraced |

These pages are the intended use case for the interactive editor: load the page, add/erase dots by hand, export.

## Dependencies

- Python 3.9+
- OpenCV, NumPy, pytesseract (+ Tesseract OCR installed)
- FastAPI, uvicorn, python-multipart (for the web app)

## Source

Berlman, I.B. *Handbook of Fluorescence Spectra of Aromatic Molecules*, 2nd Edition, Academic Press, 1971.
