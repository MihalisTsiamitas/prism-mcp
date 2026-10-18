/**
 * Descriptive statistics computed in JS. Used as an independent cross-check of
 * what Prism reports, and as a fallback when Prism can't run (no licence etc).
 * SD is the sample SD (n-1), which is what Prism's "Std. Deviation" reports.
 */

const toNumbers = (values) =>
  values
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .map(Number)
    .filter((v) => Number.isFinite(v));

function quantile(sorted, p) {
  // Prism default percentile method: (n+1)p, linear interpolation
  const n = sorted.length;
  const pos = (n + 1) * p;
  if (pos <= 1) return sorted[0];
  if (pos >= n) return sorted[n - 1];
  const lo = Math.floor(pos);
  return sorted[lo - 1] + (pos - lo) * (sorted[lo] - sorted[lo - 1]);
}

export function describe(values) {
  const xs = toNumbers(values);
  const n = xs.length;
  if (n === 0) return { n: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const sum = xs.reduce((s, v) => s + v, 0);
  const mean = sum / n;
  const ss = xs.reduce((s, v) => s + (v - mean) ** 2, 0);
  const sd = n > 1 ? Math.sqrt(ss / (n - 1)) : null;
  const sem = sd === null ? null : sd / Math.sqrt(n);
  return {
    n,
    mean,
    sd,
    sem,
    cv_percent: sd === null || mean === 0 ? null : (sd / mean) * 100,
    variance: n > 1 ? ss / (n - 1) : null,
    min: sorted[0],
    q1: quantile(sorted, 0.25),
    median: quantile(sorted, 0.5),
    q3: quantile(sorted, 0.75),
    max: sorted[n - 1],
    range: sorted[n - 1] - sorted[0],
    sum,
  };
}

/** True when a and b agree to ~4 significant digits (Prism prints rounded values). */
export function closeEnough(a, b) {
  if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) return false;
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12);
  return Math.abs(a - b) / scale < 1e-3;
}
