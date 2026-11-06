export type EcountConnection = {
  configured: boolean;
  missing: string[];
  environment: string;
  products: {
    supported: boolean;
    state: string;
    lastReadAt: string | null;
    count: number | null;
    nextListAt: string;
    listIntervalSeconds: number;
    lastError: string | null;
  };
  customers: { supported: boolean; reason: string };
  sales: { supported: boolean; reason: string };
};
export type CompanyErpConnection = {
  configured: boolean;
  apiUrl: string;
  state: string;
  lastError: string | null;
  reads: Partial<
    Record<"customers" | "products" | "sales", { at: string; count: number }>
  >;
  confirmedSalesOnly: boolean;
};
export type ErpStatus = {
  customers: number;
  products: number;
  salesDateFilter?: boolean;
  direct?: EcountConnection;
  company?: CompanyErpConnection;
};
export function readTime(value?: string | null) {
  return value ? new Date(value).toLocaleString("ko-KR") : "조회 기록 없음";
}
