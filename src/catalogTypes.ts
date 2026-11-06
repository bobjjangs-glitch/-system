export type CatalogEntry = {
  id: string;
  code: string;
  name: string;
  source: string;
  updatedAt?: string;
  address?: string;
  phone?: string;
  specification?: string;
  unitPrice?: number | null;
};
