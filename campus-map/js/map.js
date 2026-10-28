const map = L.map('map', { zoomControl: true }).setView([30.76846, 76.57411], 16);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);

const layers = {};
const records = [];
const labelMarkers = L.layerGroup().addTo(map);
const palette = { building: '#dfe7eb', path: '#a86cd1', landmark: '#c54448' };

function popup(feature) {
  const props = feature.properties || {};
  const rows = Object.entries(props).filter(([key, value]) => value !== null && value !== '' && !['label', 'source'].includes(key));
  const title = props.name || (props.feature_type === 'building' ? 'UNNAMED BUILDING' : 'Unnamed feature');
  return `<strong>${title}</strong><br>${rows.map(([key, value]) => `<small><b>${key}</b>: ${value}</small>`).join('<br>')}`;
}

function named(feature) { return feature.properties && feature.properties.name; }

function representativePoint(feature) {
  const geometry = feature.geometry;
  if (geometry.type === 'Point') return geometry.coordinates;
  const ring = geometry.type === 'Polygon' ? geometry.coordinates[0] : geometry.coordinates[0][0];
  return [ring.reduce((sum, point) => sum + point[0], 0) / ring.length, ring.reduce((sum, point) => sum + point[1], 0) / ring.length];
}

function addLabels(data) {
  data.features.filter(named).forEach(feature => {
    if (feature.geometry.type !== 'Point' && feature.geometry.type !== 'Polygon') return;
    const point = representativePoint(feature);
    const marker = L.marker([point[1], point[0]], { icon: L.divIcon({ className: 'building-label', html: feature.properties.label || feature.properties.name, iconSize: null }), interactive: false });
    labelMarkers.addLayer(marker);
  });
}

function styleBuilding() { return { color: '#72838e', weight: 1, fillColor: palette.building, fillOpacity: .72 }; }

function styleRoad(feature) {
  const highway = feature.properties && feature.properties.highway;
  const major = ['trunk', 'tertiary', 'residential'].includes(highway);
  return { color: major ? '#e18b35' : '#a9b2b9', weight: major ? 3 : 1.6, opacity: major ? .9 : .72 };
}

function stylePath() { return { color: palette.path, weight: 2, dashArray: '6 5', opacity: .9 }; }
function pointLayer(feature, latlng) { return L.circleMarker(latlng, { radius: 6, color: '#9d3034', fillColor: palette.landmark, fillOpacity: .9, weight: 1 }); }

async function loadLayer(key, file, options) {
  const data = await fetch(`data/${file}`).then(response => response.json());
  if (key === 'buildings') {
    const mapping = await fetch('data/building_name_verification.json').then(response => response.json());
    data.features.forEach(feature => {
      const entry = mapping.buildings[feature.id];
      if (entry && entry.verified_name) feature.properties.name = entry.verified_name;
      if (entry) feature.properties.name_status = entry.status;
    });
  }
  const layer = L.geoJSON(data, options);
  layers[key] = layer;
  records.push(...data.features.filter(named).map(feature => ({ feature, layer })));
  addLabels(data);
  return layer;
}

Promise.all([
  loadLayer('buildings', 'buildings.geojson', { style: styleBuilding, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
  loadLayer('roads', 'roads.geojson', { style: styleRoad, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
  loadLayer('paths', 'paths.geojson', { style: stylePath, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
  loadLayer('landmarks', 'landmarks.geojson', { pointToLayer: pointLayer, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
  loadLayer('campus boundary', 'campus_boundary.geojson', { style: () => ({ color: '#d14e50', weight: 3, dashArray: '9 6', fill: false }), onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) })
]).then(() => {
  L.control.layers(null, { Buildings: layers.buildings, Roads: layers.roads, 'Walking paths': layers.paths, Landmarks: layers.landmarks, 'Campus boundary': layers['campus boundary'] }, { collapsed: false }).addTo(map);
  const boundary = layers['campus boundary'].getBounds();
  if (boundary.isValid()) map.fitBounds(boundary.pad(.08));
}).catch(error => alert(`Map data could not be loaded: ${error.message}`));

map.on('zoomend', () => labelMarkers.eachLayer(marker => marker.setOpacity(map.getZoom() >= 16 ? 1 : 0)));

document.getElementById('search').addEventListener('input', event => {
  const query = event.target.value.trim().toLowerCase();
  const resultBox = document.getElementById('results');
  resultBox.innerHTML = '';
  if (!query) { resultBox.hidden = true; return; }
  const matches = records.filter(item => item.feature.properties.name.toLowerCase().includes(query)).slice(0, 12);
  matches.forEach(item => {
    const row = document.createElement('div');
    row.className = 'result';
    row.textContent = item.feature.properties.name;
    row.onclick = () => {
      const bounds = item.layer.getBounds ? item.layer.getBounds() : null;
      if (bounds && bounds.isValid()) map.fitBounds(bounds.pad(.4));
      resultBox.hidden = true;
      event.target.value = item.feature.properties.name;
      item.layer.eachLayer(layer => { if (layer.feature === item.feature) layer.openPopup(); });
    };
    resultBox.appendChild(row);
  });
  resultBox.hidden = matches.length === 0;
});
