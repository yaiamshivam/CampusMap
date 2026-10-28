
import os
import geopandas as gpd
import matplotlib.pyplot as plt

INPUT_FILE = "export.geojson"
OUTPUT_DIR = "output"
os.makedirs(OUTPUT_DIR, exist_ok=True)

print("Loading GeoJSON...")

gdf = gpd.read_file(INPUT_FILE)
gdf = gdf[gdf.geometry.notna() & ~gdf.geometry.is_empty].copy()

if gdf.crs is None:
    print("Warning: CRS missing. Assuming WGS84 (EPSG:4326).")
    gdf = gdf.set_crs("EPSG:4326")

# Project coordinates into metres for better plotting
gdf = gdf.to_crs(gdf.estimate_utm_crs())

# Separate geometry types
polygons = gdf[gdf.geom_type.isin(["Polygon", "MultiPolygon"])]
lines = gdf[gdf.geom_type.isin(["LineString", "MultiLineString"])]
points = gdf[gdf.geom_type == "Point"]

print(f"Buildings/areas: {len(polygons)}")
print(f"Paths/lines: {len(lines)}")
print(f"Points: {len(points)}")

fig, ax = plt.subplots(figsize=(16, 16))

# Draw areas first
if not polygons.empty:
    polygons.plot(
        ax=ax,
        facecolor="#dce8f2",
        edgecolor="#526b80",
        linewidth=0.7,
        alpha=0.85,
        zorder=1
    )

# Draw lines over the areas
if not lines.empty:
    lines.plot(
        ax=ax,
        color="#e18b35",
        linewidth=2.0,
        alpha=0.95,
        zorder=3
    )

# Draw points last
if not points.empty:
    points.plot(
        ax=ax,
        color="#c62828",
        markersize=18,
        marker="o",
        zorder=4
    )

# Equal scaling and comfortable margins
xmin, ymin, xmax, ymax = gdf.total_bounds
xpad = max((xmax - xmin) * 0.04, 5)
ypad = max((ymax - ymin) * 0.04, 5)

ax.set_xlim(xmin - xpad, xmax + xpad)
ax.set_ylim(ymin - ypad, ymax + ypad)
ax.set_aspect("equal")
ax.set_axis_off()

ax.set_title(
    "CampusPath | Chandigarh University",
    fontsize=20,
    fontweight="bold",
    pad=20
)

fig.tight_layout()

output = os.path.abspath(
    os.path.join(OUTPUT_DIR, "campus_map.png")
)

fig.savefig(
    output,
    dpi=300,
    bbox_inches="tight",
    facecolor="white"
)

plt.close(fig)

print("\nNew map saved:", output)
