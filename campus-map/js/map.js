const map = L.map('map', { zoomControl: true }).setView([30.76846, 76.57411], 16);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const layers = {};
const records = [];
const destinationLayer = L.layerGroup().addTo(map);
const sourceLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const graph = { nodes: new Map(), adjacency: new Map() };
let featureMapping = new Map();
let campusBoundaryGeometry = null;
let selectedSource = null;
let selectedDestination = null;
const palette = { building: '#dfe7eb', path: '#a86cd1', landmark: '#c54448' };
const GPS_MAX_SNAP_DISTANCE_M = 150;
const GPS_MAX_ACCURACY_M = 100;
const WALKING_SPEED_MPS = 1.4;
const navigation = {
    active: false,
    watchId: null,
    lastNode: null,
    lastRoutePosition: null,
    lastRecalculation: 0,
    locationMarker: null,
    accuracyCircle: null
};

function popup(feature) {
    const props = feature.properties || {};
    const rows = Object.entries(props).filter(([key, value]) => value !== null && value !== '' && !['label', 'source'].includes(key));
    const title = props.name || (props.feature_type === 'building' ? 'UNNAMED BUILDING' : 'Unnamed feature');
    return `<strong>${title}</strong><br>` + rows.map(([key, value]) => `<small><b>${key}</b>: ${value}</small>`).join('<br>');
}

function named(feature) {
    return Boolean(feature.properties && typeof feature.properties.name === 'string' && feature.properties.name.trim());
}

function pointInRing(point, ring) {
    const [longitude, latitude] = point;
    let inside = false;
    for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
        const [currentLon, currentLat] = ring[index];
        const [previousLon, previousLat] = ring[previous];
        const crosses = (currentLat > latitude) !== (previousLat > latitude);
        if (crosses && longitude < ((previousLon - currentLon) * (latitude - currentLat)) / (previousLat - currentLat) + currentLon) inside = !inside;
    }
    return inside;
}

function pointInBoundary(point, geometry) {
    if (!geometry) return null;
    if (geometry.type === 'Polygon') return pointInRing(point, geometry.coordinates[0]);
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.some(polygon => pointInRing(point, polygon[0]));
    return null;
}

function pointToSegmentMeters(point, start, end) {
    const scale = Math.cos(point.lat * Math.PI / 180);
    const x = (point.lon - start[0]) * scale;
    const y = point.lat - start[1];
    const dx = (end[0] - start[0]) * scale;
    const dy = end[1] - start[1];
    const denominator = dx * dx + dy * dy;
    const ratio = denominator ? Math.max(0, Math.min(1, (x * dx + y * dy) / denominator)) : 0;
    return haversineMeters(point, { lon: start[0] + (end[0] - start[0]) * ratio, lat: start[1] + (end[1] - start[1]) * ratio });
}

function distanceToBoundaryMeters(point, geometry) {
    if (!geometry) return Infinity;
    const rings = geometry.type === 'Polygon' ? geometry.coordinates : geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : [];
    let nearest = Infinity;
    rings.forEach(ring => ring.forEach((vertex, index) => { nearest = Math.min(nearest, pointToSegmentMeters(point, vertex, ring[(index + 1) % ring.length])); }));
    return nearest;
}

function classifyCampusLocation(latitude, longitude, accuracy) {
    const inside = pointInBoundary([longitude, latitude], campusBoundaryGeometry);
    if (inside === null || !Number.isFinite(accuracy) || accuracy > GPS_MAX_ACCURACY_M) return 'uncertain';
    if (distanceToBoundaryMeters({ lat: latitude, lon: longitude }, campusBoundaryGeometry) <= accuracy) return 'uncertain';
    return inside ? 'inside' : 'outside';
}

function representativePoint(feature) {
    if (feature.geometry.type === 'Point') return feature.geometry.coordinates;
    const bounds = L.geoJSON(feature).getBounds();
    return bounds.isValid() ? [bounds.getCenter().lng, bounds.getCenter().lat] : null;
}

function styleBuilding() { return { color: '#72838e', weight: 1, fillColor: palette.building, fillOpacity: 0.72 }; }

function styleRoad(feature) {
    const major = ['trunk', 'tertiary', 'residential'].includes(feature.properties?.highway);
    return { color: major ? '#e18b35' : '#a9b2b9', weight: major ? 3 : 1.6, opacity: major ? 0.9 : 0.72 };
}

function stylePath() { return { color: palette.path, weight: 2, dashArray: '6 5', opacity: 0.9 }; }

function pointLayer(feature, latlng) { return L.circleMarker(latlng, { radius: 6, color: '#9d3034', fillColor: palette.landmark, fillOpacity: 0.9, weight: 1 }); }

function parseCsv(text) {
    const rows = []; let row = [], value = '', quoted = false;
    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === '"' && text[i + 1] === '"' && quoted) { value += '"'; i += 1; }
        else if (char === '"') quoted = !quoted;
        else if (char === ',' && !quoted) { row.push(value); value = ''; }
        else if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && text[i + 1] === '\n') i += 1;
            row.push(value); value = ''; if (row.some(cell => cell !== '')) rows.push(row); row = [];
        } else value += char;
    }
    if (value || row.length) { row.push(value); rows.push(row); }
    const headers = rows.shift();
    return rows.map(cells => Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ''])));
}

async function loadLayer(key, file, options) {
    const response = await fetch(`data/${file}`);
    if (!response.ok) throw new Error(`Could not load ${file}: HTTP ${response.status}`);
    const data = await response.json();
    if (key === 'buildings') data.features.forEach(feature => {
        const entry = featureMapping.get(feature.id);
        if (entry?.verified_name) feature.properties.name = entry.verified_name;
        if (entry) feature.properties.name_status = entry.status;
    });
    if (key === 'campus boundary' && data.features[0]) campusBoundaryGeometry = data.features[0].geometry;
    const layer = L.geoJSON(data, options);
    layers[key] = layer;
    records.push(...data.features.filter(named).map(feature => ({ feature, layer })));
    return layer;
}

async function loadGraph() {
    const [nodesResponse, edgesResponse, mappingResponse] = await Promise.all([fetch('data/graph/nodes.csv'), fetch('data/graph/edges.csv'), fetch('data/feature_node_mapping.json')]);
    if (!nodesResponse.ok || !edgesResponse.ok || !mappingResponse.ok) throw new Error('Graph or feature mapping data could not be loaded');
    parseCsv(await nodesResponse.text()).forEach(row => graph.nodes.set(row.osmid, { lat: Number(row.y), lon: Number(row.x) }));
    graph.nodes.forEach((_, id) => graph.adjacency.set(id, []));
    parseCsv(await edgesResponse.text()).forEach(row => {
        if (!graph.nodes.has(row.u) || !graph.nodes.has(row.v)) return;
        const edge = { to: row.v, length: Number(row.length), highway: row.highway };
        graph.adjacency.get(row.u).push(edge);
        if (!['yes', 'true', '1'].includes(row.oneway.toLowerCase())) graph.adjacency.get(row.v).push({ to: row.u, length: edge.length, highway: row.highway });
        const pedestrianHighways = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'service', 'residential', 'unclassified', 'track', 'tertiary']);
        if (pedestrianHighways.has(row.highway)) {
            graph.suitableNodes ??= new Set();
            graph.suitableNodes.add(row.u); graph.suitableNodes.add(row.v);
        }
    });
    featureMapping = new Map((await mappingResponse.json()).features.map(entry => [entry.feature_id, entry]));
}

function dijkstra(start, goal) {
    const queue = [[0, start]], distances = new Map([[start, 0]]), previous = new Map();
    while (queue.length) {
        queue.sort((a, b) => a[0] - b[0]); const [distance, node] = queue.shift();
        if (distance !== distances.get(node)) continue;
        if (node === goal) break;
        for (const edge of graph.adjacency.get(node) || []) {
            const candidate = distance + edge.length;
            if (candidate < (distances.get(edge.to) ?? Infinity)) { distances.set(edge.to, candidate); previous.set(edge.to, node); queue.push([candidate, edge.to]); }
        }
    }
    if (!distances.has(goal)) return null;
    const nodes = [goal]; while (nodes[0] !== start) nodes.unshift(previous.get(nodes[0]));
    return { nodes, distance: distances.get(goal) };
}

function bfs(start, goal) {
    const queue = [start], previous = new Map([[start, null]]);
    for (const node of queue) { if (node === goal) break; for (const edge of graph.adjacency.get(node) || []) if (!previous.has(edge.to)) { previous.set(edge.to, node); queue.push(edge.to); } }
    if (!previous.has(goal)) return null;
    const nodes = [goal]; while (nodes[0] !== start) nodes.unshift(previous.get(nodes[0]));
    let distance = 0; for (let i = 0; i < nodes.length - 1; i += 1) distance += (graph.adjacency.get(nodes[i]).find(edge => edge.to === nodes[i + 1]) || { length: 0 }).length;
    return { nodes, distance, edges: nodes.length - 1 };
}

function haversineMeters(first, second) {
    const radius = 6371008.8;
    const toRadians = value => value * Math.PI / 180;
    const lat1 = toRadians(first.lat), lat2 = toRadians(second.lat);
    const dLat = lat2 - lat1;
    const dLon = toRadians(second.lon - first.lon);
    const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 2 * radius * Math.asin(Math.sqrt(value));
}

function snapGpsToNode(latitude, longitude) {
    const point = { lat: latitude, lon: longitude };
    let nearest = null;
    for (const nodeId of graph.suitableNodes || []) {
        const node = graph.nodes.get(nodeId);
        if (!node || !(graph.adjacency.get(nodeId)?.length)) continue;
        const distance = haversineMeters(point, node);
        if (!nearest || distance < nearest.distance) nearest = { nodeId, distance };
    }
    if (!nearest || nearest.distance > GPS_MAX_SNAP_DISTANCE_M) return null;
    return nearest;
}

function mappingFor(feature) { return feature?.id ? featureMapping.get(feature.id) : null; }

function selectCurrentLocationSource() {
    selectedSource = { kind: 'current-location', properties: { name: 'Current Location' } };
    document.getElementById('source-search').value = 'Current Location';
    document.getElementById('source-results').hidden = true;
    if (navigation.active && navigation.lastNode) displayRoute();
    else document.getElementById('route-status').textContent = navigation.locationMarker ? 'Current Location selected. Start Navigation to verify the live position and calculate a campus route.' : 'Current Location selected. Start Navigation to request GPS and calculate a campus route.';
}

function formatDistance(distance) {
    return distance < 1000 ? `${distance.toFixed(1)} m` : `${(distance / 1000).toFixed(2)} km`;
}

function displayNavigationRoute(startNode) {
    routeLayer.clearLayers();
    const status = document.getElementById('route-status');
    const destinationMapping = selectedDestination && mappingFor(selectedDestination);
    if (!destinationMapping) { status.textContent = 'The selected destination has no verified graph-node mapping.'; return false; }
    const result = dijkstra(startNode, destinationMapping.node_id);
    if (!result) { status.textContent = 'No safe route exists from your current graph component to this destination.'; return false; }
    const latlngs = result.nodes.map(id => [graph.nodes.get(id).lat, graph.nodes.get(id).lon]);
    L.polyline(latlngs, { color: '#1769aa', weight: 7, opacity: 0.95 }).addTo(routeLayer);
    const minutes = result.distance / WALKING_SPEED_MPS / 60;
    status.textContent = `Navigation route: ${formatDistance(result.distance)} · about ${Math.max(1, Math.round(minutes))} min at ${WALKING_SPEED_MPS} m/s`;
    return true;
}

function updateLocationMarker(position, acceptedForRouting = false) {
    const latlng = [position.coords.latitude, position.coords.longitude];
    const accuracy = Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null;
    if (!navigation.locationMarker) {
        navigation.locationMarker = L.circleMarker(latlng, { radius: 9, color: acceptedForRouting ? '#073b6b' : '#8a5a00', weight: 3, fillColor: acceptedForRouting ? '#2b9de8' : '#f0b15a', fillOpacity: 1 }).bindTooltip('', { permanent: false });
        navigation.locationMarker.addTo(map);
        if (accuracy !== null) navigation.accuracyCircle = L.circle(latlng, { radius: accuracy, color: '#2b9de8', fillColor: '#2b9de8', fillOpacity: 0.12, weight: 1 }).addTo(map);
    } else {
        navigation.locationMarker.setLatLng(latlng);
        if (accuracy !== null && navigation.accuracyCircle) navigation.accuracyCircle.setLatLng(latlng).setRadius(accuracy);
    }
    navigation.locationMarker.setStyle({ color: acceptedForRouting ? '#073b6b' : '#8a5a00', fillColor: acceptedForRouting ? '#2b9de8' : '#f0b15a' });
    navigation.locationMarker.setTooltipContent(acceptedForRouting ? 'Your location · accepted for campus routing' : 'Your raw GPS location · not accepted for campus routing');
    return latlng;
}

function updateGpsStatus(message, accuracy, acceptedForRouting) {
    const accuracyText = Number.isFinite(accuracy) ? `${Math.round(accuracy)} m accuracy` : 'accuracy unavailable';
    document.getElementById('gps-status').textContent = `GPS status: ${message} · ${accuracyText} · routing ${acceptedForRouting ? 'accepted' : 'not accepted'}.`;
}

function handleGpsPosition(position) {
    if (!navigation.active) return;
    const latitude = Number(position.coords.latitude);
    const longitude = Number(position.coords.longitude);
    const accuracy = Number(position.coords.accuracy);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        console.warn('CampusPath geolocation returned invalid coordinates; marker was not updated.');
        document.getElementById('route-status').textContent = 'GPS returned an invalid location. Waiting for another fix.';
        document.getElementById('retry-location').hidden = false;
        return;
    }
    console.info('CampusPath GPS fix received', { accuracy_m: Number.isFinite(accuracy) ? Math.round(accuracy) : null });
    const firstFix = !navigation.locationMarker;
    const latlng = updateLocationMarker(position, false);
    if (firstFix) map.setView(latlng, 15);
    const status = document.getElementById('route-status');
    if (!Number.isFinite(accuracy) || accuracy > GPS_MAX_ACCURACY_M) {
        const message = 'GPS accuracy is too low to determine whether you are inside campus. Waiting for a more accurate location.';
        routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
        status.textContent = message;
        updateGpsStatus('Fix received but too inaccurate for campus classification', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    const campusState = classifyCampusLocation(latitude, longitude, accuracy);
    if (campusState === 'uncertain') {
        routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
        status.textContent = 'Checking your location accuracy near the campus boundary. Waiting for a clearer fix before routing.';
        updateGpsStatus('Boundary overlap is uncertain', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    if (campusState === 'outside') {
        routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
        status.textContent = 'You appear to be outside Chandigarh University campus. Campus navigation is available only within the campus.';
        updateGpsStatus('Fix is outside the verified campus boundary', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    const snapped = snapGpsToNode(latitude, longitude);
    if (!snapped) {
        status.textContent = `GPS location acquired (${Math.round(accuracy)} m accuracy), but it is more than ${GPS_MAX_SNAP_DISTANCE_M} m from a suitable campus graph node. Your marker remains visible; no campus route was created.`;
        updateGpsStatus('Inside boundary, but no suitable graph node was found', accuracy, false);
        document.getElementById('retry-location').hidden = false;
        return;
    }
    updateLocationMarker(position, true);
    updateGpsStatus('Fix is inside the verified campus boundary', accuracy, true);
    const now = Date.now();
    const movedEnough = !navigation.lastRoutePosition || haversineMeters({ lat: latlng[0], lon: latlng[1] }, { lat: navigation.lastRoutePosition[0], lon: navigation.lastRoutePosition[1] }) >= 20;
    const canRecalculate = !navigation.lastNode || (snapped.nodeId !== navigation.lastNode && movedEnough && now - navigation.lastRecalculation >= 5000);
    if (canRecalculate) {
        navigation.lastNode = snapped.nodeId;
        navigation.lastRoutePosition = latlng;
        navigation.lastRecalculation = now;
        if (!displayNavigationRoute(snapped.nodeId)) document.getElementById('retry-location').hidden = false;
        else document.getElementById('retry-location').hidden = true;
    }
}

function handleGeoError(error) {
    const messages = { 1: 'Location permission was denied. Allow location access and retry GPS.', 2: 'Your location is currently unavailable. Check device location services and retry GPS.', 3: 'GPS timed out. Retry GPS when you have a clearer signal.' };
    console.warn('CampusPath geolocation error', { code: error?.code ?? null, message: error?.message ?? 'unknown geolocation error' });
    const message = messages[error.code] || 'Could not obtain your location. Retry GPS.';
    routeLayer.clearLayers(); navigation.lastNode = null; navigation.lastRoutePosition = null;
    document.getElementById('route-status').textContent = message;
    updateGpsStatus(message, null, false);
    document.getElementById('retry-location').hidden = false;
}

function stopNavigation() {
    if (navigation.watchId !== null) navigator.geolocation.clearWatch(navigation.watchId);
    navigation.active = false; navigation.watchId = null; navigation.lastNode = null; navigation.lastRoutePosition = null; navigation.lastRecalculation = 0;
    if (navigation.locationMarker) map.removeLayer(navigation.locationMarker);
    if (navigation.accuracyCircle) map.removeLayer(navigation.accuracyCircle);
    navigation.locationMarker = null; navigation.accuracyCircle = null; routeLayer.clearLayers();
    document.getElementById('navigation-controls').hidden = true;
    document.getElementById('start-navigation').hidden = !selectedDestination || !mappingFor(selectedDestination);
    document.getElementById('route-status').textContent = selectedDestination ? 'Navigation stopped. Choose Start Navigation to request GPS again.' : 'Choose a start and destination to calculate a route.';
}

function startNavigation() {
    if (!selectedDestination || !mappingFor(selectedDestination)) { document.getElementById('route-status').textContent = 'Select a destination with a verified graph mapping first.'; return; }
    if (selectedSource && selectedSource.kind !== 'current-location') { document.getElementById('route-status').textContent = 'Select Current Location as the start for live GPS navigation.'; return; }
    if (!selectedSource) selectCurrentLocationSource();
    if (!navigator.geolocation) { document.getElementById('route-status').textContent = 'This browser does not provide geolocation.'; return; }
    const allowedLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
    if (!window.isSecureContext && !allowedLocalhost) { document.getElementById('route-status').textContent = 'GPS requires HTTPS or localhost. Open CampusPath from a secure local server.'; return; }
    if (navigation.watchId !== null) navigator.geolocation.clearWatch(navigation.watchId);
    navigation.active = true; navigation.watchId = null; navigation.lastNode = null; navigation.lastRoutePosition = null; navigation.lastRecalculation = 0;
    document.getElementById('start-navigation').hidden = true; document.getElementById('navigation-controls').hidden = false; document.getElementById('retry-location').hidden = true;
    document.getElementById('route-status').textContent = 'Requesting your current location…';
    updateGpsStatus('Acquiring location', null, false);
    try {
        navigation.watchId = navigator.geolocation.watchPosition(handleGpsPosition, handleGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
        console.info('CampusPath GPS watcher started', { watcher_started: true });
        navigator.geolocation.getCurrentPosition(handleGpsPosition, handleGeoError, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    } catch (error) {
        console.error('CampusPath could not start geolocation', error);
        handleGeoError({ code: 2, message: error.message });
    }
}

function retryNavigation() {
    if (navigation.active) stopNavigation();
    startNavigation();
}

function recenterLocation() {
    if (navigation.locationMarker) map.setView(navigation.locationMarker.getLatLng(), Math.max(map.getZoom(), 17));
    else document.getElementById('route-status').textContent = 'Waiting for a GPS fix. Keep navigation active or use Retry GPS.';
}

function setFeatureMarker(feature, type) {
    const point = representativePoint(feature); if (!point) return;
    const targetLayer = type === 'source' ? sourceLayer : destinationLayer; targetLayer.clearLayers();
    const marker = L.circleMarker([point[1], point[0]], { radius: 10, color: type === 'source' ? '#245c8c' : '#17324d', weight: 3, fillColor: type === 'source' ? '#66b3e6' : '#f0b15a', fillOpacity: 1 });
    marker.bindTooltip(feature.properties.name, { permanent: true, direction: 'top', offset: [0, -10], className: 'destination-label' });
    marker.bindPopup(popup(feature)); targetLayer.addLayer(marker);
}

function displayRoute() {
    routeLayer.clearLayers(); const status = document.getElementById('route-status');
    if (navigation.active && navigation.lastNode) { displayNavigationRoute(navigation.lastNode); return; }
    if (!selectedSource || !selectedDestination) { status.textContent = 'Choose a start and destination to calculate a route.'; return; }
    if (selectedSource.kind === 'current-location') { status.textContent = 'Current Location selected. Start Navigation to verify your position before routing.'; return; }
    const sourceMapping = mappingFor(selectedSource), destinationMapping = mappingFor(selectedDestination);
    if (!sourceMapping || !destinationMapping) { status.textContent = 'A selected feature has no verified graph-node mapping.'; return; }
    const algorithm = document.getElementById('route-algorithm').value;
    const result = algorithm === 'bfs' ? bfs(sourceMapping.node_id, destinationMapping.node_id) : dijkstra(sourceMapping.node_id, destinationMapping.node_id);
    if (!result) { status.textContent = 'No route exists between these graph components.'; return; }
    const latlngs = result.nodes.map(id => [graph.nodes.get(id).lat, graph.nodes.get(id).lon]);
    L.polyline(latlngs, { color: '#1769aa', weight: 6, opacity: 0.9 }).addTo(routeLayer); map.fitBounds(L.latLngBounds(latlngs).pad(0.12));
    status.textContent = `${algorithm === 'bfs' ? 'BFS' : 'Dijkstra'} route: ${result.distance < 1000 ? `${result.distance.toFixed(1)} m` : `${(result.distance / 1000).toFixed(2)} km`}${result.edges ? ` · ${result.edges} edges` : ''}`;
}

function selectFeature(item, type) {
    if (type === 'source') {
        if (navigation.active) stopNavigation();
        selectedSource = item.feature; setFeatureMarker(item.feature, 'source');
    }
    else {
        selectedDestination = item.feature; setFeatureMarker(item.feature, 'destination');
        const hasMapping = Boolean(mappingFor(item.feature));
        document.getElementById('clear-destination').hidden = false;
        document.getElementById('start-navigation').hidden = !hasMapping;
    }
    const point = representativePoint(item.feature), featureLayer = item.layer.getLayers().find(layer => layer.feature === item.feature);
    if (featureLayer?.getBounds?.().isValid()) map.fitBounds(featureLayer.getBounds().pad(0.3)); else if (point) map.setView([point[1], point[0]], 18);
    document.getElementById(type === 'source' ? 'source-search' : 'search').value = item.feature.properties.name;
    document.getElementById(type === 'source' ? 'source-results' : 'destination-results').hidden = true;
    displayRoute();
}

function clearDestination() {
    if (navigation.active) stopNavigation();
    selectedDestination = null; destinationLayer.clearLayers(); routeLayer.clearLayers();
    document.getElementById('search').value = ''; document.getElementById('clear-destination').hidden = true; document.getElementById('start-navigation').hidden = true; displayRoute();
}

function bindSearch(inputId, type) {
    const input = document.getElementById(inputId);
    const resultBox = document.getElementById(type === 'source' ? 'source-results' : 'destination-results');
    let activeResult = -1;

    function closeResults() { resultBox.hidden = true; activeResult = -1; }

    function renderResults(query) {
        resultBox.innerHTML = ''; activeResult = -1;
        const specialCurrent = type === 'source' && (!query || 'current location'.includes(query));
        if (specialCurrent) {
            const row = document.createElement('div');
            row.className = 'result current-location-result'; row.setAttribute('role', 'option'); row.textContent = 'Current Location';
            row.addEventListener('mousedown', event => event.preventDefault());
            row.addEventListener('click', selectCurrentLocationSource);
            resultBox.appendChild(row);
        }
        if (!query) { resultBox.hidden = !specialCurrent; return; }
        const matches = records.filter(item => item.feature.properties.name.toLowerCase().includes(query)).slice(0, 12);
        matches.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'result'; row.setAttribute('role', 'option'); row.textContent = item.feature.properties.name;
            row.addEventListener('mousedown', event => event.preventDefault());
            row.addEventListener('click', () => { selectFeature(item, type); closeResults(); });
            resultBox.appendChild(row);
            if (index === 0) row.setAttribute('aria-selected', 'false');
        });
        resultBox.hidden = !specialCurrent && matches.length === 0;
    }

    input.addEventListener('focus', () => { if (!input.value) renderResults(''); });
    input.addEventListener('input', event => renderResults(event.target.value.trim().toLowerCase()));

    input.addEventListener('keydown', event => {
        const options = [...resultBox.querySelectorAll('.result')];
        if (event.key === 'Escape') { closeResults(); return; }
        if (!options.length || resultBox.hidden) return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            activeResult = (activeResult + (event.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length;
            options.forEach((option, index) => option.setAttribute('aria-selected', String(index === activeResult)));
            options[activeResult].scrollIntoView({ block: 'nearest' });
        } else if (event.key === 'Enter' && activeResult >= 0) {
            event.preventDefault(); options[activeResult].click();
        }
    });
}

loadGraph().then(() => Promise.all([
    loadLayer('buildings', 'buildings.geojson', { style: styleBuilding, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
    loadLayer('roads', 'roads.geojson', { style: styleRoad, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
    loadLayer('paths', 'paths.geojson', { style: stylePath, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
    loadLayer('landmarks', 'landmarks.geojson', { pointToLayer: pointLayer, onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) }),
    loadLayer('campus boundary', 'campus_boundary.geojson', { style: () => ({ color: '#d14e50', weight: 3, dashArray: '9 6', fill: false }), onEachFeature: (feature, layer) => layer.bindPopup(popup(feature)) })
])).then(() => {
    L.control.layers(null, { Buildings: layers.buildings, Roads: layers.roads, 'Walking paths': layers.paths, Landmarks: layers.landmarks, 'Campus boundary': layers['campus boundary'] }, { collapsed: false }).addTo(map);
    const boundary = layers['campus boundary'].getBounds(); if (boundary.isValid()) map.fitBounds(boundary.pad(0.08));
    bindSearch('source-search', 'source'); bindSearch('search', 'destination');
}).catch(error => { console.error('Campus map loading failed:', error); document.getElementById('route-status').textContent = error.message; });

document.getElementById('clear-destination').addEventListener('click', clearDestination);
document.getElementById('clear-route').addEventListener('click', () => { routeLayer.clearLayers(); document.getElementById('route-status').textContent = 'Route cleared. Choose both locations to calculate again.'; });
document.getElementById('route-algorithm').addEventListener('change', displayRoute);
document.getElementById('start-navigation').addEventListener('click', startNavigation);
document.getElementById('stop-navigation').addEventListener('click', stopNavigation);
document.getElementById('retry-location').addEventListener('click', retryNavigation);
document.getElementById('recenter-location').addEventListener('click', recenterLocation);
window.addEventListener('beforeunload', () => { if (navigation.watchId !== null) navigator.geolocation.clearWatch(navigation.watchId); });

document.addEventListener('click', event => {
    if (!event.target.closest('.autocomplete')) {
        document.querySelectorAll('.search-results').forEach(resultBox => { resultBox.hidden = true; });
    }
});
