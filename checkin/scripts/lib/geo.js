/**
 * Geo engine: coordinate systems, map-link parsing, geocoding, fence math.
 *
 * Conventions:
 *   - Public result objects use { latitude, longitude }.
 *   - Transform helpers take (latitude, longitude) and return { latitude, longitude }.
 *   - Chinese consumer apps (WeChat / AMap / Tencent) work in GCJ-02 ("Mars");
 *     GPS and Google Maps use WGS84; Baidu uses BD-09. Never mix them — a wrong
 *     datum is a 100-700m error and silently fails a geofence.
 */

const PI = Math.PI;
const A = 6378245.0; // Krasovsky 1940 semi-major axis
const EE = 0.00669342162296594323; // eccentricity squared
const X_PI = (PI * 3000.0) / 180.0;

export function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function tLat(x, y) {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(y * PI) + 40 * Math.sin((y / 3) * PI)) * 2) / 3;
  r += ((160 * Math.sin((y / 12) * PI) + 320 * Math.sin((y * PI) / 30)) * 2) / 3;
  return r;
}

function tLng(x, y) {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2) / 3;
  r += ((20 * Math.sin(x * PI) + 40 * Math.sin((x / 3) * PI)) * 2) / 3;
  r += ((150 * Math.sin((x / 12) * PI) + 300 * Math.sin((x / 30) * PI)) * 2) / 3;
  return r;
}

export function wgs84ToGcj02(lat, lng) {
  if (outOfChina(lat, lng)) return { latitude: lat, longitude: lng };
  let dLat = tLat(lng - 105.0, lat - 35.0);
  let dLng = tLng(lng - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { latitude: lat + dLat, longitude: lng + dLng };
}

export function gcj02ToWgs84(lat, lng) {
  if (outOfChina(lat, lng)) return { latitude: lat, longitude: lng };
  let wLat = lat;
  let wLng = lng;
  for (let i = 0; i < 30; i++) {
    const g = wgs84ToGcj02(wLat, wLng);
    wLat -= g.latitude - lat;
    wLng -= g.longitude - lng;
  }
  return { latitude: wLat, longitude: wLng };
}

export function gcj02ToBd09(lat, lng) {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * X_PI);
  return { latitude: z * Math.sin(theta) + 0.006, longitude: z * Math.cos(theta) + 0.0065 };
}

export function bd09ToGcj02(lat, lng) {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * X_PI);
  return { latitude: z * Math.sin(theta), longitude: z * Math.cos(theta) };
}

const NORMAL = (s) => String(s || '').toLowerCase().replace(/[_-]/g, '');

/** Convert between wgs84 / gcj02 / bd09 via a WGS84 pivot. */
export function convert(lat, lng, from = 'wgs84', to = 'gcj02') {
  const f = NORMAL(from);
  const t = NORMAL(to);
  if (f === t) return { latitude: lat, longitude: lng };
  // First normalise to WGS84.
  let w;
  if (f === 'wgs84' || f === 'epsg4326') w = { latitude: lat, longitude: lng };
  else if (f === 'gcj02' || f === 'gcj' || f === 'mars') w = gcj02ToWgs84(lat, lng);
  else if (f === 'bd09' || f === 'bd09ll' || f === 'baidu') w = gcj02ToWgs84(bd09ToGcj02(lat, lng).latitude, bd09ToGcj02(lat, lng).longitude);
  else throw new Error(`未知坐标系: ${from}`);
  // Then WGS84 out to the target.
  if (t === 'wgs84' || t === 'epsg4326') return w;
  if (t === 'gcj02' || t === 'gcj' || t === 'mars') return wgs84ToGcj02(w.latitude, w.longitude);
  if (t === 'bd09' || t === 'bd09ll' || t === 'baidu') {
    const g = wgs84ToGcj02(w.latitude, w.longitude);
    return gcj02ToBd09(g.latitude, g.longitude);
  }
  throw new Error(`未知坐标系: ${to}`);
}

const EARTH_R = 6371000;
export function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const toRad = (d) => (d * PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLng = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(h));
}

function normPlace(s) {
  return String(s || '')
    .replace(/[\s,，。;；:：()（）【】\[\]《》\-—_]/g, '')
    .toLowerCase();
}

export function looksSamePlace(place, specified) {
  if (!place || !specified) return false;
  const a = normPlace(place);
  if (!a) return false;
  const b = normPlace(specified.title || '');
  const c = normPlace(specified.address || '');
  if (b && (a.includes(b) || b.includes(a))) return true;
  if (c && (a.includes(c) || c.includes(a))) return true;
  const parts = String(specified.title || '')
    .split(/[\s,，()（）【】]+/)
    .map(normPlace)
    .filter((x) => x.length >= 2);
  if (parts.length && parts.every((p) => a.includes(p))) return true;
  if (parts.some((p) => p.length >= 4 && a.includes(p))) return true;
  return false;
}

/**
 * Extract coordinates from a map share link or any text.
 * Supports AMap `@lng,lat` / `?position=lng,lat` / `?q=`, Tencent `location=lat,lng`,
 * Baidu `?latlng=lat,lng`, Google `/maps/@lat,lng,17z`, and bare `lat,lng`.
 */
export function extractCoordsFromText(text) {
  if (!text) return null;
  const s = String(text);
  const patterns = [
    /@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/,
    /[?&](?:q|query|ll|center|latlng|location|poi|position)=(-?\d{1,3}\.\d+)[,，](-?\d{1,3}\.\d+)/i,
    /(-?\d{1,3}\.\d{4,})[,，\s]+(-?\d{1,3}\.\d{4,})/,
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (!m) continue;
    let a = Number(m[1]);
    let b = Number(m[2]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    let lat;
    let lng;
    // In China longitude > 90 and latitude < 54 disambiguates the pair.
    if (Math.abs(a) > 90 && Math.abs(b) < 90) {
      lng = a;
      lat = b;
    } else if (Math.abs(b) > 90 && Math.abs(a) < 90) {
      lat = a;
      lng = b;
    } else {
      lat = a;
      lng = b;
    }
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    return { latitude: lat, longitude: lng };
  }
  return null;
}

/** Area-weighted centroid of a polygon given as [[lng,lat], ...] (shoelace). */
export function polygonCentroid(points) {
  const pts = (points || [])
    .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.longitude), Number(p.latitude)]))
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length === 0) throw new Error('多边形没有有效顶点');
  if (pts.length < 3) {
    const n = pts.length;
    return { longitude: pts.reduce((t, q) => t + q[0], 0) / n, latitude: pts.reduce((t, q) => t + q[1], 0) / n };
  }
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const cross = x1 * y2 - x2 * y1;
    area += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    const n = pts.length;
    return { longitude: pts.reduce((t, q) => t + q[0], 0) / n, latitude: pts.reduce((t, q) => t + q[1], 0) / n };
  }
  return { longitude: cx / (6 * area), latitude: cy / (6 * area) };
}

/** Ray-casting point-in-polygon; polygon as [[lng,lat], ...]. */
export function pointInPolygon(lat, lng, polygon) {
  const pts = (polygon || []).map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : [Number(p.longitude), Number(p.latitude)]));
  if (pts.length < 3) return false;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0];
    const yi = pts[i][1];
    const xj = pts[j][0];
    const yj = pts[j][1];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ----------------------------------------------------------------------------
// Geocoding providers (all return GCJ-02 for Chinese providers, WGS84 for OSM)
// ----------------------------------------------------------------------------

async function geocodeAmap(place, { key, city }) {
  const url = new URL('https://restapi.amap.com/v3/geocode/geo');
  url.searchParams.set('key', key);
  url.searchParams.set('address', place);
  if (city) url.searchParams.set('city', city);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  if (json.status !== '1' || !json.geocodes?.length) throw new Error(`高德未找到该地点：${json.info || ''}`);
  const g = json.geocodes[0];
  const [lng, lat] = String(g.location).split(',').map(Number);
  return {
    source: 'amap',
    coordinateSystem: 'gcj02',
    latitude: lat,
    longitude: lng,
    title: g.formatted_address || place,
    address: g.formatted_address || place,
    level: g.level,
  };
}

async function geocodeTencent(place, { key }) {
  const url = new URL('https://apis.map.qq.com/ws/geocoder/v1/');
  url.searchParams.set('key', key);
  url.searchParams.set('address', place);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  if (json.status !== 0 || !json.result?.location) throw new Error(`腾讯地图未找到该地点：${json.message || ''}`);
  return {
    source: 'tencent',
    coordinateSystem: 'gcj02',
    latitude: json.result.location.lat,
    longitude: json.result.location.lng,
    title: json.result.formatted_addresses?.recommend || place,
    address: json.result.address || place,
    level: json.result.level,
  };
}

async function geocodeNominatim(place) {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', place);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('accept-language', 'zh-CN');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dsh-checkin/1.0 (personal automation tool)' },
    signal: AbortSignal.timeout(20000),
  });
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) throw new Error('OpenStreetMap 未找到该地点');
  const top = list[0];
  return {
    source: 'nominatim',
    coordinateSystem: 'wgs84',
    latitude: Number(top.lat),
    longitude: Number(top.lon),
    title: top.name || top.display_name,
    address: top.display_name,
    level: top.addresstype || top.type,
    candidates: list.map((x) => ({ latitude: Number(x.lat), longitude: Number(x.lon), title: x.name || x.display_name })),
  };
}

async function reverseAmap(lat, lng, { key }) {
  const url = new URL('https://restapi.amap.com/v3/geocode/regeo');
  url.searchParams.set('key', key);
  url.searchParams.set('location', `${lng},${lat}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const json = await res.json();
  if (json.status !== '1' || !json.regeocode) throw new Error(`高德逆地理失败：${json.info || ''}`);
  const r = json.regeocode;
  return { source: 'amap', address: r.formatted_address, component: r.addressComponent };
}

/**
 * Resolve a human place name / map link / bare coords to coordinates.
 * Priority: form-specified point -> explicit coords in text -> AMap -> Tencent -> OSM.
 * @returns {source, latitude, longitude, title, address, coordinateSystem, ...}
 */
export async function resolvePlace(place, opts = {}) {
  const { specified, city, maxDistanceMeters = 3000 } = opts;
  const amapKey = opts.amapKey || process.env.AMAP_KEY;
  const tencentKey = opts.tencentKey || process.env.TENCENT_MAP_KEY;

  if (!place) {
    if (specified && specified.latitude != null && specified.longitude != null) {
      return {
        source: 'form-specified',
        coordinateSystem: 'gcj02',
        latitude: Number(specified.latitude),
        longitude: Number(specified.longitude),
        title: specified.title || '',
        address: specified.address || '',
        note: '未指定地点，直接使用发布者设置的签到点坐标',
      };
    }
    throw new Error('表单没有设置指定签到点，请提供 place 地名、地图链接或 lat/lng');
  }

  if (specified && specified.latitude != null && specified.longitude != null && looksSamePlace(place, specified)) {
    return {
      source: 'form-specified',
      coordinateSystem: 'gcj02',
      latitude: Number(specified.latitude),
      longitude: Number(specified.longitude),
      title: specified.title || place,
      address: specified.address || '',
      note: '地点与表单指定签到点一致，已使用发布者的精确坐标（最稳妥）',
    };
  }

  const fromText = extractCoordsFromText(place);
  if (fromText) {
    return withSpecifiedCheck({ source: 'map-link', coordinateSystem: 'gcj02', ...fromText, title: String(place).slice(0, 60), address: '' }, specified, maxDistanceMeters);
  }

  const errors = [];
  if (amapKey) {
    try {
      return withSpecifiedCheck(await geocodeAmap(place, { key: amapKey, city }), specified, maxDistanceMeters);
    } catch (e) {
      errors.push(`高德: ${e.message}`);
    }
  }
  if (tencentKey) {
    try {
      return withSpecifiedCheck(await geocodeTencent(place, { key: tencentKey }), specified, maxDistanceMeters);
    } catch (e) {
      errors.push(`腾讯: ${e.message}`);
    }
  }
  try {
    return withSpecifiedCheck(await geocodeNominatim(place), specified, maxDistanceMeters);
  } catch (e) {
    errors.push(`OSM: ${e.message}`);
  }

  if (specified && specified.latitude != null && specified.longitude != null) {
    return {
      source: 'form-specified(fallback)',
      coordinateSystem: 'gcj02',
      latitude: Number(specified.latitude),
      longitude: Number(specified.longitude),
      title: specified.title || place,
      address: specified.address || '',
      warning: `地点「${place}」解析失败（${errors.join('；')}），已自动改用发布者设置的签到点坐标。若签的不是这个点，请给 lat/lng 或地图链接。`,
    };
  }

  throw new Error(
    `无法解析地点「${place}」。已尝试：${errors.join('；')}。可设置 AMAP_KEY 后再试，或直接给 lat/lng 或地图链接。`,
  );
}

function withSpecifiedCheck(result, specified, maxDistanceMeters) {
  if (!specified || specified.latitude == null || specified.longitude == null) return result;
  const d = distanceMeters(result, { latitude: Number(specified.latitude), longitude: Number(specified.longitude) });
  result.distanceToSpecified = Math.round(d);
  if (d > maxDistanceMeters) {
    result.warning = `解析结果距离表单指定签到点约 ${Math.round(d)} 米，可能不在签到范围内（发布者范围 ${specified.scope ?? '未知'} 米）。`;
  }
  return result;
}

export { geocodeAmap, geocodeTencent, geocodeNominatim, reverseAmap };
