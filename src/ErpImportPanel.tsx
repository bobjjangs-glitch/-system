import React from "react";
import CompanyErpPanel from "./CompanyErpPanel";
export default function ErpImportPanel(props: {
  onOpenInvoices: () => void;
  onSalesList: (id: string) => void;
  date: string;
  disabled: boolean;
}) {
  return <CompanyErpPanel {...props} />;
}
