
import os
import osmnx as ox
import networkx as nx

# Project paths
INPUT_FILE = "map.osm"
OUTPUT_DIR = "data"

os.makedirs(OUTPUT_DIR, exist_ok=True)

print("CampusPath: Loading OpenStreetMap data...")

if not os.path.exists(INPUT_FILE):
    raise FileNotFoundError(
        f"{INPUT_FILE} not found in {os.getcwd()}"
    )

print(f"Input file size: {os.path.getsize(INPUT_FILE):,} bytes")

# Load the OSM XML file and build a graph
G = ox.graph.graph_from_xml(
    INPUT_FILE,
    bidirectional=False,
    simplify=True,
    retain_all=True
)

if G.number_of_nodes() == 0:
    raise ValueError(
        "No walkable network found. Check the OSM file contents."
    )

print(f"Graph loaded: {G.number_of_nodes()} nodes, "
      f"{G.number_of_edges()} directed edges")

# Export graph for future use
graph_path = os.path.join(OUTPUT_DIR, "campus_graph.graphml")
ox.io.save_graphml(G, graph_path)

# Export nodes and edges to CSV
nodes, edges = ox.convert.graph_to_gdfs(G)

nodes.reset_index().to_csv(
    os.path.join(OUTPUT_DIR, "nodes.csv"), index=False
)
edges.reset_index().to_csv(
    os.path.join(OUTPUT_DIR, "edges.csv"), index=False
)

# Draw the graph
fig, ax = ox.plot_graph(
    G,
    node_size=4,
    edge_linewidth=0.8,
    show=False,
    close=False
)

fig.savefig(
    os.path.join(OUTPUT_DIR, "campus_map.png"),
    dpi=200,
    bbox_inches="tight"
)

import matplotlib.pyplot as plt
plt.close(fig)

print("\nConversion completed successfully!")
print(f"Saved graph: {graph_path}")
print(f"Saved map: {OUTPUT_DIR}/campus_map.png")
print(f"Saved CSV files: {OUTPUT_DIR}/nodes.csv and edges.csv")
