"use strict";

const CASADI_BASE = "https://unpkg.com/@casadi/casadi-wasm@3.8.1/";
const EXAMPLES = [
  "accessing_mx_algorithm.js", "accessing_sx_algorithm.js", "biegler_10_1.js",
  "c_code_generation.js", "chain_qp.js", "dae_collocation.js",
  "dae_multiple_shooting.js", "dae_single_shooting.js", "direct_collocation.js",
  "direct_multiple_shooting.js", "direct_single_shooting.js", "implicit_runge-kutta.js",
  "multipoint_simulation.js", "nlp_codegen.js", "nlp_sensitivities.js",
  "parallel_map.js", "race_car.js", "rocket.js", "rosenbrock.js",
  "sensitivity_analysis.js", "simple_lp.js", "simple_nlp.js", "vdp_collocation.js",
  "vdp_dynamic_programming.js", "vdp_indirect_multiple_shooting.js", "browser_guide.js",
  "lgl_pseudospectral_opti.js", "blank.js"
];
const PLUGINS = {
  "chain_qp.js": [["conic", "qpoases"]],
  "simple_lp.js": [["conic", "qpoases"]],
  "nlp_sensitivities.js": [["conic", "qpoases"]],
  "dae_multiple_shooting.js": [["linsol", "qr"], ["rootfinder", "newton"], ["integrator", "collocation"]],
  "dae_single_shooting.js": [["linsol", "qr"], ["rootfinder", "newton"], ["integrator", "collocation"]],
  "multipoint_simulation.js": [["integrator", "rk"]],
  "sensitivity_analysis.js": [["linsol", "qr"], ["rootfinder", "newton"], ["integrator", "rk"], ["integrator", "collocation"]],
  "vdp_indirect_multiple_shooting.js": [["integrator", "rk"], ["linsol", "qr"]]
};

const editor = document.querySelector("#code-editor");
const lineNumbers = document.querySelector("#line-numbers");
const output = document.querySelector("#editor-output");
const choice = document.querySelector("#script-choice");
const runButton = document.querySelector("#editor-run");
const status = document.querySelector("#editor-status");
const runTime = document.querySelector("#run-time");
const fileInput = document.querySelector("#file-input");
const datasets = new Map();
const variableRecords = new Map();
const plotCanvas = document.querySelector("#plot");
const xDataset = document.querySelector("#x-dataset");
const yDataset = document.querySelector("#y-dataset");
let casadi;
let sourceCache = new Map();
let currentTimeHorizon = 1;

const nativeConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
window.consoleOutput = null;
for (const method of Object.keys(nativeConsole)) {
  console[method] = (...values) => {
    nativeConsole[method](...values);
    if (window.consoleOutput) window.consoleOutput(...values);
  };
}

async function evaluateCommonJs(base, file, requireFunction) {
  const response = await fetch(base + file);
  if (!response.ok) throw new Error(`${file}: ${response.status} ${response.statusText}`);
  const source = await response.text();
  const factory = new Function("module", "exports", "require", "__dirname", "__filename", source + "\n;return module.exports;");
  const module = { exports: {} };
  return factory(module, module.exports, requireFunction, base.replace(/\/$/, ""), base + file);
}

async function loadCasadi(base) {
  const createWasm = await evaluateCommonJs(base, "casadi_wasm.js", () => {
    throw new Error("casadi_wasm.js requested an unexpected dependency");
  });
  const createCasadi = await evaluateCommonJs(base, "casadi.js", (dependency) => {
    if (dependency.endsWith("casadi_wasm.js")) return createWasm;
    if (dependency === "path") {
      return { join: (...parts) => { const [head, ...tail] = parts.filter(Boolean); return head.replace(/\/$/, "") + "/" + tail.join("/"); } };
    }
    throw new Error("casadi.js requested an unexpected dependency: " + dependency);
  });
  return createCasadi();
}

const nativeFetch = window.fetch.bind(window);
window.fetch = (url, options) => {
  if (typeof url === "string") {
    const plugin = url.split("/").pop();
    if (/^libcasadi_[\w]+\.so$/.test(plugin)) url = CASADI_BASE + plugin;
  }
  return nativeFetch(url, options);
};

async function loadPlugin(casadiModule, type, name) {
  const file = `libcasadi_${type}_${name}.so`;
  if (!casadiModule.FS) {
    await casadiModule[`load_${type}`](name);
    return;
  }
  if (!casadiModule.FS.analyzePath(`/${file}`).exists) {
    const response = await nativeFetch(CASADI_BASE + file);
    if (!response.ok) throw new Error(`Failed to fetch plugin ${file}: ${response.status}`);
    casadiModule.FS.writeFile(`/${file}`, new Uint8Array(await response.arrayBuffer()));
  }
  await casadiModule[`load_${type}`](name);
}

function normalizeExample(source) {
  return normalizeBrowserSolvers(normalizeCasadiInputs(source)).replace(
    "opti.subject_to(opti.bounded(0, U, 1));",
    "opti.subject_to(ca.ge(U, 0));\n  opti.subject_to(ca.le(U, 1));"
  );
}

function normalizeBrowserSolvers(source) {
  return source
    .replace(/(qpsol\s*:\s*["'])qrqp(["'])/g, "$1qpoases$2")
    .replace(/(qpsol_options\s*:\s*)\{[^}]*\}/g, "$1{ printLevel: \"none\" }");
}

function normalizeCasadiInputs(source) {
  // The browser SWIG binding does not coerce a spread of JS numbers to DM.
  return source.replace(
    /([A-Za-z_$][\w$]*)\.horzcat\(\.\.\.new Array\(N \+ 1\)\.fill\(([-+]?\d+(?:\.\d+)?)\)\)/g,
    "$1.horzcat(...new Array(N + 1).fill($2).map((value) => $1.DM(value)))"
  );
}

function timeHorizon(source) {
  const match = source.match(/\b(?:const|let|var)\s+(?:T|tf)\s*=\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : 1;
}

function requiredPlugins(source, file) {
  const plugins = [...(PLUGINS[file] || [])];
  const add = (type, name) => {
    if (!plugins.some(([existingType, existingName]) => existingType === type && existingName === name)) plugins.push([type, name]);
  };
  for (const match of source.matchAll(/\b(integrator|qpsol|conic|rootfinder|linsol)\s*\([^,]+,\s*["']([^"']+)["']/g)) {
    const type = match[1] === "integrator" ? "integrator" : match[1] === "rootfinder" ? "rootfinder" : match[1] === "linsol" ? "linsol" : "conic";
    if (type === "integrator" && match[2] === "collocation") {
      add("linsol", "qr");
      add("rootfinder", "newton");
    }
    add(type, match[2]);
  }
  for (const match of source.matchAll(/(?:linear_solver|"linear_solver")\s*[:=]\s*["']([^"']+)["']/g)) {
    add("linsol", match[1]);
  }
  if (/\bqpsol\s*:\s*["']qrqp["']/.test(source)) {
    add("conic", "qrqp");
    add("linsol", "qr");
  }
  return plugins;
}

function runnableSource(source) {
  const definesExample = /\b(?:async\s+)?function\s+example\s*\(/.test(source);
  const callsExample = /\bexample\s*\(\s*ca\s*,/.test(source);
  return definesExample && !callsExample ? `${source}\n\nawait example(ca, print, inspect, dataset);` : source;
}

async function readExample(file) {
  if (!sourceCache.has(file)) {
    const sourceText = window.casadiExamples?.[file];
    let source;
    if (sourceText) {
      source = normalizeExample(sourceText);
    } else {
      const response = await fetch("examples/" + encodeURIComponent(file));
      if (!response.ok) throw new Error(`${file}: ${response.status} ${response.statusText}`);
      source = normalizeExample(await response.text());
    }
    sourceCache.set(file, file === "blank.js" ? source : `${source}\n\nawait example(ca, print, inspect, dataset);`);
  }
  return sourceCache.get(file);
}

function updateLineNumbers() {
  lineNumbers.textContent = Array.from({ length: editor.value.split("\n").length }, (_, index) => index + 1).join("\n");
}

function appendOutput(...values) {
  output.append(document.createTextNode(values.map(String).join(" ") + "\n"));
}

function print(...values) {
  appendOutput(...values);
  if (values.length === 1 && typeof values[0] === "string") capturePrintedResult(values[0]);
}

function displayValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.toString === "function") return value.toString();
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function displayPreview(value, limit = 180) {
  const text = displayValue(value);
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function serializableValue(value) {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(serializableValue);
  if (ArrayBuffer.isView(value)) return Array.from(value).map(serializableValue);
  if (value && typeof value.nonzeros === "function") return Array.from(value.nonzeros()).map(Number);
  return displayValue(value);
}

function valueType(value) {
  if (value && typeof value.type_name === "function") return value.type_name();
  if (value && value.constructor?.name) return value.constructor.name;
  return value === null ? "null" : typeof value;
}

function valueShape(value) {
  if (value && typeof value.size1 === "function" && typeof value.size2 === "function") {
    return `${value.size1()} x ${value.size2()}`;
  }
  if (Array.isArray(value)) return `${value.length} items`;
  if (ArrayBuffer.isView(value)) return `${value.length} items`;
  return "-";
}

function copyText(value) {
  navigator.clipboard?.writeText(String(value));
}

function renderVariables() {
  const body = document.querySelector("#variables-body");
  body.replaceChildren();
  if (!variableRecords.size) {
    body.innerHTML = '<tr><td colspan="5" class="muted">No variables published.</td></tr>';
    return;
  }
  for (const record of variableRecords.values()) {
    const row = document.createElement("tr");
    row.innerHTML = `<td class="variable-name"></td><td></td><td></td><td class="table-value"></td><td></td>`;
    row.children[0].textContent = record.name;
    row.children[1].textContent = record.type;
    row.children[2].textContent = record.shape;
    row.children[3].textContent = record.display;
    const copy = document.createElement("button");
    copy.textContent = "Copy";
    copy.onclick = () => copyText(JSON.stringify(record.value));
    row.children[4].append(copy);
    body.append(row);
  }
}

function inspect(name, value, metadata = {}) {
  variableRecords.set(String(name), {
    name: String(name),
    type: metadata.type || valueType(value),
    shape: metadata.shape || valueShape(value),
    display: displayPreview(value),
    value: serializableValue(value),
  });
  renderVariables();
}

function numericValues(values) {
  if (Array.isArray(values)) return values.flat(Infinity).map(Number).filter(Number.isFinite);
  if (ArrayBuffer.isView(values)) return Array.from(values).map(Number).filter(Number.isFinite);
  return String(values).match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
}

function capturePrintedResult(message) {
  const match = message.match(/^\s*([^=:]+?)\s*[:=]\s*(.+)$/);
  if (!match) return;
  const name = match[1].trim();
  const valueText = match[2].trim();
  const numbers = numericValues(valueText);
  inspect(name, valueText, { type: "logged text", shape: "-" });
  if (numbers.length >= 3 && /(?:trajectory|time|state|control|position|speed|throttle|u\b|x\b|y\b)/i.test(name)) {
    dataset(name, numbers);
  }
}

function refreshDatasetChoices() {
  for (const select of [xDataset, yDataset]) {
    const selected = select.value;
    select.replaceChildren(new Option(select === xDataset ? "X dataset" : "Y dataset", ""));
    for (const name of datasets.keys()) select.add(new Option(name, name));
    select.value = selected;
  }
}

function dataset(name, values) {
  const numbers = numericValues(values);
  if (!numbers.length) throw new Error(`Dataset "${name}" has no numeric values`);
  datasets.set(name, numbers);
  if (!datasets.has("time") && name !== "time" && numbers.length > 2) {
    datasets.set("time", numbers.map((_, index) => currentTimeHorizon * index / (numbers.length - 1)));
  }
  refreshDatasetChoices();
  renderDatasets();
}

function renderDatasets() {
  const body = document.querySelector("#datasets-body");
  body.replaceChildren();
  if (!datasets.size) {
    body.innerHTML = '<tr><td colspan="4" class="muted">No datasets published.</td></tr>';
    return;
  }
  for (const [name, values] of datasets) {
    const row = document.createElement("tr");
    row.innerHTML = `<td class="variable-name"></td><td>numeric</td><td></td><td class="table-value"></td>`;
    row.children[0].textContent = name;
    row.children[2].textContent = values.length;
    row.children[3].textContent = values.slice(0, 4).join(", ") + (values.length > 4 ? ", ..." : "");
    body.append(row);
  }
}

function downloadFile(name, content, type) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type }));
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}

function exportResults() {
  downloadFile(`${choice.value.replace(/\.js$/, "")}-results.json`, JSON.stringify({
    example: choice.value,
    casadi: "3.8.1",
    source: editor.value,
    variables: Object.fromEntries([...variableRecords].map(([name, record]) => [name, record])),
    datasets: Object.fromEntries(datasets),
    output: output.textContent,
  }, null, 2), "application/json");
}

function exportDatasets() {
  const names = [...datasets.keys()];
  const length = Math.max(0, ...[...datasets.values()].map((values) => values.length));
  const rows = [names.join(",")];
  for (let index = 0; index < length; index++) {
    rows.push(names.map((name) => datasets.get(name)[index] ?? "").join(","));
  }
  downloadFile(`${choice.value.replace(/\.js$/, "")}-datasets.csv`, rows.join("\n"), "text/csv");
}

function clearDatasets() {
  datasets.clear();
  refreshDatasetChoices();
  renderDatasets();
}

function drawPlot() {
  const context = plotCanvas.getContext("2d");
  const width = plotCanvas.width;
  const height = plotCanvas.height;
  context.clearRect(0, 0, width, height);
  const x = datasets.get(xDataset.value);
  const y = datasets.get(yDataset.value);
  if (!x || !y) return;
  const count = Math.min(x.length, y.length);
  const xValues = x.slice(0, count);
  const yValues = y.slice(0, count);
  const xMin = Math.min(...xValues), xMax = Math.max(...xValues) || xMin + 1;
  const yMin = Math.min(...yValues), yMax = Math.max(...yValues) || yMin + 1;
  context.strokeStyle = "#383a35"; context.strokeRect(42, 18, width - 60, height - 48);
  context.strokeStyle = "#f2a23a"; context.lineWidth = 2; context.beginPath();
  for (let index = 0; index < count; index++) {
    const px = 42 + ((xValues[index] - xMin) / (xMax - xMin)) * (width - 60);
    const py = height - 30 - ((yValues[index] - yMin) / (yMax - yMin)) * (height - 48);
    index ? context.lineTo(px, py) : context.moveTo(px, py);
  }
  context.stroke();
  context.fillStyle = "#9a9b98"; context.font = "11px monospace";
  context.fillText(`${xDataset.value} → ${yDataset.value}`, 48, height - 9);
}

async function selectExample(file) {
  status.textContent = "Loading example...";
  editor.value = await readExample(file);
  currentTimeHorizon = timeHorizon(editor.value);
  updateLineNumbers();
  status.textContent = "Ready";
}

async function runScript() {
  const started = performance.now();
  runButton.disabled = true;
  output.textContent = "";
  status.textContent = "Starting fresh WASM runtime...";
  status.className = "status";
  window.consoleOutput = appendOutput;

  try {
    const executableSource = normalizeBrowserSolvers(normalizeCasadiInputs(runnableSource(editor.value)));
    const runCasadi = await loadCasadi(CASADI_BASE);
    await loadPlugin(runCasadi, "nlpsol", "ipopt");
    for (const [type, name] of requiredPlugins(executableSource, choice.value)) {
      await loadPlugin(runCasadi, type, name);
    }
    status.textContent = "Running...";
    variableRecords.clear();
    renderVariables();
    datasets.clear();
    refreshDatasetChoices();
    renderDatasets();
    const execute = new Function("ca", "print", "inspect", "dataset", `return (async () => { ${executableSource}\n })();`);
    await execute(runCasadi, print, inspect, dataset);
    status.textContent = "Completed";
    runTime.textContent = `· ${((performance.now() - started) / 1000).toFixed(2)}s`;
  } catch (error) {
    status.textContent = "Failed";
    status.className = "status error";
    output.textContent = error.stack || error.message || String(error);
  } finally {
    window.consoleOutput = null;
    runButton.disabled = false;
  }
}

for (const file of EXAMPLES) {
  const option = document.createElement("option");
  option.value = file;
  option.textContent = file.replace(/\.js$/, "");
  choice.append(option);
}

choice.addEventListener("change", () => selectExample(choice.value).catch((error) => {
  status.textContent = "Example failed to load";
  status.className = "status error";
  output.textContent = error.stack || error.message || String(error);
}));
document.querySelector("#new-script").addEventListener("click", () => {
  choice.value = "blank.js";
  editor.value = window.casadiExamples?.["blank.js"] || "// Write a CasADi script here.\n";
  currentTimeHorizon = 1;
  updateLineNumbers();
  status.textContent = "New script";
});
document.querySelector("#upload-script").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  if (!file) return;
  editor.value = await file.text();
  const existing = [...choice.options].find((option) => option.value === file.name);
  if (!existing) choice.add(new Option(file.name, file.name));
  choice.value = file.name;
  sourceCache.set(file.name, editor.value);
  currentTimeHorizon = timeHorizon(editor.value);
  updateLineNumbers();
  status.textContent = `Opened ${file.name}`;
});
editor.addEventListener("input", updateLineNumbers);
editor.addEventListener("scroll", () => { lineNumbers.scrollTop = editor.scrollTop; });
document.querySelector("#editor-run").addEventListener("click", runScript);
document.querySelector("#clear-variables").addEventListener("click", () => { variableRecords.clear(); renderVariables(); });
document.querySelector("#clear-plot").addEventListener("click", () => { clearDatasets(); plotCanvas.getContext("2d").clearRect(0, 0, plotCanvas.width, plotCanvas.height); });
document.querySelector("#plot-data").addEventListener("click", drawPlot);
document.querySelector("#export-results").addEventListener("click", exportResults);
document.querySelector("#export-datasets").addEventListener("click", exportDatasets);
document.querySelector("#download-script").addEventListener("click", () => {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([editor.value], { type: "text/javascript" }));
  link.download = choice.value;
  link.click();
  URL.revokeObjectURL(link.href);
});

renderVariables();
renderDatasets();

selectExample("blank.js");
loadCasadi(CASADI_BASE).then((module) => {
  casadi = module;
  runButton.disabled = false;
  status.textContent = "WASM runtime ready";
}).catch((error) => {
  status.textContent = "Runtime failed";
  status.className = "status error";
  output.textContent = error.stack || error.message || String(error);
});
