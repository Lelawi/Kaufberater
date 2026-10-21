// Preisverläufe, die Quellen beim Abruf mitliefern (billiger.de, CHECK24 …) – check.ts übernimmt sie in kb_price_history
export interface HistPoint { date: string; price: number }
export const pageHistory = new Map<string, HistPoint[]>();
