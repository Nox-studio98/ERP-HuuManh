export const addDaysYmd = (ymd: string, n: number) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
