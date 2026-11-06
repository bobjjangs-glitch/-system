export type CatalogEntry = {
  id: string;
  code: string;
  name: string;
  source: string;
  defaultChannel?: "retail" | "wholesale";
  retailPrice?: number | null;
  wholesalePrice?: number | null;
  factoryPrice?: number | null;
  remoteId?: string;
  pattern?: string;
  taxType?: "taxable" | "exempt";
  listPrice?: number | null;
  updatedAt?: string;
  address?: string;
  phone?: string;
  specification?: string;
  unitPrice?: number | null;
};
