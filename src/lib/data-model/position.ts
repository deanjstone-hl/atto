// BYD answers latitude 0, longitude 0 when the car has no GPS fix (atto/21). That is the
// placeholder, not a place: null island sits in the Gulf of Guinea, and a trip showed it as
// "Start: 0.0000, 0.0000". A coordinate pair is a real position only when it is not this.
// One zero coordinate on its own is a real place (the equator, the prime meridian).
export const isNoFix = (latitude: number, longitude: number): boolean => latitude === 0 && longitude === 0
