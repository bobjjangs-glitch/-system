export type Point = { lat: number; lng: number };
export type Item = { name: string; quantity: number };
export type ShipmentInput = {
  recipient: string;
  address: string;
  phone?: string;
  items: Item[];
  notes?: string;
  lat?: number | null;
  lng?: number | null;
};
export type Shipment = ShipmentInput & {
  id: string;
  serviceDate: string;
  status: string;
  routeId: string | null;
  sequence: number | null;
  deliveredAt: string | null;
  failureReason: string | null;
  importId: string | null;
};
export type Driver = {
  id: string;
  name: string;
  phone: string;
  capacity: number;
  active: boolean;
};
export type Company = {
  name: string;
  address: string;
  lat: number;
  lng: number;
  serviceMinutes: number;
  navigation: "kakao" | "naver" | "default";
};
export type Session = {
  userId: string;
  role: "admin" | "driver";
  name: string;
};
export type Route = {
  id: string;
  driverId: string;
  driverName: string;
  serviceDate: string;
  status: string;
  distanceKm: number;
  durationMinutes: number;
  estimateSource: string;
  geometry: Point[];
  company: Company;
  startedAt: string | null;
  completedAt: string | null;
  stops: Shipment[];
};
export function isPoint(value: {
  lat?: unknown;
  lng?: unknown;
}): value is Point {
  return (
    typeof value.lat === "number" &&
    Number.isFinite(value.lat) &&
    value.lat >= -90 &&
    value.lat <= 90 &&
    typeof value.lng === "number" &&
    Number.isFinite(value.lng) &&
    value.lng >= -180 &&
    value.lng <= 180
  );
}
