// Which entry page is open. Everything but the vehicle belongs to the vehicle the
// dashboard is showing.
export type Entry =
  | { kind: 'vehicle' }
  | { kind: 'charging-session'; vehicleId: string }
  | { kind: 'range-observation'; vehicleId: string }
  | { kind: 'vehicle-feature'; vehicleId: string }
