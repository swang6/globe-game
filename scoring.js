/**
 * Haversine formula — great-circle distance between two lat/lng points.
 * Returns distance in kilometres.
 */
export function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth mean radius in km
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/**
 * Score formula: max 1000 points, decays to 0 at ~2500 km.
 * Power of 0.7 gives a gentle curve — being in the right region still scores.
 */
export function calcScore(distanceKm) {
  return Math.round(1000 * Math.max(0, 1 - (distanceKm / 2500) ** 0.7));
}
