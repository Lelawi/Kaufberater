// Große Rabatt-Aktionstage, die jedes Jahr wiederkehren (Termine berechnet, keine Recherche nötig)

export interface ShoppingEvent { name: string; date: Date; days: number }

function blackFriday(year: number): Date {
  // vierter Donnerstag im November + 1 Tag
  const d = new Date(Date.UTC(year, 10, 1));
  const firstThu = (4 - d.getUTCDay() + 7) % 7 + 1;
  return new Date(Date.UTC(year, 10, firstThu + 21 + 1));
}

export function shoppingEvents(year: number): { name: string; date: Date }[] {
  const bf = blackFriday(year);
  return [
    { name: 'Singles Day', date: new Date(Date.UTC(year, 10, 11)) },
    { name: 'Black Friday', date: bf },
    { name: 'Cyber Monday', date: new Date(+bf + 3 * 864e5) },
    { name: 'Nach-Weihnachts-Sale', date: new Date(Date.UTC(year, 11, 27)) },
  ];
}

export function nextShoppingEvent(now = new Date()): ShoppingEvent | null {
  const all = [...shoppingEvents(now.getUTCFullYear()), ...shoppingEvents(now.getUTCFullYear() + 1)]
    .filter((e) => +e.date >= +now - 864e5).sort((a, b) => +a.date - +b.date);
  const e = all[0];
  return e ? { ...e, days: Math.max(0, Math.ceil((+e.date - +now) / 864e5)) } : null;
}

/**
 * „Heiße Phase“: Singles Day (11.11.) und die Black Week (Montag vor Black Friday bis Dienstag nach Cyber Monday).
 * In dieser Zeit wird öfter geprüft, weil gute Deals oft nach wenigen Stunden ausverkauft sind.
 */
export function hotWindow(now = new Date()): string | null {
  const y = now.getUTCFullYear();
  const bf = shoppingEvents(y).find((e) => e.name === 'Black Friday')!.date;
  const day = (d: Date, plus: number) => +d + plus * 864e5;
  const t = +now + 2 * 3600_000;   // grob deutsche Zeit (Tagesgrenzen)
  const singles = Date.UTC(y, 10, 11);
  if (t >= singles && t < day(new Date(singles), 1)) return 'Singles Day';
  if (t >= day(bf, -4) && t < day(bf, 5)) return 'Black Week';
  return null;
}

/** Termin für eine frische Tiefenanalyse vor der Black Week (Sonntag davor, früh morgens) – nur in den 3 Wochen davor */
export function preBlackWeekAnalysis(now = new Date()): Date | null {
  for (const y of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
    const bf = shoppingEvents(y).find((e) => e.name === 'Black Friday')!.date;
    const target = new Date(+bf - 5 * 864e5 + 3 * 3600_000);   // Sonntag 04:00 Uhr deutscher Zeit
    if (+now <= +target && +now >= +target - 21 * 864e5) return target;
  }
  return null;
}
