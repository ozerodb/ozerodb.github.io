// Road to a Million: page logic. All the money math lives in calc.js.
import {
    DEFAULT_PLAN,
    PRESETS,
    MAX_YEARS,
    validatePlan,
    goalMonthsOf,
    netReturn,
    monthsToTarget,
    requiredMonthly,
    project,
    simulate,
    monthlyForChance,
    targetAt,
    todaysMoney,
    reached,
    chartYears,
    leverScenarios,
    niceTicks,
    formatDuration,
} from "./calc.js";

const SIM_PATHS = 2000;
const SIM_SEED = 2026;
const STORAGE_KEY = "road-to-a-million:v1";
const NUMBER_FIELDS = ["age", "start", "monthly", "annualReturn", "target", "goalAge", "raise", "fee", "inflation", "volatility"];
const PERCENT_FIELDS = new Set(["annualReturn", "raise", "fee", "inflation", "volatility"]);
const ADVANCED_FIELDS = new Set(["raise", "fee", "inflation", "volatility"]);
const CURRENCIES = ["EUR", "USD", "GBP", "CHF", "CAD", "AUD", "JPY", "INR", "SEK", "NOK", "DKK", "PLN"];
const EURO_REGIONS = new Set([
    "AT", "BE", "BG", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR",
    "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK",
]);
const REGION_CURRENCY = {
    US: "USD", GB: "GBP", CH: "CHF", CA: "CAD", AU: "AUD", JP: "JPY",
    IN: "INR", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN",
};
const SVG_NS = "http://www.w3.org/2000/svg";

const $ = (id) => document.getElementById(id);
const thisYear = new Date().getFullYear();
const monthYear = new Intl.DateTimeFormat("en", { month: "long", year: "numeric" });

let currency = "USD";
let fmt = makeFormatters(currency);
let model = null; // the last computed results
let chartView = null; // scales and hover elements of the drawn chart
let pendingFrame = 0;

// ---------------------------------------------------------------- formatting

function makeFormatters(code) {
    const money = new Intl.NumberFormat(undefined, {
        style: "currency", currency: code, minimumFractionDigits: 0, maximumFractionDigits: 0,
    });
    const compact = new Intl.NumberFormat(undefined, {
        style: "currency", currency: code, notation: "compact", minimumFractionDigits: 0, maximumFractionDigits: 1,
    });
    const percent = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 2 });
    const symbol = money.formatToParts(0).find((part) => part.type === "currency")?.value ?? code;
    const tidy = (x) => (Math.abs(x) < 0.5 ? 0 : x); // never print "-€0"
    return {
        money: (x) => money.format(tidy(x)),
        compact: (x) => compact.format(tidy(x)),
        percent: (x) => percent.format(x),
        symbol,
    };
}

const ageAt = (plan, months) => Math.floor(plan.age + months / 12 + 1e-9);
const formatAge = (age) => (Number.isInteger(age) ? String(age) : age.toFixed(1));

function ordinal(n) {
    const lastTwo = n % 100;
    if (lastTwo >= 11 && lastTwo <= 13) return `${n}th`;
    return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/** "by your 50th birthday": the goal is the exact day you turn that age, not any day while you are that age. */
const byGoal = (plan) =>
    Number.isInteger(plan.goalAge) ? `by your ${ordinal(plan.goalAge)} birthday` : `by age ${formatAge(plan.goalAge)}`;
const targetName = (plan) => `${fmt.money(plan.target)}${plan.targetReal ? " in today's money" : ""}`;

function dateAfter(months) {
    const now = new Date();
    return monthYear.format(new Date(now.getFullYear(), now.getMonth() + months, 1));
}

function chanceText(rate, certain) {
    if (certain) return fmt.percent(rate);
    if (rate < 0.01) return `<${fmt.percent(0.01)}`;
    if (rate > 0.99) return `>${fmt.percent(0.99)}`;
    return fmt.percent(Math.round(rate * 100) / 100);
}

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function svgNode(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
    parent?.append(node);
    return node;
}

// ---------------------------------------------------------------- currency and storage

function guessCurrency() {
    try {
        const region = new Intl.Locale(navigator.language).maximize().region;
        if (EURO_REGIONS.has(region)) return "EUR";
        return REGION_CURRENCY[region] ?? "USD";
    } catch {
        return "USD";
    }
}

function setCurrency(code) {
    currency = code;
    fmt = makeFormatters(code);
    $("currency").value = code;
    for (const node of document.querySelectorAll("[data-currency-symbol]")) node.textContent = fmt.symbol;
}

function loadSaved() {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
        if (!saved || typeof saved !== "object") return null;
        const plan = { ...DEFAULT_PLAN };
        for (const key of NUMBER_FIELDS) {
            if (typeof saved.plan?.[key] === "number") plan[key] = saved.plan[key];
        }
        plan.targetReal = saved.plan?.targetReal === true;
        return {
            plan: Object.keys(validatePlan(plan)).length ? null : plan,
            currency: CURRENCIES.includes(saved.currency) ? saved.currency : null,
        };
    } catch {
        return null;
    }
}

function save(plan) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ plan, currency }));
    } catch {
        // Storage can be unavailable (private windows, blocked site data). The page works without it.
    }
}

// ---------------------------------------------------------------- form

function readForm() {
    const plan = { targetReal: $("targetReal").checked };
    for (const key of NUMBER_FIELDS) {
        const input = $(key);
        const value = input.value.trim() === "" ? NaN : input.valueAsNumber;
        plan[key] = PERCENT_FIELDS.has(key) ? value / 100 : value;
    }
    return plan;
}

function writeForm(plan) {
    for (const key of NUMBER_FIELDS) {
        const value = PERCENT_FIELDS.has(key) ? plan[key] * 100 : plan[key];
        $(key).value = String(Number(value.toFixed(6))); // 0.07 * 100 shows as 7, not 7.000000000000001
    }
    $("targetReal").checked = plan.targetReal;
}

function showErrors(errors) {
    for (const key of NUMBER_FIELDS) {
        const message = errors[key] ?? "";
        const input = $(key);
        const error = $(`${key}-error`);
        input.setAttribute("aria-invalid", String(Boolean(message)));
        input.closest(".control").classList.toggle("is-invalid", Boolean(message));
        error.textContent = message;
        error.hidden = !message;
        if (message && ADVANCED_FIELDS.has(key)) $("more").open = true;
    }
}

function buildPresets() {
    const group = $("presets");
    for (const preset of PRESETS) {
        const button = el("button", "chip");
        button.type = "button";
        button.dataset.preset = preset.id;
        button.setAttribute("aria-pressed", "false");
        button.title = `${fmt.percent(preset.annualReturn)} a year, ${fmt.percent(preset.volatility)} volatility`;
        // The space keeps the accessible name readable ("Cash 2%"); the grid layout doesn't render it.
        button.append(el("span", "chip-name", preset.label), " ", el("span", "chip-rate", fmt.percent(preset.annualReturn)));
        button.addEventListener("click", () => {
            $("annualReturn").value = String(Number((preset.annualReturn * 100).toFixed(6)));
            $("volatility").value = String(Number((preset.volatility * 100).toFixed(6)));
            update();
        });
        group.append(button);
    }
}

function syncPresets(plan) {
    for (const preset of PRESETS) {
        const active =
            Math.abs(plan.annualReturn - preset.annualReturn) < 1e-9 &&
            Math.abs(plan.volatility - preset.volatility) < 1e-9;
        document.querySelector(`[data-preset="${preset.id}"]`).setAttribute("aria-pressed", String(active));
    }
}

function buildCurrencies() {
    let names = null;
    try {
        names = new Intl.DisplayNames(["en"], { type: "currency" });
    } catch {
        // Older browsers: show the bare codes.
    }
    for (const code of CURRENCIES) {
        const option = el("option", "", names ? `${code} · ${names.of(code)}` : code);
        option.value = code;
        $("currency").append(option);
    }
}

function onFormEvent(event) {
    if (event.target.id === "currency" && event.target.value !== currency) setCurrency(event.target.value);
    if (!pendingFrame) {
        pendingFrame = requestAnimationFrame(() => {
            pendingFrame = 0;
            update();
        });
    }
}

// ---------------------------------------------------------------- model

function buildModel(plan) {
    const goalMonths = goalMonthsOf(plan);
    const hit = monthsToTarget(plan);
    const years = chartYears(goalMonths, hit);
    const months = years * 12;
    return {
        plan,
        goalMonths,
        hit,
        years,
        months,
        path: project(plan, months),
        sim: simulate(plan, months, { goalMonths, paths: SIM_PATHS, seed: SIM_SEED }),
        needed: requiredMonthly(plan, goalMonths),
        levers: hit === 0 ? [] : leverScenarios(plan),
    };
}

function update() {
    const plan = readForm();
    const errors = validatePlan(plan);
    showErrors(errors);
    const valid = Object.keys(errors).length === 0;
    $("results").classList.toggle("is-stale", !valid);
    $("verdict").classList.toggle("is-stale", !valid);
    $("stale-note").hidden = valid;
    if (!valid) return;

    syncPresets(plan);
    model = buildModel(plan);
    renderVerdict(model);
    renderSummary(model);
    renderInflation(model);
    drawChart(model);
    renderLevers(model);
    renderYears(model);
    save(plan);
}

// ---------------------------------------------------------------- results

function renderVerdict({ plan, hit }) {
    const figure = $("verdict-figure");
    if (hit === 0) {
        $("verdict-lead").textContent = `You already have ${targetName(plan)}.`;
        figure.textContent = "Today";
        $("verdict-sub").textContent = "Your savings cover the target right now.";
    } else if (hit === null) {
        $("verdict-lead").textContent = `At this pace you won't reach ${targetName(plan)} within`;
        figure.textContent = `${MAX_YEARS} years`;
        $("verdict-sub").textContent = "Invest more each month, or check your expected return.";
    } else {
        $("verdict-lead").textContent = `You reach ${targetName(plan)} at age`;
        figure.textContent = String(ageAt(plan, hit));
        $("verdict-sub").textContent = `in ${formatDuration(hit)} · around ${dateAfter(hit)}`;
    }
    figure.dataset.size = figure.textContent.length > 3 ? "long" : "short";
}

function pill(text) {
    return el("span", "pill", text);
}

function renderSummary({ plan, goalMonths, hit, needed, sim, path }) {
    const by = byGoal(plan);
    const per = plan.raise === 0
        ? " a month"
        : ` a month, ${plan.raise > 0 ? "rising" : "falling"} ${fmt.percent(Math.abs(plan.raise))} a year`;

    // What the projection needs to hold the target at the goal age.
    $("need-label").textContent = `Monthly amount to get there ${by}`;
    $("need-value").textContent = fmt.money(Math.ceil(needed));
    $("need-per").textContent = per;
    const needNote = $("need-note");
    if (needed === 0) {
        needNote.replaceChildren(pill("On track"), "Your current savings grow to the target on their own.");
    } else if (plan.monthly >= needed) {
        needNote.replaceChildren(pill("On track"), `Your ${fmt.money(plan.monthly)} a month covers it.`);
    } else {
        needNote.replaceChildren(
            `That's ${fmt.money(Math.ceil(needed - plan.monthly))} more than you invest now, ` +
            `at a steady ${fmt.percent(netReturn(plan))} a year after fees.`,
        );
    }

    // The odds, from the simulated markets.
    $("chance-label").textContent = `Chance of getting there ${by}`;
    $("chance-value").textContent = chanceText(sim.successRate, plan.volatility === 0);
    $("chance-note").textContent =
        `Share of ${SIM_PATHS.toLocaleString("en")} simulated markets in which your plan ` +
        `(${fmt.money(plan.monthly)} a month) gets there.`;

    const safe = monthlyForChance(sim, 0.9);
    $("safe-label").textContent = `Monthly amount for a ${fmt.percent(0.9)} chance ${by}`;
    $("safe-value").textContent = fmt.money(Math.ceil(safe));
    $("safe-per").textContent = per;
    $("safe-note").textContent = safe === 0
        ? "Your current savings get there in at least 9 of 10 simulated markets."
        : "Enough in 9 of 10 simulated markets, weak ones included.";

    // Where the balance comes from: at the finish, or at the goal age if there is no finish yet.
    const at = hit > 0 ? hit : goalMonths;
    const balance = path.balance[at];
    const invested = path.invested[at];
    const growth = balance - invested;
    const total = invested + Math.max(growth, 0);
    const investedShare = total > 0 ? Math.round((invested / total) * 100) : 0;
    $("mix-label").textContent = `Your balance at ${ageAt(plan, at)}, and where it comes from`;
    $("mix-value").textContent = fmt.money(balance);
    $("mix-in-bar").style.flex = `${total > 0 ? invested / total : 0} 1 0`;
    $("mix-growth-bar").style.flex = `${total > 0 ? Math.max(growth, 0) / total : 0} 1 0`;
    $("mix-in-bar").hidden = invested <= 0;
    $("mix-growth-bar").hidden = growth <= 0;
    $("mix-in").textContent = `${fmt.money(invested)} · ${fmt.percent(investedShare / 100)}`;
    $("mix-growth").textContent = growth >= 0
        ? `${fmt.money(growth)} · ${fmt.percent((100 - investedShare) / 100)}`
        : `${fmt.money(growth)} (a loss)`;
    $("mix-bar").setAttribute(
        "aria-label",
        growth >= 0
            ? `You put in ${fmt.money(invested)}, ${investedShare}%; growth adds ${fmt.money(growth)}, ${100 - investedShare}%.`
            : `You put in ${fmt.money(invested)}; returns lost ${fmt.money(-growth)}.`,
    );
}

function renderInflation({ plan, hit, goalMonths }) {
    const at = hit > 0 ? hit : goalMonths;
    const when = dateAfter(at);
    const rate = fmt.percent(plan.inflation);
    const note = $("inflation-note");
    if (plan.inflation === 0) {
        note.textContent = "With 0% inflation, future amounts keep today's buying power.";
    } else if (plan.targetReal) {
        note.textContent =
            `Your target is in today's money, so by ${when} you'd need about ${fmt.money(targetAt(plan, at))} ` +
            `to buy what ${fmt.money(plan.target)} buys today, at ${rate} inflation a year.`;
    } else {
        note.textContent =
            `In ${when}, ${fmt.money(plan.target)} will buy about what ` +
            `${fmt.money(todaysMoney(plan.target, plan.inflation, at))} buys today, at ${rate} inflation a year.`;
    }
}

function renderLevers({ plan, hit, levers }) {
    $("levers").hidden = hit === 0;
    if (hit === 0) return;
    const label = {
        monthly: (lever) => `Invest ${fmt.money(lever.step)} more a month`,
        raise: (lever) => plan.raise === 0
            ? `Raise your monthly amount by ${fmt.percent(lever.plan.raise)} every year`
            : `Raise your monthly amount by ${fmt.percent(lever.plan.raise)} a year instead of ${fmt.percent(plan.raise)}`,
        "return-up": (lever) => `Earn ${fmt.percent(lever.plan.annualReturn)} a year instead of ${fmt.percent(plan.annualReturn)}`,
        "return-down": (lever) => `Earn ${fmt.percent(lever.plan.annualReturn)} a year instead of ${fmt.percent(plan.annualReturn)}`,
    };
    const items = levers.map((lever) => {
        const reach = el("span", "lever-when");
        if (lever.months === null) {
            reach.textContent = `Not within ${MAX_YEARS} years`;
        } else {
            reach.append(el("strong", "", `Age ${ageAt(plan, lever.months)}`), " ", el("span", "cell-sub", dateAfter(lever.months)));
        }
        const item = el("li", "lever");
        item.append(el("span", "lever-what", label[lever.id](lever)), reach, changeCell(hit, lever.months));
        return item;
    });
    $("levers-list").replaceChildren(...items);
}

function changeCell(base, months) {
    const cell = el("span", "change");
    if (base === null && months === null) {
        cell.textContent = "Still out of reach";
    } else if (base === null) {
        cell.textContent = "Within reach";
        cell.classList.add("is-good");
    } else if (months === null) {
        cell.textContent = "Out of reach";
        cell.classList.add("is-bad");
    } else if (months < base) {
        cell.textContent = `${formatDuration(base - months)} sooner`;
        cell.classList.add("is-good");
    } else if (months > base) {
        cell.textContent = `${formatDuration(months - base)} later`;
        cell.classList.add("is-bad");
    } else {
        cell.textContent = "No change";
    }
    return cell;
}

function renderYears({ plan, years, path, sim }) {
    const rows = [];
    let marked = false;
    for (let year = 0; year <= years; year++) {
        const m = year * 12;
        const balance = path.balance[m];
        const invested = path.invested[m];
        const balanceCell = el("td", "num", fmt.money(balance));
        const row = el("tr");
        if (!marked && reached(balance, targetAt(plan, m))) {
            marked = true;
            row.className = "is-hit";
            balanceCell.append(el("span", "sr-only", " (first birthday at your target)"));
        }
        row.append(
            el("td", "num", String(ageAt(plan, m))),
            el("td", "num", String(thisYear + year)),
            el("td", "num", fmt.money(invested)),
            el("td", "num", fmt.money(balance - invested)),
            balanceCell,
            el("td", "num", `${fmt.compact(sim.low[year])} – ${fmt.compact(sim.high[year])}`),
            el("td", "num", fmt.money(todaysMoney(balance, plan.inflation, m))),
        );
        rows.push(row);
    }
    $("years-body").replaceChildren(...rows);
    $("years-caption").textContent =
        `Balances on each birthday, treating today as the day you turned ${formatAge(plan.age)}. ` +
        "The marked row is the first birthday at or above your target.";
}

// ---------------------------------------------------------------- chart

function linePath(values, months, x, y) {
    let d = "";
    for (let m = 0; m <= months; m++) {
        d += `${m ? "L" : "M"}${x(m / 12).toFixed(1)},${y(values[m]).toFixed(1)}`;
    }
    return d;
}

function drawChart(current) {
    const { plan, years, months, path, sim, goalMonths, hit } = current;
    const box = $("chart");
    const svg = $("chart-svg");
    const width = Math.max(260, Math.round(box.clientWidth || 640));
    const height = width < 560 ? 250 : 320;

    // One vertical scale for everything drawn: projection, money put in and target, plus headroom.
    // The simulated range may run off the top; it is clipped to the plot.
    let peak = Math.max(plan.target, targetAt(plan, months));
    for (let m = 0; m <= months; m++) peak = Math.max(peak, path.balance[m], path.invested[m]);
    const scale = niceTicks(peak * 1.06, height < 300 ? 4 : 5);
    const tickLabels = scale.ticks.map((value) => fmt.compact(value));

    svg.replaceChildren();
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));

    // Measure the widest axis label so the plot starts right after it.
    const probe = svgNode("text", { class: "axis-label" }, svg);
    let labelWidth = 0;
    for (const label of tickLabels) {
        probe.textContent = label;
        labelWidth = Math.max(labelWidth, probe.getComputedTextLength() || label.length * 7);
    }
    probe.remove();

    const pad = { top: 28, right: 18, bottom: 30, left: Math.ceil(labelWidth) + 14 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const x = (yearsFromNow) => pad.left + (yearsFromNow / years) * plotW;
    const y = (value) => pad.top + plotH - (Math.max(0, value) / scale.top) * plotH;

    const defs = svgNode("defs", {}, svg);
    const clip = svgNode("clipPath", { id: "plot-clip" }, defs);
    svgNode("rect", { x: pad.left, y: pad.top - 2, width: plotW, height: plotH + 4 }, clip);

    // Grid and axes
    const axes = svgNode("g", {}, svg);
    scale.ticks.forEach((value, i) => {
        if (i > 0) svgNode("line", { class: "grid-line", x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value) }, axes);
        svgNode("text", { class: "axis-label", x: pad.left - 10, y: y(value), dy: "0.32em", "text-anchor": "end" }, axes)
            .textContent = tickLabels[i];
    });
    svgNode("line", { class: "axis-line", x1: pad.left, x2: width - pad.right, y1: y(0), y2: y(0) }, axes);
    const maxLabels = Math.max(2, Math.floor(plotW / 40));
    const step = [1, 2, 5, 10, 20, 25, 50].find((s) => years / s <= maxLabels) ?? 50;
    for (let age = Math.ceil(plan.age / step - 1e-9) * step; age <= plan.age + years + 1e-9; age += step) {
        svgNode("text", { class: "axis-label", x: x(age - plan.age), y: height - pad.bottom + 19, "text-anchor": "middle" }, axes)
            .textContent = String(age);
    }

    // Series
    const plot = svgNode("g", { "clip-path": "url(#plot-clip)" }, svg);
    let band = "";
    for (let yr = 0; yr <= years; yr++) band += `${yr ? "L" : "M"}${x(yr).toFixed(1)},${y(sim.high[yr]).toFixed(1)}`;
    for (let yr = years; yr >= 0; yr--) band += `L${x(yr).toFixed(1)},${y(sim.low[yr]).toFixed(1)}`;
    svgNode("path", { class: "band", d: `${band}Z` }, plot);

    const investedLine = linePath(path.invested, months, x, y);
    svgNode("path", {
        class: "invested-area",
        d: `${investedLine}L${x(years).toFixed(1)},${y(0).toFixed(1)}L${x(0).toFixed(1)},${y(0).toFixed(1)}Z`,
    }, plot);
    svgNode("path", { class: "invested-line", d: investedLine }, plot);

    let targetPath = `M${x(0)},${y(plan.target)}L${x(years)},${y(plan.target)}`;
    if (plan.targetReal) {
        targetPath = "";
        for (let yr = 0; yr <= years; yr++) targetPath += `${yr ? "L" : "M"}${x(yr).toFixed(1)},${y(targetAt(plan, yr * 12)).toFixed(1)}`;
    }
    svgNode("path", { class: "target-line", d: targetPath }, plot);
    svgNode("path", { class: "projection", d: linePath(path.balance, months, x, y) }, plot);

    // Goal age marker
    const goalX = x(goalMonths / 12);
    svgNode("line", { class: "goal-line", x1: goalX, x2: goalX, y1: pad.top, y2: pad.top + plotH }, svg);
    const goalAnchor = goalX < pad.left + 40 ? "start" : goalX > width - pad.right - 40 ? "end" : "middle";
    svgNode("text", { class: "chart-label is-muted", x: goalX, y: pad.top - 10, "text-anchor": goalAnchor }, svg)
        .textContent = `Goal: ${formatAge(plan.goalAge)}`;

    // Target label at the right end, on the side away from the projection
    const endTarget = targetAt(plan, months);
    let labelY = path.balance[months] >= endTarget ? y(endTarget) + 17 : y(endTarget) - 8;
    if (labelY > pad.top + plotH - 6) labelY = y(endTarget) - 8;
    if (labelY < pad.top + 12) labelY = y(endTarget) + 17;
    svgNode("text", { class: "chart-label", x: width - pad.right - 4, y: labelY, "text-anchor": "end" }, svg)
        .textContent = `Target ${fmt.compact(plan.target)}${plan.targetReal ? " in today's money" : ""}`;

    // The month the projection reaches the target
    if (hit > 0 && hit <= months) {
        const hx = x(hit / 12);
        const hy = y(path.balance[hit]);
        svgNode("circle", { class: "hit-dot", cx: hx, cy: hy, r: 5 }, svg);
        const left = hx - pad.left > 90;
        svgNode("text", { class: "chart-label", x: left ? hx - 10 : hx + 10, y: hy - 10, "text-anchor": left ? "end" : "start" }, svg)
            .textContent = `Age ${ageAt(plan, hit)}`;
    }

    // Hover layer
    const cross = svgNode("g", { visibility: "hidden" }, svg);
    const crossLine = svgNode("line", { class: "cross-line", y1: pad.top, y2: pad.top + plotH }, cross);
    const crossInvested = svgNode("circle", { class: "cross-dot-invested", r: 4 }, cross);
    const crossDot = svgNode("circle", { class: "cross-dot", r: 5 }, cross);
    const previousYear = chartView?.year ?? null;
    chartView = { model: current, width, pad, plotW, x, y, cross, crossLine, crossDot, crossInvested, year: null };
    if (previousYear !== null) showYear(Math.min(previousYear, years));

    const finish = hit === null
        ? `It does not reach ${targetName(plan)} within ${MAX_YEARS} years.`
        : hit === 0
            ? `You already have ${targetName(plan)}.`
            : `The projection reaches ${targetName(plan)} at age ${ageAt(plan, hit)}.`;
    box.setAttribute(
        "aria-label",
        `Chart of your projected balance from age ${formatAge(plan.age)} to ${ageAt(plan, months)}. ${finish} ` +
        "The year-by-year table lists every value.",
    );
}

function tooltipRow(keyClass, value, label) {
    const row = el("div", "tooltip-row");
    const key = el("i", keyClass ? `key ${keyClass}` : "key");
    key.setAttribute("aria-hidden", "true");
    row.append(key, el("strong", "", value), el("span", "", label));
    return row;
}

function showYear(year) {
    if (!chartView) return;
    const { model: current, width, x, y, cross, crossLine, crossDot, crossInvested } = chartView;
    const { plan, path, sim } = current;
    const m = year * 12;
    const cx = x(year);
    crossLine.setAttribute("x1", String(cx));
    crossLine.setAttribute("x2", String(cx));
    crossDot.setAttribute("cx", String(cx));
    crossDot.setAttribute("cy", String(y(path.balance[m])));
    crossInvested.setAttribute("cx", String(cx));
    crossInvested.setAttribute("cy", String(y(path.invested[m])));
    cross.setAttribute("visibility", "visible");
    chartView.year = year;

    const tip = $("tooltip");
    tip.replaceChildren(
        el("p", "tooltip-head", `Age ${ageAt(plan, m)} · ${thisYear + year}`),
        tooltipRow("key-line", fmt.money(path.balance[m]), "Projection"),
        tooltipRow("key-band", `${fmt.compact(sim.low[year])} – ${fmt.compact(sim.high[year])}`, "Middle 80% of markets"),
        tooltipRow("key-invested", fmt.money(path.invested[m]), "You put in"),
        tooltipRow(null, fmt.money(todaysMoney(path.balance[m], plan.inflation, m)), "Projection in today's money"),
    );
    tip.hidden = false;
    const box = $("chart");
    const px = (cx / width) * box.clientWidth;
    let left = px + 14;
    if (left + tip.offsetWidth > box.clientWidth - 4) left = px - 14 - tip.offsetWidth;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = "8px";
}

function hideYear() {
    if (!chartView) return;
    chartView.year = null;
    chartView.cross.setAttribute("visibility", "hidden");
    $("tooltip").hidden = true;
}

function setupChart() {
    const box = $("chart");
    const yearAt = (event) => {
        const rect = box.getBoundingClientRect();
        const { width, pad, plotW, model: current } = chartView;
        const px = ((event.clientX - rect.left) / rect.width) * width;
        const year = Math.round(((px - pad.left) / plotW) * current.years);
        return Math.min(current.years, Math.max(0, year));
    };
    box.addEventListener("pointermove", (event) => chartView && showYear(yearAt(event)));
    box.addEventListener("pointerdown", (event) => chartView && showYear(yearAt(event)));
    box.addEventListener("pointerleave", (event) => {
        if (event.pointerType === "mouse" && document.activeElement !== box) hideYear();
    });
    document.addEventListener("pointerdown", (event) => {
        if (!box.contains(event.target)) hideYear();
    });
    box.addEventListener("focus", () => {
        if (chartView && chartView.year === null) {
            const { hit, goalMonths, years } = chartView.model;
            showYear(Math.min(years, Math.round((hit > 0 ? hit : goalMonths) / 12)));
        }
    });
    box.addEventListener("blur", hideYear);
    box.addEventListener("keydown", (event) => {
        if (!chartView) return;
        const last = chartView.model.years;
        let year = chartView.year ?? 0;
        if (event.key === "ArrowRight") year += 1;
        else if (event.key === "ArrowLeft") year -= 1;
        else if (event.key === "Home") year = 0;
        else if (event.key === "End") year = last;
        else if (event.key === "Escape") return hideYear();
        else return;
        event.preventDefault();
        showYear(Math.min(last, Math.max(0, year)));
    });

    if ("ResizeObserver" in window) {
        let lastWidth = Math.round(box.clientWidth);
        new ResizeObserver(() => {
            const width = Math.round(box.clientWidth);
            if (width !== lastWidth && model) {
                lastWidth = width;
                drawChart(model);
            }
        }).observe(box);
    }
}

// ---------------------------------------------------------------- start

function init() {
    buildCurrencies();
    const saved = loadSaved();
    setCurrency(saved?.currency ?? guessCurrency());
    buildPresets();
    writeForm(saved?.plan ?? DEFAULT_PLAN);

    const form = $("inputs");
    form.addEventListener("input", onFormEvent);
    form.addEventListener("change", onFormEvent);
    form.addEventListener("submit", (event) => event.preventDefault());
    $("reset").addEventListener("click", () => {
        writeForm(DEFAULT_PLAN);
        update();
    });
    setupChart();
    update();
}

init();
