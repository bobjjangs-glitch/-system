import type { Driver, Route, Shipment } from "../server/types";
export type BoardDrop = {
  shipmentId: string;
  targetDriverId: string | null;
  beforeShipmentId: string | null;
  revision: string;
  serviceDate: string;
};
export type DispatchBoardProps = {
  data: {
    drivers: Driver[];
    routes: Route[];
    shipments: Shipment[];
    serviceDate: string;
    revision: string;
    busy: boolean;
    message: string;
  };
  onDrop: (drop: BoardDrop) => void;
};
