import csv
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "source-data"
MAP_DATA_DIR = ROOT / "campus-map" / "data"
GRAPH_DIR = ROOT / "data" / "graph"
INPUT_FILE = SOURCE_DIR / "map.osm"


def tags(element):
    return {item.get("k"): item.get("v") for item in element.findall("tag")}


def coords(element):
    return [float(element.get("lon")), float(element.get("lat"))]


def valid_ring(points):
    if len(points) < 3:
        return None
    if points[0] != points[-1]:
        points = points + [points[0]]
    return points if len(set(map(tuple, points))) >= 3 else None


def feature(identifier, geometry, properties):
    return {"type": "Feature", "id": identifier, "geometry": geometry, "properties": properties}


def collection(name, features):
    return {"type": "FeatureCollection", "name": name, "features": features}


def save_json(path, value):
    path.write_text(json.dumps(value, indent=2), encoding="utf-8")


def distance(first, second):
    radius = 6371008.8
    lat1, lon1 = math.radians(first[1]), math.radians(first[0])
    lat2, lon2 = math.radians(second[1]), math.radians(second[0])
    dlat, dlon = lat2 - lat1, lon2 - lon1
    value = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(value))


def center(points):
    return [sum(point[0] for point in points) / len(points), sum(point[1] for point in points) / len(points)]


def existing_boundary():
    source = SOURCE_DIR / "export.geojson"
    if not source.exists():
        return []
    data = json.loads(source.read_text(encoding="utf-8"))
    result = []
    for item in data.get("features", []):
        if item.get("properties", {}).get("name") == "Chandigarh University" and item.get("geometry", {}).get("type") in {"Polygon", "MultiPolygon"}:
            result.append(feature(item.get("id", "campus-boundary"), item["geometry"], {"name": "Chandigarh University Campus", "feature_type": "campus_boundary", "source": "Existing campus extract"}))
    return result


def main():
    if not INPUT_FILE.exists():
        raise FileNotFoundError(INPUT_FILE)
    MAP_DATA_DIR.mkdir(parents=True, exist_ok=True)
    GRAPH_DIR.mkdir(parents=True, exist_ok=True)
    root = ET.parse(INPUT_FILE).getroot()
    nodes = {item.get("id"): coords(item) for item in root.findall("node")}
    node_tags = {item.get("id"): tags(item) for item in root.findall("node") if item.findall("tag")}
    ways = {}
    for item in root.findall("way"):
        ways[item.get("id")] = {"id": item.get("id"), "refs": [nd.get("ref") for nd in item.findall("nd")], "tags": tags(item)}

    relation_members = set()
    buildings = []
    for item in root.findall("relation"):
        relation_tags = tags(item)
        if not (relation_tags.get("building") and relation_tags.get("type") == "multipolygon"):
            continue
        rings = []
        for member in item.findall("member"):
            if member.get("type") != "way" or member.get("role") not in {"outer", ""}:
                continue
            way_id = member.get("ref")
            relation_members.add(way_id)
            points = [nodes[ref] for ref in ways.get(way_id, {}).get("refs", []) if ref in nodes]
            ring = valid_ring(points)
            if ring:
                rings.append(ring)
        if rings:
            buildings.append(feature(f"relation/{item.get('id')}", {"type": "MultiPolygon", "coordinates": [[ring for ring in rings]]}, {"name": relation_tags.get("name"), "feature_type": "building", "building": relation_tags.get("building"), "source_id": item.get("id")}))

    roads, paths, landmarks, graph_edges = [], [], [], []
    graph_nodes = set()
    skipped_buildings = 0
    path_values = {"footway", "path", "pedestrian", "steps", "cycleway"}
    for way in ways.values():
        way_tags = way["tags"]
        points = [nodes[ref] for ref in way["refs"] if ref in nodes]
        if not points:
            continue
        common = {"name": way_tags.get("name"), "source_id": way["id"], "highway": way_tags.get("highway"), "oneway": way_tags.get("oneway"), "service": way_tags.get("service")}
        if way_tags.get("building") and way["id"] not in relation_members:
            ring = valid_ring(points)
            if ring:
                buildings.append(feature(f"way/{way['id']}", {"type": "Polygon", "coordinates": [ring]}, {**common, "feature_type": "building", "building": way_tags.get("building")}))
            else:
                skipped_buildings += 1
        highway = way_tags.get("highway")
        if highway and len(points) >= 2:
            item = feature(f"way/{way['id']}", {"type": "LineString", "coordinates": points}, {**common, "feature_type": "path" if highway in path_values else "road"})
            (paths if highway in path_values else roads).append(item)
            graph_nodes.update(way["refs"])
            for first, second in zip(way["refs"], way["refs"][1:]):
                if first in nodes and second in nodes:
                    graph_edges.append({"u": first, "v": second, "key": 0, "osmid": way["id"], "highway": highway, "name": way_tags.get("name", ""), "oneway": way_tags.get("oneway", ""), "length": distance(nodes[first], nodes[second]), "geometry": f"LINESTRING ({nodes[first][0]} {nodes[first][1]}, {nodes[second][0]} {nodes[second][1]})"})
        if way_tags.get("name") and (way_tags.get("amenity") or way_tags.get("leisure") or way_tags.get("landuse")) and len(points) >= 3:
            landmarks.append(feature(f"way/{way['id']}", {"type": "Point", "coordinates": center(points)}, {"name": way_tags["name"], "feature_type": "landmark", "amenity": way_tags.get("amenity"), "leisure": way_tags.get("leisure"), "landuse": way_tags.get("landuse"), "source_id": way["id"]}))
    for node_id, node_data in node_tags.items():
        if node_data.get("name") and node_id in nodes:
            landmarks.append(feature(f"node/{node_id}", {"type": "Point", "coordinates": nodes[node_id]}, {"name": node_data["name"], "feature_type": "landmark", "amenity": node_data.get("amenity"), "leisure": node_data.get("leisure"), "building": node_data.get("building"), "source_id": node_id}))

    save_json(MAP_DATA_DIR / "buildings.geojson", collection("CampusPath Buildings", buildings))
    save_json(MAP_DATA_DIR / "roads.geojson", collection("CampusPath Roads", roads))
    save_json(MAP_DATA_DIR / "paths.geojson", collection("CampusPath Walking Paths", paths))
    save_json(MAP_DATA_DIR / "landmarks.geojson", collection("CampusPath Landmarks", landmarks))
    save_json(MAP_DATA_DIR / "campus_boundary.geojson", collection("CampusPath Campus Boundary", existing_boundary()))

    with (GRAPH_DIR / "nodes.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["osmid", "y", "x", "geometry"])
        for node_id in sorted(graph_nodes):
            lon, lat = nodes[node_id]
            writer.writerow([node_id, lat, lon, f"POINT ({lon} {lat})"])
    with (GRAPH_DIR / "edges.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=["u", "v", "key", "osmid", "highway", "name", "oneway", "length", "geometry"])
        writer.writeheader()
        writer.writerows(graph_edges)
    graphml = ET.Element("graphml", {"xmlns": "http://graphml.graphdrawing.org/xmlns"})
    graph = ET.SubElement(graphml, "graph", {"id": "CampusPath", "edgedefault": "directed"})
    for node_id in sorted(graph_nodes):
        lon, lat = nodes[node_id]
        node = ET.SubElement(graph, "node", {"id": str(node_id)})
        ET.SubElement(node, "data", {"key": "x"}).text = str(lon)
        ET.SubElement(node, "data", {"key": "y"}).text = str(lat)
    for index, edge in enumerate(graph_edges):
        graph_edge = ET.SubElement(graph, "edge", {"id": f"e{index}", "source": str(edge["u"]), "target": str(edge["v"])})
        ET.SubElement(graph_edge, "data", {"key": "length"}).text = str(edge["length"])
        ET.SubElement(graph_edge, "data", {"key": "highway"}).text = edge["highway"]
        ET.SubElement(graph_edge, "data", {"key": "name"}).text = edge["name"]
    ET.ElementTree(graphml).write(GRAPH_DIR / "campus_graph.graphml", encoding="utf-8", xml_declaration=True)
    summary = {"buildings": len(buildings), "roads": len(roads), "paths": len(paths), "landmarks": len(landmarks), "graph_nodes": len(graph_nodes), "graph_edges": len(graph_edges), "skipped_invalid_buildings": skipped_buildings}
    (GRAPH_DIR / "conversion_summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
