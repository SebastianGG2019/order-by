export interface ProductData {
  id: string;
  discPct: number;   // Descuento máximo entre variantes (%)
  tallas: number;    // Variantes con inventoryQuantity > 0
  ventas30d: number; // Unidades vendidas en 30 días
  score?: number;
}

export function calculateProductScore(product: ProductData): number {
  const W_DISC = 0.4, W_STOCK = 0.3, W_SALES = 0.3;
  const DISC_CAP = 50, TALLA_CAP = 4, SALES_CAP = 10;

  const discNorm = Math.min(product.discPct, DISC_CAP) / DISC_CAP;
  const stockNorm = Math.min(product.tallas, TALLA_CAP) / TALLA_CAP;
  const salesNorm = Math.min(product.ventas30d, SALES_CAP) / SALES_CAP;

  return (W_DISC * discNorm) + (W_STOCK * stockNorm) + (W_SALES * salesNorm);
}

export function sortProductsByScore(products: ProductData[]): ProductData[] {
  return products
    .map(p => ({ ...p, score: calculateProductScore(p) }))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}