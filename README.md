# CampusPath

CampusPath is an interactive Chandigarh University, Gharuan campus map for the ADSA project.

The standalone map lives in [`campus-map/`](campus-map/). Run it with:

```powershell
python -m http.server 8000 --directory campus-map
```

Open `http://127.0.0.1:8000/index.html`.

Regenerate validated layers with:

```powershell
python scripts/convert_map.py
```

The generator reads original inputs from `source-data/`, writes the standalone GeoJSON layers to `campus-map/data/`, and writes routing exports to `data/graph/`. Building names remain source-backed; unresolved footprints are documented in `campus-map/data/building_name_verification.json`.
