import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fetchModelPricing,
  fetchOpencodeGoPricing,
  type ModelPricing,
} from "./pricing";

const CACHE_DIR = join(process.cwd(), ".benchmark-cache");
const REPORT_PATH = join(CACHE_DIR, "benchmark-report.json");
const OUTPUT_PATH =
  "/home/oscar/.gemini/antigravity-cli/brain/899f743e-74cf-4cae-abf2-c8ec532da6b8/dashboard.html";

interface TraceGroup {
  algorithms: Record<string, unknown>;
  name: string;
  source: string;
}

function getSourceFolder(source: string): string {
  if (source === "swe-agent") {
    return "swe-agent-trajectories";
  }
  if (source === "oni-devops") {
    return "oni-devops-traces";
  }
  return "toolathlon-trajectories";
}

function processReportResults(
  report: Record<string, unknown>
): Map<string, TraceGroup> {
  const traceMap = new Map<string, TraceGroup>();

  for (const [key, results] of Object.entries(report)) {
    const parts = key.split(":");
    if (parts.length < 3) {
      continue;
    }
    const [source, algoName, window] = parts;
    if (!(source && algoName) || window !== "200000") {
      continue;
    }

    const list = results as Record<string, unknown>[];
    for (const res of list) {
      const metadata = res.metadata as Record<string, unknown> | undefined;
      const traceName =
        (metadata?.task_name as string) ||
        (metadata?.instance_id as string) ||
        (metadata?.trace_id as string) ||
        "trace";
      const traceKey = `${source}::${traceName}`;

      let traceObj = traceMap.get(traceKey);
      if (!traceObj) {
        traceObj = {
          algorithms: {},
          name: traceName,
          source: getSourceFolder(source),
        };
        traceMap.set(traceKey, traceObj);
      }

      traceObj.algorithms[algoName] = {
        replacedCount: res.replacedCount,
        totalArchiveChars: res.totalArchiveChars,
        totalReplacedChars: res.totalReplacedChars,
        turnResults: res.turnResults,
      };
    }
  }

  return traceMap;
}

async function main() {
  if (!existsSync(REPORT_PATH)) {
    throw new Error(
      "benchmark-report.json missing! Run bun run benchmark first."
    );
  }

  console.log("Loading pricing cards...");
  const pricing = await fetchOpencodeGoPricing(CACHE_DIR);
  const copilotOpus = await fetchModelPricing(
    CACHE_DIR,
    "github-copilot",
    "claude-opus-4.5"
  );
  if (copilotOpus) {
    pricing.push(copilotOpus);
  }
  const neonOpus = await fetchModelPricing(
    CACHE_DIR,
    "neon",
    "claude-opus-4-5"
  );
  if (neonOpus) {
    pricing.push(neonOpus);
  }

  console.log("Loading report data...");
  const report = JSON.parse(readFileSync(REPORT_PATH, "utf8")) as Record<
    string,
    unknown
  >;

  const traceMap = processReportResults(report);

  // Group traceMap entries by source
  const grouped: Record<string, TraceGroup[]> = {
    "oni-devops-traces": [],
    "swe-agent-trajectories": [],
    "toolathlon-trajectories": [],
  };

  for (const trace of traceMap.values()) {
    grouped[trace.source]?.push(trace);
  }

  const curatedTraces: Record<string, TraceGroup[]> = {
    "oni-devops-traces": [],
    "swe-agent-trajectories": [],
    "toolathlon-trajectories": [],
  };

  // Sort each group by number of turns in no-replacement to get the longest traces
  for (const source of Object.keys(grouped)) {
    const list = grouped[source] || [];
    list.sort((a, b) => {
      const noReplA = a.algorithms["no-replacement"] as {
        turnResults: unknown[];
      };
      const noReplB = b.algorithms["no-replacement"] as {
        turnResults: unknown[];
      };
      const aTurns = noReplA.turnResults.length;
      const bTurns = noReplB.turnResults.length;
      return bTurns - aTurns;
    });
    // Take top 5 longest traces
    curatedTraces[source] = list.slice(0, 5);
  }

  const htmlContent = getHtmlTemplate(pricing, curatedTraces);
  writeFileSync(OUTPUT_PATH, htmlContent, "utf8");
  console.log(`Dashboard written to ${OUTPUT_PATH}`);
}

function getHtmlTemplate(
  pricing: ModelPricing[],
  traceData: Record<string, TraceGroup[]>
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pi Context Trimmer Dashboard</title>
  <!-- Chart.js -->
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg: #0d1117;
      --bg-panel: #161b22;
      --border: #30363d;
      --text: #c9d1d9;
      --text-muted: #8b949e;
      --accent-blue: #58a6ff;
      --accent-green: #3fb950;
      --accent-purple: #bc8cff;
      --accent-red: #f85149;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      height: 100vh;
      overflow: hidden;
    }

    /* Sidebar */
    .sidebar {
      width: 280px;
      background: var(--bg-panel);
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      padding: 20px;
      overflow-y: auto;
      gap: 20px;
    }

    .title {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }

    .control {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .control-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
    }

    select, input[type="range"] {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 4px;
      color: var(--text);
      padding: 8px 10px;
      font-size: 13px;
      outline: none;
    }

    /* Main Area */
    .content {
      flex: 1;
      display: flex;
      flex-direction: column;
      padding: 24px;
      overflow-y: auto;
      gap: 20px;
    }

    /* KPIs */
    .kpis {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
    }

    .kpi-card {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .kpi-title {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 500;
    }

    .kpi-val {
      font-size: 20px;
      font-weight: 600;
      font-family: monospace;
    }

    .kpi-desc {
      font-size: 11px;
      color: var(--text-muted);
    }

    .green { color: var(--accent-green); }
    .red { color: var(--accent-red); }

    /* Charts */
    .charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 20px;
      min-height: 380px;
    }

    .chart-card {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .chart-title {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    .chart-box {
      position: relative;
      flex: 1;
      width: 100%;
    }

    /* Table */
    .details {
      background: var(--bg-panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      text-align: left;
    }

    th, td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
    }

    th {
      color: var(--text-muted);
      font-weight: 500;
      text-transform: uppercase;
      font-size: 10px;
    }

    .badge {
      display: inline-block;
      padding: 2px 6px;
      border-radius: 2px;
      font-size: 10px;
      font-weight: 600;
      font-family: monospace;
      text-transform: uppercase;
    }

    .badge-green { background: rgba(63, 185, 80, 0.15); color: var(--accent-green); }
    .badge-cyan { background: rgba(88, 166, 255, 0.15); color: var(--accent-blue); }
    .badge-purple { background: rgba(188, 140, 255, 0.15); color: var(--accent-purple); }
    .badge-gray { background: rgba(139, 148, 158, 0.15); color: var(--text-muted); }
  </style>
</head>
<body>

  <div class="sidebar">
    <div class="title">Pi Context Trimmer</div>

    <div class="control">
      <label class="control-label" for="datasetSelect">Dataset</label>
      <select id="datasetSelect" onchange="onDatasetChange()">
        <option value="toolathlon-trajectories">Toolathlon Trajectories</option>
        <option value="swe-agent-trajectories">SWE-agent Trajectories</option>
        <option value="oni-devops-traces">Oni-devops SSH Traces</option>
      </select>
    </div>

    <div class="control">
      <label class="control-label" for="traceSelect">Trajectory</label>
      <select id="traceSelect" onchange="onTraceChange()">
        <!-- Dynamic -->
      </select>
    </div>

    <div class="control">
      <label class="control-label" for="modelSelect">Model Pricing</label>
      <select id="modelSelect" onchange="updateDashboard()">
        <!-- Dynamic -->
      </select>
    </div>

    <div class="control">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <label class="control-label" for="recallRate">Expected Recall</label>
        <span style="font-size:11px; font-weight:600; color:var(--accent-blue);" id="recallRateVal">20%</span>
      </div>
      <input type="range" id="recallRate" min="0" max="100" value="20" oninput="onRecallRateChange()">
    </div>
  </div>

  <div class="content">
    <div class="kpis">
      <div class="kpi-card">
        <span class="kpi-title">Baseline Cost</span>
        <span class="kpi-val" id="kpiBaseline">$0.0000</span>
        <span class="kpi-desc">Untrimmed run</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-title">Trimmer Cost</span>
        <span class="kpi-val" id="kpiTrimmer">$0.0000</span>
        <span class="kpi-desc">Context save + write</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-title">Recall Cost</span>
        <span class="kpi-val" id="kpiRecall">$0.0000</span>
        <span class="kpi-desc">On-demand retrieval</span>
      </div>
      <div class="kpi-card">
        <span class="kpi-title">Net Savings</span>
        <span class="kpi-val" id="kpiSavings">$0.0000</span>
        <span class="kpi-desc" id="kpiSavingsPct">0.00%</span>
      </div>
    </div>

    <div class="charts">
      <div class="chart-card">
        <span class="chart-title">Context Tokens per Turn</span>
        <div class="chart-box">
          <canvas id="contextChart"></canvas>
        </div>
      </div>
      <div class="chart-card">
        <span class="chart-title">Cumulative Cost Growth ($)</span>
        <div class="chart-box">
          <canvas id="costChart"></canvas>
        </div>
      </div>
    </div>

    <div class="details">
      <span class="chart-title" style="display:block; margin-bottom:12px;">Algorithm Metrics Comparison</span>
      <table>
        <thead>
          <tr>
            <th>Algorithm</th>
            <th>Turns</th>
            <th>Avg Compression</th>
            <th>Evicted</th>
            <th>Context Cost</th>
            <th>Recall Cost</th>
            <th>Total Cost</th>
            <th>Savings</th>
          </tr>
        </thead>
        <tbody id="metricsTableBody">
          <!-- Dynamic -->
        </tbody>
      </table>
    </div>
  </div>

  <script>
    const pricingCards = ${JSON.stringify(pricing)};
    const traceData = ${JSON.stringify(traceData)};

    let contextChart = null;
    let costChart = null;

    function init() {
      const modelSelect = document.getElementById("modelSelect");
      pricingCards.forEach((card, idx) => {
        const opt = document.createElement("option");
        opt.value = idx;
        opt.text = card.modelName + " (" + card.modelId.split("/")[0] + ")";
        if (card.modelId === "github-copilot/claude-opus-4.5") {
          opt.selected = true;
        }
        modelSelect.appendChild(opt);
      });
      onDatasetChange();
    }

    function onDatasetChange() {
      const dataset = document.getElementById("datasetSelect").value;
      const traces = traceData[dataset] || [];
      const traceSelect = document.getElementById("traceSelect");
      traceSelect.innerHTML = "";

      traces.forEach((trace, idx) => {
        const opt = document.createElement("option");
        opt.value = idx;
        const noRepl = trace.algorithms["no-replacement"];
        const turns = noRepl && noRepl.turnResults ? noRepl.turnResults.length : 0;
        opt.text = trace.name.slice(0, 35) + " (" + turns + " turns)";
        traceSelect.appendChild(opt);
      });
      onTraceChange();
    }

    function onTraceChange() {
      updateDashboard();
    }

    function onRecallRateChange() {
      const rate = document.getElementById("recallRate").value;
      document.getElementById("recallRateVal").innerText = rate + "%";
      updateDashboard();
    }

    function computeDollarCostForAlgo(algoResults, pricing, recallRateFactor) {
      const inputPrice = pricing.inputPrice / 1000000;
      const outputPrice = pricing.outputPrice / 1000000;
      const hasCaching = pricing.cacheReadPrice > 0;

      let lastBaselineTokens = 0;
      let cumulativeBaseline = 0;
      let cumulativeTrimmer = 0;
      let totalReplaced = 0;
      let totalReplacedChars = 0;

      const turns = algoResults || [];
      const turnCosts = [];

      for (let i = 0; i < turns.length; i++) {
        const turn = turns[i];

        const baselineCacheRead = lastBaselineTokens;
        const baselineCacheWrite = Math.max(0, turn.baselineTokens - lastBaselineTokens);
        lastBaselineTokens = turn.baselineTokens;

        const baselineUseOver200k = turn.baselineTokens > 200000;
        const bInPrice = (baselineUseOver200k ? pricing.inputPriceOver200k : pricing.inputPrice) / 1000000;
        const bCacheRead = (baselineUseOver200k ? pricing.cacheReadPriceOver200k : pricing.cacheReadPrice) / 1000000;
        const bCacheWrite = (baselineUseOver200k ? pricing.cacheWritePriceOver200k : pricing.cacheWritePrice) / 1000000;

        let bCost = 0;
        if (hasCaching) {
          bCost = baselineCacheRead * bCacheRead + baselineCacheWrite * bCacheWrite;
        } else {
          bCost = turn.baselineTokens * bInPrice;
        }
        cumulativeBaseline += bCost;

        const trimmerUseOver200k = turn.compiledTokens > 200000;
        const tInPrice = (trimmerUseOver200k ? pricing.inputPriceOver200k : pricing.inputPrice) / 1000000;
        const tCacheRead = (trimmerUseOver200k ? pricing.cacheReadPriceOver200k : pricing.cacheReadPrice) / 1000000;
        const tCacheWrite = (trimmerUseOver200k ? pricing.cacheWritePriceOver200k : pricing.cacheWritePrice) / 1000000;

        let tCost = 0;
        if (hasCaching) {
          tCost = turn.cacheReadTokens * tCacheRead + turn.cacheWriteTokens * tCacheWrite;
        } else {
          tCost = turn.compiledTokens * tInPrice;
        }
        cumulativeTrimmer += tCost;

        totalReplaced += turn.replacedArchives;
        totalReplacedChars += turn.replacedChars;

        const RECALL_INPUT_TOKENS = 50;
        const avgRecalledTokens = totalReplaced === 0 ? 0 : (totalReplacedChars / 4) / totalReplaced;
        const recallCost = (totalReplaced * recallRateFactor) * 
          (RECALL_INPUT_TOKENS * tInPrice + avgRecalledTokens * outputPrice);

        turnCosts.push({
          baseline: cumulativeBaseline,
          trimmer: cumulativeTrimmer,
          recall: recallCost,
          total: cumulativeTrimmer + recallCost,
        });
      }

      return turnCosts;
    }

    function updateDashboard() {
      const datasetName = document.getElementById("datasetSelect").value;
      const traceIdx = document.getElementById("traceSelect").value;
      const modelIdx = document.getElementById("modelSelect").value;
      const recallRateVal = document.getElementById("recallRate").value;
      
      const traces = traceData[datasetName] || [];
      const trace = traces[traceIdx];
      const pricing = pricingCards[modelIdx];

      if (!trace || !pricing) return;

      const recallRateFactor = parseFloat(recallRateVal) / 100.0;

      const algos = ["no-replacement", "unoptimized-production", "optimized-production", "optimized-cache-aware"];
      const colors = {
        "no-replacement": "#8b949e",
        "unoptimized-production": "#bc8cff",
        "optimized-production": "#3fb950",
        "optimized-cache-aware": "#58a6ff",
      };

      const chartDataSetsContext = [];
      const chartDataSetsCost = [];
      const tableRows = [];

      algos.forEach((algo) => {
        const algoObj = trace.algorithms[algo];
        if (!algoObj) return;
        const turnData = algoObj.turnResults || [];
        if (turnData.length === 0) return;

        const contextPoints = turnData.map(t => t.compiledTokens);
        const turnCosts = computeDollarCostForAlgo(turnData, pricing, recallRateFactor);
        const costPoints = turnCosts.map(c => c.total);

        chartDataSetsContext.push({
          label: algo,
          data: contextPoints,
          borderColor: colors[algo],
          backgroundColor: "transparent",
          borderWidth: 1.5,
          pointRadius: 0,
        });

        chartDataSetsCost.push({
          label: algo,
          data: costPoints,
          borderColor: colors[algo],
          backgroundColor: "transparent",
          borderWidth: 1.5,
          pointRadius: 0,
        });

        const lastCost = turnCosts[turnCosts.length - 1] || { baseline: 0, trimmer: 0, recall: 0, total: 0 };
        const compressionRatio = algoObj.totalArchiveChars === 0 ? 0 : 
          (algoObj.totalReplacedChars / algoObj.totalArchiveChars);
        const savings = lastCost.baseline - lastCost.total;
        const savingsPct = lastCost.baseline === 0 ? 0 : (savings / lastCost.baseline) * 100;

        tableRows.push({
          name: algo,
          turns: turnData.length,
          compression: (compressionRatio * 100).toFixed(1) + "%",
          replaced: algoObj.replacedCount,
          trimmerCost: lastCost.trimmer,
          recallCost: lastCost.recall,
          totalCost: lastCost.total,
          savings: savings,
          savingsPct: savingsPct,
        });

        if (algo === "optimized-production") {
          document.getElementById("kpiBaseline").innerText = "$" + lastCost.baseline.toFixed(4);
          document.getElementById("kpiTrimmer").innerText = "$" + lastCost.trimmer.toFixed(4);
          document.getElementById("kpiRecall").innerText = "$" + lastCost.recall.toFixed(4);
          
          const savingsEl = document.getElementById("kpiSavings");
          const savingsPctEl = document.getElementById("kpiSavingsPct");
          savingsEl.innerText = (savings >= 0 ? "+$" : "-$") + Math.abs(savings).toFixed(4);
          savingsPctEl.innerText = (savings >= 0 ? "+" : "") + savingsPct.toFixed(2) + "%";

          if (savings >= 0) {
            savingsEl.className = "kpi-val green";
            savingsPctEl.className = "kpi-desc green";
          } else {
            savingsEl.className = "kpi-val red";
            savingsPctEl.className = "kpi-desc red";
          }
        }
      });

      const noReplAlgo = trace.algorithms["no-replacement"];
      const maxTurns = noReplAlgo && noReplAlgo.turnResults ? noReplAlgo.turnResults.length : 0;
      const labels = Array.from({ length: maxTurns }, (_, i) => i + 1);
      renderContextChart(labels, chartDataSetsContext);
      renderCostChart(labels, chartDataSetsCost);

      const tbody = document.getElementById("metricsTableBody");
      tbody.innerHTML = "";
      tableRows.forEach((row) => {
        const tr = document.createElement("tr");
        const badgeClass = row.name === "optimized-production" ? "badge-green" : 
                           row.name === "optimized-cache-aware" ? "badge-cyan" : 
                           row.name === "no-replacement" ? "badge-gray" : "badge-purple";
        const savingsClass = row.savings >= 0 ? "green" : "red";

        tr.innerHTML = "<td><span class='badge " + badgeClass + "'>" + row.name + "</span></td>" +
          "<td>" + row.turns + "</td>" +
          "<td>" + row.compression + "</td>" +
          "<td>" + row.replaced + "</td>" +
          "<td>$" + row.trimmerCost.toFixed(4) + "</td>" +
          "<td>$" + row.recallCost.toFixed(4) + "</td>" +
          "<td>$" + row.totalCost.toFixed(4) + "</td>" +
          "<td class='" + savingsClass + "'>" + (row.savings >= 0 ? "+" : "") + row.savings.toFixed(4) + " (" + row.savingsPct.toFixed(1) + "%)</td>";
        tbody.appendChild(tr);
      });
    }

    function renderContextChart(labels, datasets) {
      if (contextChart) contextChart.destroy();
      const ctx = document.getElementById("contextChart").getContext("2d");
      contextChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } } },
            y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } } }
          }
        }
      });
    }

    function renderCostChart(labels, datasets) {
      if (costChart) costChart.destroy();
      const ctx = document.getElementById("costChart").getContext("2d");
      costChart = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: {
            x: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } } },
            y: { grid: { color: '#21262d' }, ticks: { color: '#8b949e', font: { size: 10 } } }
          }
        }
      });
    }

    window.onload = init;
  </script>
</body>
</html>`;
}

main().catch(console.error);
