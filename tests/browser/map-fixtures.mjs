export function isEOXTile(url) {
  return url.origin === 'https://tiles.maps.eox.at' && !url.search && !url.hash
    && /^\/wmts\/1\.0\.0\/s2cloudless_3857\/default\/GoogleMapsCompatible\/(?:\d|1[0-4])\/\d+\/\d+\.jpg$/.test(url.pathname);
}

export function isOSMTile(url) {
  return url.protocol === 'https:' && url.hostname === 'tile.openstreetmap.org' && /^\/\d+\/\d+\/\d+\.png$/.test(url.pathname) && !url.search && !url.hash;
}

export function backgroundTile(route) {
  return route.fulfill({ headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'image/svg+xml',
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#dfe8d1"/><text x="8" y="22">Authored map fixture</text></svg>' });
}
