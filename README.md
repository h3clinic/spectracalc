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
5. **Curve isolation** — connected-component analysis with text blob removal
6. **Multi-strategy tracing** — tries 4 strategies (single-pass, columnar scan, skeleton, seed-grow), picks best by F1 + column coverage
7. **Classification** — labels curves as emission vs. absorption by vertical position
8. **Physical conversion** — pixel coordinates to wavenumber/wavelength (nm) and normalized intensity

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
- **305/308** have emission data
- **293/308** have absorption data
- Mean digitization F1 score: **0.946**

## Dependencies

- Python 3.9+
- OpenCV, NumPy, pytesseract (+ Tesseract OCR installed)
- FastAPI, uvicorn, python-multipart (for the web app)

## Source

Berlman, I.B. *Handbook of Fluorescence Spectra of Aromatic Molecules*, 2nd Edition, Academic Press, 1971.
