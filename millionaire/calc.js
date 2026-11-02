/**
 * Road to a Million: the money math.
 *
 * Pure functions with no DOM access, so every number the page shows can be
 * unit-tested on its own (see tests/calc.test.js).
 *
 * Model
 * - Time runs in whole months. Month 0 is today.
 * - The yearly return r and yearly fee f give a net growth factor of
 *   (1 + r) * (1 - f) per year. It is applied as 12 equal monthly steps, so
 *   twelve months grow by exactly that factor (no r / 12 shortcut, which
 *   would overstate a 7% year as 7.23%).
 * - Contributions land at the end of each month. The monthly amount rises by
 *   `raise` once a year: months 1-12 pay `monthly`, months 13-24 pay
 *   `monthly * (1 + raise)`, and so on.
 * - Inflation never touches the balance. It converts amounts into today's
 *   money and, when `targetReal` is set, grows the target so that it keeps
 *   today's purchasing power.
 * - The Monte Carlo simulation draws monthly log returns from a normal
 *   distribution whose median matches the net return above, so the plain
 *   projection is the typical (median) outcome and the simulation shows the
 *   spread around it.
 *
 * @typedef {object} Plan
 * @property {number} age           current age, in years
 * @property {number} start         amount invested today
 * @property {number} monthly       amount invested each month during the first year
 * @property {number} raise         yearly increase of the monthly amount (0.03 = 3%)
 * @property {number} annualReturn  expected yearly return before fees (0.07 = 7%)
 * @property {number} volatility    yearly standard deviation of log returns (0.15 = 15%)
 * @property {number} fee           yearly fees, as a share of the balance (0.002 = 0.2%)
 * @property {number} inflation     yearly inflation (0.025 = 2.5%)
 * @property {number} target        amount to reach
 * @property {boolean} targetReal   true when `target` is in today's money
 * @property {number} goalAge       age by which to reach the target
 */

export const MAX_YEARS = 100;
export const MAX_MONTHS = MAX_YEARS * 12;

/** Relative slack when comparing a balance with the target: one part in a billion. */
const EPS = 1e-9;

/** @type {Readonly<Plan>} */
export const DEFAULT_PLAN = Object.freeze({
  age: 30,
  start: 10000,
  monthly: 500,
  raise: 0,
  annualReturn: 0.07,
  volatility: 0.15,
  fee: 0.002,
  inflation: 0.025,
  target: 1000000,
  targetReal: false,
  goalAge: 50,
});

/** Illustrative long-run assumptions for common portfolios. Not predictions. */
export const PRESETS = Object.freeze([
  Object.freeze({ id: "cash", label: "Cash", annualReturn: 0.02, volatility: 0.01 }),
  Object.freeze({ id: "bonds", label: "Bonds", annualReturn: 0.04, volatility: 0.06 }),
  Object.freeze({ id: "balanced", label: "Balanced", annualReturn: 0.06, volatility: 0.1 }),
  Object.freeze({ id: "stocks", label: "Stocks", annualReturn: 0.07, volatility: 0.15 }),
]);

/** Accepted range for every numeric field of a plan. */
export const LIMITS = Object.freeze({
  age: { min: 0, max: 100, kind: "years" },
  start: { min: 0, max: 1e12, kind: "money" },
  monthly: { min: 0, max: 1e9, kind: "money" },
  raise: { min: -0.1, max: 0.2, kind: "percent" },
  annualReturn: { min: -0.2, max: 0.3, kind: "percent" },
  volatility: { min: 0, max: 0.6, kind: "percent" },
  fee: { min: 0, max: 0.05, kind: "percent" },
  inflation: { min: -0.05, max: 0.2, kind: "percent" },
  target: { min: 1, max: 1e13, kind: "money" },
  goalAge: { min: 0, max: 200, kind: "years" },
});

function describeLimit(value, kind) {
  if (kind === "percent") return `${+(value * 100).toFixed(2)}%`;
  return value.toLocaleString("en");
}

/**
 * Check a plan before doing any math with it.
 * @param {Plan} plan
 * @returns {Record<string, string>} field name -> message; empty when the plan is valid
 */
export function validatePlan(plan) {
  /** @type {Record<string, string>} */
  const errors = {};
  for (const [key, { min, max, kind }] of Object.entries(LIMITS)) {
    const value = plan[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors[key] = "Enter a number.";
    } else if (value < min || value > max) {
      errors[key] = `Enter a value from ${describeLimit(min, kind)} to ${describeLimit(max, kind)}.`;
    }
  }
  if (!errors.age && !errors.goalAge) {
    const months = goalMonthsOf(plan);
    if (months < 1) errors.goalAge = "Pick an age after your current age.";
    else if (months > MAX_MONTHS) errors.goalAge = `Pick an age within ${MAX_YEARS} years of today.`;
  }
  return errors;
}

/** Months from today until the goal age. */
export function goalMonthsOf(plan) {
  return Math.round((plan.goalAge - plan.age) * 12);
}

/** Yearly return after fees, as a fraction. */
export function netReturn(plan) {
  return (1 + plan.annualReturn) * (1 - plan.fee) - 1;
}

/** Growth factor of one month, after fees. */
export function monthlyGrowth(plan) {
  return Math.pow((1 + plan.annualReturn) * (1 - plan.fee), 1 / 12);
}

/**
 * Size of each month's contribution relative to the first year's.
 * Index m holds the multiplier for month m (1-based); index 0 is unused.
 */
export function raiseSchedule(raise, months) {
  const schedule = new Float64Array(months + 1);
  let multiplier = 1;
  for (let m = 1; m <= months; m++) {
    if (m > 1 && (m - 1) % 12 === 0) multiplier *= 1 + raise;
    schedule[m] = multiplier;
  }
  return schedule;
}

/** The target at month m, in that month's money. */
export function targetAt(plan, m) {
  return plan.targetReal ? plan.target * Math.pow(1 + plan.inflation, m / 12) : plan.target;
}

/** What an amount at month m is worth in today's money. */
export function todaysMoney(amount, inflation, m) {
  return amount / Math.pow(1 + inflation, m / 12);
}

/** True when the balance has reached the target (with floating-point slack). */
export function reached(balance, target) {
  return balance >= target * (1 - EPS);
}

/**
 * Month-by-month projection at the expected return.
 * @param {Plan} plan
 * @param {number} months
 * @returns {{balance: Float64Array, invested: Float64Array}} index m = end of month m
 */
export function project(plan, months) {
  const growth = monthlyGrowth(plan);
  const schedule = raiseSchedule(plan.raise, months);
  const balance = new Float64Array(months + 1);
  const invested = new Float64Array(months + 1);
  balance[0] = plan.start;
  invested[0] = plan.start;
  for (let m = 1; m <= months; m++) {
    const payment = plan.monthly * schedule[m];
    balance[m] = balance[m - 1] * growth + payment;
    invested[m] = invested[m - 1] + payment;
  }
  return { balance, invested };
}

/**
 * First month in which the projected balance reaches the target.
 * @param {Plan} plan
 * @param {number} [maxMonths]
 * @returns {number | null} 0 when the target is already met, null when it is not met within maxMonths
 */
export function monthsToTarget(plan, maxMonths = MAX_MONTHS) {
  if (reached(plan.start, targetAt(plan, 0))) return 0;
  const growth = monthlyGrowth(plan);
  const schedule = raiseSchedule(plan.raise, maxMonths);
  let balance = plan.start;
  for (let m = 1; m <= maxMonths; m++) {
    balance = balance * growth + plan.monthly * schedule[m];
    if (reached(balance, targetAt(plan, m))) return m;
  }
  return null;
}

/**
 * First-year monthly amount needed to hold the target at month `months`.
 * Later years' amounts rise with `plan.raise`, as everywhere else.
 * The balance at a fixed month is linear in the monthly amount, so this is exact:
 * balance = start * grownStart + monthly * perUnit.
 * @returns {number} 0 when today's savings already get there on their own
 */
export function requiredMonthly(plan, months) {
  const target = targetAt(plan, months);
  if (months <= 0) return reached(plan.start, target) ? 0 : Infinity;
  const growth = monthlyGrowth(plan);
  const schedule = raiseSchedule(plan.raise, months);
  let grownStart = plan.start;
  let perUnit = 0;
  for (let m = 1; m <= months; m++) {
    grownStart *= growth;
    perUnit = perUnit * growth + schedule[m];
  }
  const gap = target - grownStart;
  return gap <= 0 ? 0 : gap / perUnit;
}

/** Small, fast, seedable PRNG (mulberry32). Returns floats in [0, 1). */
function mulberry32(seed) {
  let state = seed | 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent seed for each simulated path, so a path's history never depends on the horizon. */
function pathSeed(seed, path) {
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(path + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Standard normal draws (Box-Muller), reproducible for a given seed. */
function normalSource(seed) {
  const uniform = mulberry32(seed);
  let spare = 0;
  let hasSpare = false;
  return function normal() {
    if (hasSpare) {
      hasSpare = false;
      return spare;
    }
    const radius = Math.sqrt(-2 * Math.log(1 - uniform())); // 1 - u is in (0, 1], so the log is finite
    const angle = 2 * Math.PI * uniform();
    spare = radius * Math.sin(angle);
    hasSpare = true;
    return radius * Math.cos(angle);
  };
}

/**
 * Standard normal draws for every (month, path), shared by all simulations
 * with the same seed and path count. Drawing them is most of the cost of a
 * simulation and they do not depend on the plan, so they are made once and
 * grown on demand. Row m - 1 holds month m for every path; each path draws
 * from its own generator in month order, so its history is the same however
 * far the table has been grown.
 */
class NormalTable {
  constructor(seed, paths) {
    this.paths = paths;
    this.sources = Array.from({ length: paths }, (_, p) => normalSource(pathSeed(seed, p)));
    this.months = 0;
    this.data = new Float32Array(0);
  }

  ensure(months) {
    if (months <= this.months) return this.data;
    const data = new Float32Array(months * this.paths);
    data.set(this.data);
    for (let m = this.months; m < months; m++) {
      const row = m * this.paths;
      for (let p = 0; p < this.paths; p++) data[row + p] = this.sources[p]();
    }
    this.data = data;
    this.months = months;
    return data;
  }
}

const normalTables = new Map();

function normalTable(seed, paths, months) {
  const key = `${seed}/${paths}`;
  let table = normalTables.get(key);
  if (!table) {
    table = new NormalTable(seed, paths);
    normalTables.set(key, table);
  }
  return table.ensure(months);
}

/** Linear-interpolated quantile of an ascending array (same as numpy's default). */
export function quantileSorted(sorted, q) {
  const n = sorted.length;
  if (n === 0) return NaN;
  const h = (n - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

/**
 * Monte Carlo simulation of the plan over `months`, with yearly volatility.
 * Every call with the same seed replays the same market histories, so changing
 * an input compares like with like instead of reshuffling the luck.
 *
 * @param {Plan} plan
 * @param {number} months horizon of the yearly bands
 * @param {{goalMonths?: number, paths?: number, seed?: number}} [options]
 */
export function simulate(plan, months, { goalMonths = months, paths = 2000, seed = 1 } = {}) {
  const horizon = Math.max(months, goalMonths);
  const years = Math.floor(months / 12);
  const drift = Math.log((1 + plan.annualReturn) * (1 - plan.fee)) / 12;
  const spread = plan.volatility / Math.sqrt(12);
  const schedule = raiseSchedule(plan.raise, horizon);
  const goalTarget = targetAt(plan, goalMonths);
  const z = normalTable(seed, paths, horizon);

  const byYear = Array.from({ length: years + 1 }, () => new Float64Array(paths));
  byYear[0].fill(plan.start);
  // Per path: what 1 unit invested today is worth now, and what investing
  // schedule[m] every month is worth now. A path's balance is
  // start * grown + monthly * perUnit.
  const grown = new Float64Array(paths).fill(1);
  const perUnit = new Float64Array(paths);
  // Per path: the first-year monthly amount that would just reach the target at the goal.
  const needed = new Float64Array(paths);
  let successes = 0;

  if (goalMonths <= 0) {
    const done = reached(plan.start, goalTarget);
    successes = done ? paths : 0;
    needed.fill(done ? 0 : Infinity);
  }

  for (let m = 1; m <= horizon; m++) {
    const row = (m - 1) * paths;
    const payment = schedule[m];
    for (let p = 0; p < paths; p++) {
      const growth = Math.exp(drift + spread * z[row + p]);
      grown[p] *= growth;
      perUnit[p] = perUnit[p] * growth + payment;
    }
    if (m % 12 === 0 && m / 12 <= years) {
      const out = byYear[m / 12];
      for (let p = 0; p < paths; p++) out[p] = plan.start * grown[p] + plan.monthly * perUnit[p];
    }
    if (m === goalMonths) {
      for (let p = 0; p < paths; p++) {
        if (reached(plan.start * grown[p] + plan.monthly * perUnit[p], goalTarget)) successes++;
        const gap = goalTarget - plan.start * grown[p];
        needed[p] = gap <= 0 ? 0 : gap / perUnit[p];
      }
    }
  }

  const low = new Float64Array(years + 1);
  const median = new Float64Array(years + 1);
  const high = new Float64Array(years + 1);
  for (let y = 0; y <= years; y++) {
    const sorted = byYear[y].sort();
    low[y] = quantileSorted(sorted, 0.1);
    median[y] = quantileSorted(sorted, 0.5);
    high[y] = quantileSorted(sorted, 0.9);
  }
  needed.sort();

  return {
    paths,
    years,
    low,
    median,
    high,
    /** Share of paths that hold the target at the goal month with the plan's monthly amount. */
    successRate: successes / paths,
    /** Sorted per-path monthly amounts needed to reach the target at the goal month. */
    needed,
  };
}

/**
 * Smallest first-year monthly amount that reaches the target in at least
 * share `chance` of the simulated paths.
 */
export function monthlyForChance(sim, chance) {
  const k = Math.ceil(chance * sim.paths) - 1;
  return sim.needed[Math.min(sim.paths - 1, Math.max(0, k))];
}

/** Years the chart should span: past the goal and the projected finish, within limits. */
export function chartYears(goalMonths, hitMonths) {
  const goalYears = goalMonths / 12;
  const anchor = hitMonths == null ? Math.max(goalYears, 40) : Math.max(goalYears, hitMonths / 12);
  return Math.min(MAX_YEARS, Math.max(10, Math.ceil(anchor - 1e-9) + 5));
}

/** Round to a friendly 1 / 2 / 2.5 / 5 x 10^k amount, nearest on a log scale. */
export function niceRound(x) {
  if (!(x > 0)) return 0;
  const base = Math.pow(10, Math.floor(Math.log10(x)));
  let best = base;
  for (const c of [1, 2, 2.5, 5, 10]) {
    const candidate = c * base;
    if (Math.abs(Math.log(candidate / x)) < Math.abs(Math.log(best / x))) best = candidate;
  }
  return best;
}

/** Axis ticks from 0 to at least `max`, about `count` steps of a friendly size. */
export function niceTicks(max, count = 4) {
  if (!(max > 0)) return { step: 1, top: 1, ticks: [0, 1] };
  const rough = max / count;
  const base = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((c) => c * base).find((c) => c >= rough * (1 - 1e-9));
  const steps = Math.ceil(max / step - 1e-9);
  const ticks = Array.from({ length: steps + 1 }, (_, i) => i * step);
  return { step, top: steps * step, ticks };
}

/** "3 years 2 months", "1 year", "5 months". */
export function formatDuration(months) {
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts = [];
  if (years) parts.push(`${years} ${years === 1 ? "year" : "years"}`);
  if (rest) parts.push(`${rest} ${rest === 1 ? "month" : "months"}`);
  return parts.length ? parts.join(" ") : "0 months";
}

/**
 * What-if variants of the plan, each with its projected months to target.
 * @returns {{id: string, plan: Plan, months: number | null, step?: number}[]}
 */
export function leverScenarios(plan) {
  const step = niceRound(plan.monthly > 0 ? plan.monthly * 0.2 : plan.target / 5000);
  const variants = [
    { id: "monthly", plan: { ...plan, monthly: plan.monthly + step }, step },
    { id: "raise", plan: { ...plan, raise: plan.raise + 0.03 } },
    { id: "return-up", plan: { ...plan, annualReturn: plan.annualReturn + 0.01 } },
    { id: "return-down", plan: { ...plan, annualReturn: plan.annualReturn - 0.01 } },
  ];
  return variants.map((v) => ({ ...v, months: monthsToTarget(v.plan) }));
}
