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

The generator reads original inputs from `source-data/`, writes the standalone GeoJSON layers and routing exports to `campus-map/data/`. Building names remain source-backed; unresolved footprints are documented in `campus-map/data/building_name_verification.json`.

Regenerate feature-to-node mappings with:

```powershell
python scripts/build_feature_node_mapping.py
```

Run the automated routing tests with:

```powershell
python -m unittest discover -s tests -v
```

The graph audit and limitations are documented in [`docs/graph-audit.md`](docs/graph-audit.md).
