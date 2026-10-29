"""Generate non-destructive named-feature to graph-node mappings."""

import json
from pathlib import Path

from routing import load_graph, snap_features, write_mapping

ROOT = Path(__file__).resolve().parent.parent
GRAPH_DIR = ROOT / "campus-map" / "data" / "graph"
MAP_DIR = ROOT / "campus-map" / "data"
MAX_SNAP_DISTANCE_M = 150


def read_features(name):
    return json.loads((MAP_DIR / f"{name}.geojson").read_text(encoding="utf-8"))["features"]


def main():
    nodes, _ = load_graph(GRAPH_DIR / "nodes.csv", GRAPH_DIR / "edges.csv")
    features = read_features("buildings") + read_features("landmarks")
    mappings, unmapped = snap_features(features, nodes, MAX_SNAP_DISTANCE_M)
    write_mapping(MAP_DIR / "feature_node_mapping.json", mappings, unmapped, MAX_SNAP_DISTANCE_M)
    print(json.dumps({"mapped": len(mappings), "unmapped": len(unmapped), "max_snap_distance_m": MAX_SNAP_DISTANCE_M}, indent=2))


if __name__ == "__main__":
    main()
