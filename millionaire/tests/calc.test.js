// Unit tests for the money math. Run with `npm test` from the millionaire/ folder.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as calc from "../calc.js";

const plan = (overrides = {}) => ({ ...calc.DEFAULT_PLAN, ...overrides });

function assertClose(actual, expected, relTol = 1e-9, message = "") {
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(
    Math.abs(actual - expected) <= relTol * scale,
    `${message} expected ${expected}, got ${actual}`.trim(),
  );
}

/** Closed-form future value for a level monthly payment (raise = 0). */
function closedFormBalance(p, months) {
  const f = calc.monthlyGrowth(p);
  const fn = Math.pow(f, months);
  const annuity = Math.abs(f - 1) < 1e-15 ? months : (fn - 1) / (f - 1);
  return p.start * fn + p.monthly * annuity;
}

describe("growth", () => {
  test("twelve monthly steps compound to exactly the yearly return", () => {
    assertClose(calc.monthlyGrowth(plan({ annualReturn: 0.07, fee: 0 })) ** 12, 1.07, 1e-12);
    assertClose(calc.monthlyGrowth(plan({ annualReturn: -0.05, fee: 0 })) ** 12, 0.95, 1e-12);
  });

  test("fees come off the grown balance once a year", () => {
    const p = plan({ annualReturn: 0.07, fee: 0.01 });
    assertClose(calc.monthlyGrowth(p) ** 12, 1.07 * 0.99, 1e-12);
    assertClose(calc.netReturn(p), 1.07 * 0.99 - 1, 1e-12);
  });
});

describe("project", () => {
  test("at 0% the balance is just what you put in", () => {
    const p = plan({ start: 1000, monthly: 100, annualReturn: 0, fee: 0, raise: 0 });
    const { balance, invested } = calc.project(p, 120);
    assertClose(balance[120], 1000 + 100 * 120);
    assertClose(invested[120], 1000 + 100 * 120);
    assert.equal(balance.length, 121);
  });

  test("matches the closed-form future value of an annuity", () => {
    for (const annualReturn of [0.03, 0.07, -0.05]) {
      const p = plan({ start: 25000, monthly: 750, annualReturn, fee: 0.002, raise: 0 });
      const { balance } = calc.project(p, 1200);
      for (const months of [1, 12, 360, 1200]) {
        assertClose(balance[months], closedFormBalance(p, months), 1e-10, `r=${annualReturn} m=${months}`);
      }
    }
  });

  test("the monthly amount rises once a year", () => {
    const p = plan({ start: 0, monthly: 100, annualReturn: 0, fee: 0, raise: 0.1 });
    const { invested } = calc.project(p, 25);
    assertClose(invested[12], 1200);
    assertClose(invested[24], 1200 + 12 * 110);
    assertClose(invested[25], 1200 + 12 * 110 + 121);
  });
});

describe("monthsToTarget", () => {
  test("is 0 when savings already cover the target", () => {
    assert.equal(calc.monthsToTarget(plan({ start: 1e6, target: 1e6 })), 0);
  });

  test("is null when the target is out of reach", () => {
    assert.equal(calc.monthsToTarget(plan({ monthly: 0, annualReturn: 0, fee: 0 })), null);
    // Growth below inflation never catches up with a target in today's money.
    assert.equal(
      calc.monthsToTarget(plan({ monthly: 0, start: 100000, annualReturn: 0.02, fee: 0, inflation: 0.03, targetReal: true })),
      null,
    );
  });

  test("returns the first month at or above the target", () => {
    const cases = [
      plan(),
      plan({ raise: 0.03 }),
      plan({ targetReal: true }),
      plan({ annualReturn: -0.02, monthly: 4000 }),
      plan({ start: 0, monthly: 2500, annualReturn: 0.05, target: 2e6 }),
    ];
    for (const p of cases) {
      const months = calc.monthsToTarget(p);
      assert.ok(months > 0, JSON.stringify(p));
      const { balance } = calc.project(p, months);
      assert.ok(balance[months] >= calc.targetAt(p, months) * (1 - 1e-9));
      assert.ok(balance[months - 1] < calc.targetAt(p, months - 1));
    }
  });

  test("matches the logarithm formula for a level monthly amount", () => {
    for (const [start, monthly, annualReturn] of [
      [10000, 500, 0.07],
      [0, 1000, 0.04],
      [250000, 0, 0.06],
      [5000, 3000, 0.1],
    ]) {
      const p = plan({ start, monthly, annualReturn, fee: 0.002, raise: 0, targetReal: false });
      const f = calc.monthlyGrowth(p);
      const exact = Math.log((p.target * (f - 1) + monthly) / (start * (f - 1) + monthly)) / Math.log(f);
      assert.equal(calc.monthsToTarget(p), Math.ceil(exact));
    }
  });

  test("the example plan reaches a million in 36 years 3 months", () => {
    // Cross-checked against an independent closed-form implementation.
    assert.equal(calc.monthsToTarget(plan()), 435);
  });

  test("a target in today's money takes longer when prices rise", () => {
    assert.ok(calc.monthsToTarget(plan({ targetReal: true })) > calc.monthsToTarget(plan()));
  });
});

describe("requiredMonthly", () => {
  test("lands exactly on the target at the goal month", () => {
    const cases = [plan(), plan({ raise: 0.03 }), plan({ targetReal: true }), plan({ annualReturn: -0.03 })];
    for (const p of cases) {
      const months = calc.goalMonthsOf(p);
      const need = calc.requiredMonthly(p, months);
      const { balance } = calc.project({ ...p, monthly: need }, months);
      assertClose(balance[months], calc.targetAt(p, months), 1e-9);
    }
  });

  test("rounded up to a whole unit it is enough, one unit less is not", () => {
    const p = plan();
    const months = calc.goalMonthsOf(p);
    const need = calc.requiredMonthly(p, months);
    assert.ok(calc.monthsToTarget({ ...p, monthly: Math.ceil(need) }) <= months);
    const { balance } = calc.project({ ...p, monthly: Math.ceil(need) - 1 }, months);
    assert.ok(balance[months] < p.target);
  });

  test("matches the closed form for a level monthly amount", () => {
    const p = plan({ raise: 0 });
    const months = 240;
    const f = calc.monthlyGrowth(p);
    const fn = f ** months;
    const exact = ((p.target - p.start * fn) * (f - 1)) / (fn - 1);
    assertClose(calc.requiredMonthly(p, months), exact, 1e-10);
    assertClose(exact, 1943.6322387923, 1e-10); // independent Python check
  });

  test("is 0 when today's savings grow to the target on their own", () => {
    assert.equal(calc.requiredMonthly(plan({ start: 600000 }), 240), 0);
  });
});

describe("simulate", () => {
  const options = (p) => ({ goalMonths: calc.goalMonthsOf(p), paths: 2000, seed: 2026 });

  test("with no volatility every path is the projection", () => {
    const p = plan({ volatility: 0 });
    const months = 30 * 12;
    const sim = calc.simulate(p, months, options(p));
    const { balance } = calc.project(p, months);
    for (let y = 0; y <= 30; y++) {
      assertClose(sim.low[y], balance[y * 12], 1e-9, `year ${y}`);
      assertClose(sim.high[y], balance[y * 12], 1e-9, `year ${y}`);
    }
    assert.equal(sim.successRate, 0); // the deterministic plan misses the goal at 50
    assertClose(calc.monthlyForChance(sim, 0.9), calc.requiredMonthly(p, calc.goalMonthsOf(p)), 1e-9);
    const rich = plan({ volatility: 0, monthly: 2000 });
    assert.equal(calc.simulate(rich, months, options(rich)).successRate, 1);
  });

  test("is reproducible for a seed and changes with it", () => {
    const p = plan();
    const a = calc.simulate(p, 480, options(p));
    const b = calc.simulate(p, 480, options(p));
    assert.deepEqual(a.high, b.high);
    assert.equal(a.successRate, b.successRate);
    const c = calc.simulate(p, 480, { ...options(p), seed: 7 });
    assert.notDeepEqual(a.high, c.high);
  });

  test("a path's history does not depend on the horizon", () => {
    const p = plan();
    const short = calc.simulate(p, 300, options(p));
    const long = calc.simulate(p, 1200, options(p));
    assert.deepEqual(short.high, long.high.slice(0, short.high.length));
    assert.equal(short.successRate, long.successRate);
  });

  test("the chance of success never drops when you invest more", () => {
    let previous = -1;
    for (const monthly of [0, 500, 1000, 2000, 3000, 5000]) {
      const p = plan({ monthly });
      const { successRate } = calc.simulate(p, 480, options(p));
      assert.ok(successRate >= previous, `monthly ${monthly}`);
      previous = successRate;
    }
    // Even 5,000 a month misses in a few very bad 20-year markets.
    assert.ok(previous > 0.95 && previous < 1, `${previous}`);
  });

  test("the amount for a chance delivers at least that chance", () => {
    const p = plan();
    const sim = calc.simulate(p, 480, options(p));
    for (const chance of [0.5, 0.75, 0.9]) {
      const monthly = Math.ceil(calc.monthlyForChance(sim, chance));
      const check = calc.simulate({ ...p, monthly }, 480, options(p));
      assert.ok(check.successRate >= chance, `chance ${chance}: ${check.successRate}`);
    }
  });

  test("success rate agrees with the per-path amounts needed", () => {
    const p = plan({ monthly: 1900 });
    const sim = calc.simulate(p, 480, options(p));
    const enough = sim.needed.filter((need) => need <= p.monthly).length / sim.paths;
    assertClose(sim.successRate, enough, 1e-12);
  });

  test("spread and drift match the inputs", () => {
    // A lump sum is lognormal: its median grows at the net return and its
    // 10th/90th percentiles sit 1.2816 standard deviations away in log space.
    const p = plan({ start: 100000, monthly: 0, annualReturn: 0.07, fee: 0.002, volatility: 0.15 });
    const sim = calc.simulate(p, 120, { goalMonths: 12, paths: 2000, seed: 2026 });
    const zSpread = 1.2815515655446004 * 0.15;
    assert.ok(Math.abs(Math.log(sim.high[1] / sim.median[1]) - zSpread) < 0.03);
    assert.ok(Math.abs(Math.log(sim.median[1] / sim.low[1]) - zSpread) < 0.03);
    const tenYears = Math.log(sim.median[10] / 100000);
    assert.ok(Math.abs(tenYears - 10 * Math.log(1.07 * 0.998)) < 0.06);
  });
});

describe("helpers", () => {
  test("quantileSorted interpolates like numpy", () => {
    const xs = new Float64Array([1, 2, 3, 4]);
    assert.equal(calc.quantileSorted(xs, 0), 1);
    assert.equal(calc.quantileSorted(xs, 0.5), 2.5);
    assert.equal(calc.quantileSorted(xs, 1), 4);
    assertClose(calc.quantileSorted(xs, 0.1), 1.3, 1e-12);
  });

  test("niceTicks covers the maximum with friendly steps", () => {
    assert.deepEqual(calc.niceTicks(1.1e6, 4), { step: 500000, top: 1500000, ticks: [0, 500000, 1000000, 1500000] });
    assert.deepEqual(calc.niceTicks(1e6, 4).ticks, [0, 250000, 500000, 750000, 1000000]);
    for (const max of [3, 870, 12345, 999999, 2.7e7]) {
      const { top, ticks, step } = calc.niceTicks(max, 4);
      assert.ok(top >= max);
      assert.ok(ticks.length <= 6);
      assert.equal(ticks.at(-1), top);
      assert.ok([1, 2, 2.5, 5].includes(step / 10 ** Math.floor(Math.log10(step))));
    }
  });

  test("niceRound picks the nearest friendly amount", () => {
    assert.equal(calc.niceRound(100), 100);
    assert.equal(calc.niceRound(400), 500);
    assert.equal(calc.niceRound(140), 100);
    assert.equal(calc.niceRound(230), 250);
    assert.equal(calc.niceRound(0), 0);
  });

  test("formatDuration", () => {
    assert.equal(calc.formatDuration(0), "0 months");
    assert.equal(calc.formatDuration(1), "1 month");
    assert.equal(calc.formatDuration(12), "1 year");
    assert.equal(calc.formatDuration(13), "1 year 1 month");
    assert.equal(calc.formatDuration(435), "36 years 3 months");
  });

  test("chartYears spans past the goal and the finish", () => {
    assert.equal(calc.chartYears(240, 435), 42);
    assert.equal(calc.chartYears(240, null), 45);
    assert.equal(calc.chartYears(240, 0), 25);
    assert.equal(calc.chartYears(240, 240), 25);
    assert.equal(calc.chartYears(12, 12), 10);
    assert.equal(calc.chartYears(1200, 1200), 100);
  });

  test("todaysMoney and targetAt use the same inflation", () => {
    const p = plan({ targetReal: true, inflation: 0.025 });
    assertClose(calc.todaysMoney(calc.targetAt(p, 360), 0.025, 360), p.target, 1e-12);
    assert.equal(calc.targetAt(plan(), 360), 1e6);
  });
});

describe("validatePlan", () => {
  test("accepts the example plan", () => {
    assert.deepEqual(calc.validatePlan(plan()), {});
  });

  test("rejects blanks and out-of-range values", () => {
    const errors = calc.validatePlan(plan({ monthly: NaN, annualReturn: 0.5, fee: -0.01 }));
    assert.equal(errors.monthly, "Enter a number.");
    assert.equal(errors.annualReturn, "Enter a value from -20% to 30%.");
    assert.equal(errors.fee, "Enter a value from 0% to 5%.");
  });

  test("needs a goal age after today and within 100 years", () => {
    assert.equal(calc.validatePlan(plan({ age: 50, goalAge: 50 })).goalAge, "Pick an age after your current age.");
    assert.equal(calc.validatePlan(plan({ age: 20, goalAge: 121 })).goalAge, "Pick an age within 100 years of today.");
    assert.equal(calc.validatePlan(plan({ age: 20, goalAge: 120 })).goalAge, undefined);
  });
});

describe("leverScenarios", () => {
  test("more money or more return gets there sooner, less return later", () => {
    const base = calc.monthsToTarget(plan());
    const byId = Object.fromEntries(calc.leverScenarios(plan()).map((s) => [s.id, s]));
    assert.equal(byId.monthly.step, 100);
    assert.ok(byId.monthly.months < base);
    assert.ok(byId.raise.months < base);
    assert.ok(byId["return-up"].months < base);
    assert.ok(byId["return-down"].months > base);
  });
});
