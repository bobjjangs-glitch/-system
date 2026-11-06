export type CompanyErpConnection = {
  configured: boolean;
  apiUrl: string;
  state: string;
  lastError: string | null;
  failures?: Partial<
    Record<
      "customers" | "products" | "sales",
      { at: string; code: string; message: string }
    >
  >;
  reads: Partial<
    Record<
      "customers" | "products" | "sales",
      { at: string; count: number; date?: string }
    >
  >;
  confirmedSalesOnly: boolean;
};
export type ErpStatus = {
  version?: string;
  revision?: string;
  invoiceReferenceLookup?: boolean;
  salesInvoiceBrowser?: boolean;
  customers: number;
  products: number;
  salesDateFilter?: boolean;
  automaticCompanyCatalogs?: boolean;
  company?: CompanyErpConnection;
};
export function readTime(value?: string | null) {
  return value ? new Date(value).toLocaleString("ko-KR") : "조회 기록 없음";
}
