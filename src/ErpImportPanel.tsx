import React from "react";
import CompanyErpPanel from "./CompanyErpPanel";
import type { SalesList } from "./salesDocuments";
export default function ErpImportPanel(props: {
  onOpenInvoices: () => void;
  onSalesList: (id: string) => void;
  date: string;
  disabled: boolean;
  onSalesDocument?: (list: SalesList, sourceKey: string) => void;
  refreshKey?: number;
}) {
  return <CompanyErpPanel {...props} />;
}
