"use strict";

/*

* CasADi browser example runner
*
* Requires:
* @casadi/casadi-wasm 3.8.1
*
* Important:
* CasADi 3.8.1 loads WASM plugins asynchronously.
* Do NOT intercept fetch() or manually fetch .so files.
  */

const CASADI_VERSION = "3.8.1";
const CASADI_BASE =
`https://unpkg.com/@casadi/casadi-wasm@${CASADI_VERSION}/`;

const EXAMPLES = [
"accessing_mx_algorithm.js",
"accessing_sx_algorithm.js",
"biegler_10_1.js",
"c_code_generation.js",
"chain_qp.js",
"dae_collocation.js",
"dae_multiple_shooting.js",
"dae_single_shooting.js",
"direct_collocation.js",
"direct_multiple_shooting.js",
"direct_single_shooting.js",
"implicit_runge-kutta.js",
"multipoint_simulation.js",
"nlp_codegen.js",
"nlp_sensitivities.js",
"parallel_map.js",
"race_car.js",
"rocket.js",
"rosenbrock.js",
"sensitivity_analysis.js",
"simple_lp.js",
"simple_nlp.js",
"vdp_collocation.js",
"vdp_dynamic_programming.js",
"vdp_indirect_multiple_shooting.js",
"lgl_pseudospectral_opti.js",
"blank.js"
];

/*

* Plugins which are known in advance for particular examples.
*
* IPOPT is loaded separately because it is needed by several examples
* and, in CasADi 3.8.1, must be explicitly loaded before constructing
* an nlpsol/rootfinder backed by nlpsol.
  */
  const PLUGINS = {
  "chain_qp.js": [
  ["conic", "qpoases"]
  ],

"simple_lp.js": [
["conic", "qpoases"]
],

"nlp_sensitivities.js": [
["conic", "qpoases"]
],

"dae_multiple_shooting.js": [
["integrator", "collocation"]
],

"dae_single_shooting.js": [
["integrator", "collocation"]
],

"multipoint_simulation.js": [
["integrator", "rk"]
],

"sensitivity_analysis.js": [
["integrator", "rk"],
["integrator", "collocation"]
],

"vdp_indirect_multiple_shooting.js": [
["integrator", "rk"],
["nlpsol", "ipopt"]
]
};

/* ------------------------------------------------------------------------- */
/* DOM                                                                        */
/* ------------------------------------------------------------------------- */

const editor = document.querySelector("#code-editor");
const lineNumbers = document.querySelector("#line-numbers");
const output = document.querySelector("#editor-output");
const choice = document.querySelector("#script-choice");
const runButton = document.querySelector("#editor-run");
const status = document.querySelector("#editor-status");
const runTime = document.querySelector("#run-time");
const variables = document.querySelector("#variables");
const fileInput = document.querySelector("#file-input");

const datasets = new Map();

const plotCanvas = document.querySelector("#plot");
const xDataset = document.querySelector("#x-dataset");
const yDataset = document.querySelector("#y-dataset");

/* ------------------------------------------------------------------------- */
/* State                                                                      */
/* ------------------------------------------------------------------------- */

let casadi = null;
let sourceCache = new Map();
let currentTimeHorizon = 1;

/* ------------------------------------------------------------------------- */
/* Console forwarding                                                        */
/* ------------------------------------------------------------------------- */

const nativeConsole = {
log: console.log.bind(console),
info: console.info.bind(console),
warn: console.warn.bind(console),
error: console.error.bind(console)
};

window.consoleOutput = null;

for (const method of Object.keys(nativeConsole)) {
console[method] = (...values) => {
nativeConsole[method](...values);

```
if (window.consoleOutput) {
  window.consoleOutput(...values);
}
```

};
}

/* ------------------------------------------------------------------------- */
/* Browser CommonJS loader                                                   */
/* ------------------------------------------------------------------------- */

/*

* The CasADi WASM package contains CommonJS-style files.
*
* We evaluate them in a small controlled CommonJS environment so the
* existing example files can continue to use:
*
* module.exports
* require(...)
*
* No Node.js APIs are required.
  */

async function evaluateCommonJs(
base,
file,
requireFunction
) {
const response = await fetch(base + file);

if (!response.ok) {
throw new Error(
`${file}: ${response.status} ${response.statusText}`
);
}

const source = await response.text();

const factory = new Function(
"module",
"exports",
"require",
"__dirname",
"__filename",
source + "\n;return module.exports;"
);

const module = {
exports: {}
};

return factory(
module,
module.exports,
requireFunction,
base.replace(//$/, ""),
base + file
);
}

/* ------------------------------------------------------------------------- */
/* CasADi loader                                                              */
/* ------------------------------------------------------------------------- */

async function loadCasadi(base) {
/*

* Load the WASM runtime first.
  */
  const createWasm = await evaluateCommonJs(
  base,
  "casadi_wasm.js",
  () => {
  throw new Error(
  "casadi_wasm.js requested an unexpected dependency"
  );
  }
  );

/*

* Then load the JS SWIG wrapper.
  */
  const createCasadi = await evaluateCommonJs(
  base,
  "casadi.js",
  (dependency) => {
  if (dependency.endsWith("casadi_wasm.js")) {
  return createWasm;
  }

  if (dependency === "path") {
  return {
  join: (...parts) => {
  const filtered = parts.filter(Boolean);

  ```
     if (!filtered.length) {
       return "";
     }

     const [head, ...tail] = filtered;

     return (
       String(head).replace(/\/$/, "") +
       (tail.length ? "/" + tail.join("/") : "")
     );
   }
  ```

  };
  }

  throw new Error(
  "casadi.js requested an unexpected dependency: " +
  dependency
  );
  }
  );

return createCasadi();
}

/* ------------------------------------------------------------------------- */
/* CasADi plugin loading                                                      */
/* ------------------------------------------------------------------------- */

/*

* IMPORTANT:
*
* Do not:
*
* * override window.fetch()
* * fetch libcasadi_*.so manually
* * put .so files into the Emscripten filesystem
*
* CasADi 3.8.1 handles browser/WASM plugin packaging itself.
  */

async function loadPlugin(casadiModule, type, name) {
const loaderName = `load_${type}`;
const loader = casadiModule[loaderName];

if (typeof loader !== "function") {
throw new Error(
`CasADi does not expose ${loaderName}("${name}")`
);
}

/*

* CasADi 3.8.1 plugin loading is asynchronous.
  */
  await loader.call(casadiModule, name);
  }

/*

* Load plugins explicitly required by an example.
*
* The example table is the authoritative source. We additionally inspect
* source code for integrator/conic/qpsol/linsol/rootfinder usage.
  */
  function requiredPlugins(source, file) {
  const plugins = [...(PLUGINS[file] || [])];

const add = (type, name) => {
if (!plugins.some(
([existingType, existingName]) =>
existingType === type &&
existingName === name
)) {
plugins.push([type, name]);
}
};

/*

* integrator("name", "plugin", ...)
  */
  for (const match of source.matchAll(
  /\bintegrator\s*(\s*[^,]+,\s*["']([^%22']+)["']/g
  )) {
  add("integrator", match[1]);
  }

/*

* rootfinder("name", "plugin", ...)
*
* Note:
* For the Van der Pol example this identifies "nlpsol", not "ipopt".
* The actual IPOPT plugin is specified separately through:
*
* nlpsol: "ipopt"
  */
  for (const match of source.matchAll(
  /\brootfinder\s*(\s*[^,]+,\s*["']([^%22']+)["']/g
  )) {
  add("rootfinder", match[1]);
  }

/*

* linsol("name", "plugin", ...)
  */
  for (const match of source.matchAll(
  /\blinsol\s*(\s*[^,]+,\s*["']([^%22']+)["']/g
  )) {
  add("linsol", match[1]);
  }

/*

* qpsol/conic("name", "plugin", ...)
  */
  for (const match of source.matchAll(
  /\b(?:qpsol|conic)\s*(\s*[^,]+,\s*["']([^%22']+)["']/g
  )) {
  add("conic", match[1]);
  }

/*

* Detect explicit NLP solver configuration:
*
* nlpsol: "ipopt"
*
* or:
*
* "nlpsol": "ipopt"
  */
  for (const match of source.matchAll(
  /["']?nlpsol["']?\s*:\s*["']([^%22']+)["']/g
  )) {
  add("nlpsol", match[1]);
  }

/*

* Detect explicit linear_solver configuration.
  */
  for (const match of source.matchAll(
  /["']?linear_solver["']?\s*[:=]\s*["']([^%22']+)["']/g
  )) {
  add("linsol", match[1]);
  }

/*

* Keep this for older examples which explicitly request qrqp.
  */
  if (/\bqpsol\s*:\s*["']qrqp["']/.test(source)) {
  add("conic", "qrqp");
  add("linsol", "qr");
  }

return plugins;
}

/* ------------------------------------------------------------------------- */
/* Example source normalization                                               */
/* ------------------------------------------------------------------------- */

function normalizeExample(source) {
return normalizeBrowserSolvers(
normalizeCasadiInputs(source)
).replace(
"opti.subject_to(opti.bounded(0, U, 1));",
[
"opti.subject_to(ca.ge(U, 0));",
"opti.subject_to(ca.le(U, 1));"
].join("\n  ")
);
}

/*

* Browser-friendly solver substitutions.
  */
  function normalizeBrowserSolvers(source) {
  return source
  .replace(
  /(qpsol\s*:\s*["'])qrqp(["'])/g,
  "$1qpoases$2"
  )
  .replace(
  /(qpsol_options\s*:\s*){[^}]*}/g,
  "$1{ printLevel: "none" }"
  );
  }

/*

* The browser SWIG binding does not always coerce a spread of ordinary
* JavaScript numbers to DM objects.
  */
  function normalizeCasadiInputs(source) {
  return source.replace(
  /([A-Za-z_$][\w$]*).horzcat\(\.\.\.new Array\(N \+ 1\).fill\(([-+]?\d+(?:\.\d+)?)\))/g,
  "$1.horzcat(...new Array(N + 1).fill($2).map((value) => $1.DM(value)))"
  );
  }

/* ------------------------------------------------------------------------- */
/* Example execution                                                          */
/* ------------------------------------------------------------------------- */

function timeHorizon(source) {
const match = source.match(
/\b(?:const|let|var)\s+(?:T|tf)\s*=\s*(\d+(?:.\d+)?)/
);

return match ? Number(match[1]) : 1;
}

function runnableSource(source) {
const definesExample =
/\b(?:async\s+)?function\s+example\s*(/.test(source);

const callsExample =
/\bexample\s*(\s*ca\s*,/.test(source);

if (definesExample && !callsExample) {
return `${source}\n\nawait example(ca, print);`;
}

return source;
}

/* ------------------------------------------------------------------------- */
/* Reading examples                                                           */
/* ------------------------------------------------------------------------- */

async function readExample(file) {
if (!sourceCache.has(file)) {
const sourceText =
window.casadiExamples?.[file];

```
let source;

if (sourceText) {
  source = normalizeExample(sourceText);
} else {
  const response = await fetch(
    "examples/" + encodeURIComponent(file)
  );

  if (!response.ok) {
    throw new Error(
      `${file}: ${response.status} ${response.statusText}`
    );
  }

  source = normalizeExample(
    await response.text()
  );
}

/*
 * blank.js is intentionally left alone.
 */
sourceCache.set(
  file,
  file === "blank.js"
    ? source
    : `${source}\n\nawait example(ca, print);`
);
```

}

return sourceCache.get(file);
}

/* ------------------------------------------------------------------------- */
/* Editor                                                                      */
/* ------------------------------------------------------------------------- */

function updateLineNumbers() {
const lineCount =
editor.value.split("\n").length;

lineNumbers.textContent =
Array.from(
{ length: lineCount },
(_, index) => index + 1
).join("\n");
}

/* ------------------------------------------------------------------------- */
/* Output                                                                      */
/* ------------------------------------------------------------------------- */

function print(...values) {
output.append(
document.createTextNode(
values.map(String).join(" ") + "\n"
)
);

if (
values.length > 1 &&
typeof values[0] === "string"
) {
inspect(
values[0],
values
.slice(1)
.map(displayValue)
.join(" ")
);

```
for (const value of values.slice(1)) {
  addPrintedDataset(values[0], value);
}
```

} else if (
values.length === 1 &&
typeof values[0] === "string"
) {
const separator =
values[0].match(
/^\s*([^=:]+)\s*[=:]\s*(.+)$/
);

```
if (separator) {
  const name = separator[1].trim();
  const value = separator[2].trim();

  inspect(name, value);
  addPrintedDataset(name, value);
}
```

}
}

function displayValue(value) {
if (typeof value === "string") {
return value;
}

if (
value &&
typeof value.toString === "function"
) {
return value.toString();
}

try {
return JSON.stringify(
value,
null,
2
);
} catch {
return String(value);
}
}

/* ------------------------------------------------------------------------- */
/* Variables                                                                   */
/* ------------------------------------------------------------------------- */

function inspect(name, value) {
const row =
document.createElement("article");

row.className = "variable";

const label =
document.createElement("span");

label.className = "variable-name";
label.textContent = name;

const actions =
document.createElement("span");

actions.className =
"variable-actions";

const copy =
document.createElement("button");

copy.textContent = "Copy";

copy.onclick = () =>
navigator.clipboard?.writeText(
displayValue(value)
);

const remove =
document.createElement("button");

remove.textContent = "Delete";

remove.onclick = () =>
row.remove();

actions.append(
copy,
remove
);

const content =
document.createElement("pre");

content.className =
"variable-value";

content.textContent =
displayValue(value);

row.append(
label,
actions,
content
);

variables.append(row);
}

/* ------------------------------------------------------------------------- */
/* Datasets                                                                    */
/* ------------------------------------------------------------------------- */

function numericValues(values) {
if (Array.isArray(values)) {
return values
.flat(Infinity)
.map(Number)
.filter(Number.isFinite);
}

if (ArrayBuffer.isView(values)) {
return Array
.from(values)
.map(Number)
.filter(Number.isFinite);
}

return (
String(values)
.match(
/[-+]?\d*.?\d+(?:[eE][-+]?\d+)?/g
)
?.map(Number) || []
);
}

function refreshDatasetChoices() {
for (
const select of [xDataset, yDataset]
) {
const selected = select.value;

```
select.replaceChildren(
  new Option(
    select === xDataset
      ? "X dataset"
      : "Y dataset",
    ""
  )
);

for (
  const name of datasets.keys()
) {
  select.add(
    new Option(name, name)
  );
}

select.value = selected;
```

}
}

function dataset(name, values) {
const numbers =
numericValues(values);

if (!numbers.length) {
throw new Error(
`Dataset "${name}" has no numeric values`
);
}

datasets.set(
name,
numbers
);

if (
!datasets.has("time") &&
name !== "time" &&
numbers.length > 2
) {
datasets.set(
"time",
numbers.map(
(_, index) =>
currentTimeHorizon *
index /
(numbers.length - 1)
)
);
}

refreshDatasetChoices();
}

function addPrintedDataset(name, value) {
const numbers =
numericValues(value);

if (numbers.length < 2) {
return;
}

const cleanName =
String(name)
.trim()
.replace(/[^\w-]+/g, "_");

datasets.set(
cleanName,
numbers
);

if (
!datasets.has("time") &&
cleanName !== "time" &&
numbers.length > 2
) {
datasets.set(
"time",
numbers.map(
(_, index) =>
currentTimeHorizon *
index /
(numbers.length - 1)
)
);
}

refreshDatasetChoices();
}

/* ------------------------------------------------------------------------- */
/* Plot                                                                        */
/* ------------------------------------------------------------------------- */

function drawPlot() {
const context =
plotCanvas.getContext("2d");

const width =
plotCanvas.width;

const height =
plotCanvas.height;

context.clearRect(
0,
0,
width,
height
);

const x =
datasets.get(xDataset.value);

const y =
datasets.get(yDataset.value);

if (!x || !y) {
return;
}

const count =
Math.min(
x.length,
y.length
);

if (count < 2) {
return;
}

const xValues =
x.slice(0, count);

const yValues =
y.slice(0, count);

const xMin =
Math.min(...xValues);

const xMax =
Math.max(...xValues) ||
xMin + 1;

const yMin =
Math.min(...yValues);

const yMax =
Math.max(...yValues) ||
yMin + 1;

context.strokeStyle =
"#383a35";

context.strokeRect(
42,
18,
width - 60,
height - 48
);

context.strokeStyle =
"#f2a23a";

context.lineWidth = 2;

context.beginPath();

for (
let index = 0;
index < count;
index++
) {
const px =
42 +
(
(xValues[index] - xMin) /
(xMax - xMin)
) *
(width - 60);

```
const py =
  height -
  30 -
  (
    (yValues[index] - yMin) /
    (yMax - yMin)
  ) *
  (height - 48);

if (index) {
  context.lineTo(px, py);
} else {
  context.moveTo(px, py);
}
```

}

context.stroke();

context.fillStyle =
"#9a9b98";

context.font =
"11px monospace";

context.fillText(
`${xDataset.value} → ${yDataset.value}`,
48,
height - 9
);
}

/* ------------------------------------------------------------------------- */
/* UI                                                                         */
/* ------------------------------------------------------------------------- */

async function selectExample(file) {
status.textContent =
"Loading example...";

status.className =
"status";

editor.value =
await readExample(file);

currentTimeHorizon =
timeHorizon(editor.value);

updateLineNumbers();

status.textContent =
"Ready";
}

/* ------------------------------------------------------------------------- */
/* Run                                                                         */
/* ------------------------------------------------------------------------- */

async function runScript() {
const started =
performance.now();

runButton.disabled = true;

output.textContent = "";

status.textContent =
"Starting fresh WASM runtime...";

status.className =
"status";

window.consoleOutput =
print;

try {
/*
* Normalize the code currently in the editor.
*/
const executableSource =
normalizeBrowserSolvers(
normalizeCasadiInputs(
runnableSource(
editor.value
)
)
);

```
/*
 * Start a fresh CasADi WASM runtime for each execution.
 */
const runCasadi =
  await loadCasadi(
    CASADI_BASE
  );

/*
 * CasADi 3.8.1 requires asynchronous loading
 * of dynamically used plugins.
 *
 * Load IPOPT first because the indirect multiple
 * shooting example uses:
 *
 *   rootfinder(..., "nlpsol", ...)
 *
 * with:
 *
 *   nlpsol: "ipopt"
 */
if (
  typeof runCasadi.load_nlpsol ===
  "function"
) {
  await runCasadi.load_nlpsol(
    "ipopt"
  );
}

/*
 * Load example-specific plugins.
 */
const plugins =
  requiredPlugins(
    executableSource,
    choice.value
  );

for (
  const [type, name] of plugins
) {
  /*
   * IPOPT has already been loaded.
   */
  if (
    type === "nlpsol" &&
    name === "ipopt"
  ) {
    continue;
  }

  /*
   * rootfinder "nlpsol" is the CasADi
   * rootfinder implementation, not the
   * actual IPOPT plugin.
   *
   * Do not try to load it as an external
   * browser plugin here.
   */
  if (
    type === "rootfinder" &&
    name === "nlpsol"
  ) {
    continue;
  }

  await loadPlugin(
    runCasadi,
    type,
    name
  );
}

status.textContent =
  "Running...";

variables.replaceChildren();

datasets.clear();

refreshDatasetChoices();

/*
 * Execute the user's example with:
 *
 *   ca      -> CasADi module
 *   print   -> output helper
 *   inspect -> variable inspector
 *   dataset -> plotting helper
 */
const execute =
  new Function(
    "ca",
    "print",
    "inspect",
    "dataset",
    `
      return (async () => {
        ${executableSource}
      })();
    `
  );

await execute(
  runCasadi,
  print,
  inspect,
  dataset
);

status.textContent =
  "Completed";

runTime.textContent =
  `· ${(
    (performance.now() - started) /
    1000
  ).toFixed(2)}s`;
```

} catch (error) {
status.textContent =
"Failed";

```
status.className =
  "status error";

output.textContent =
  error?.stack ||
  error?.message ||
  String(error);
```

} finally {
window.consoleOutput =
null;

```
runButton.disabled =
  false;
```

}
}

/* ------------------------------------------------------------------------- */
/* Populate example list                                                      */
/* ------------------------------------------------------------------------- */

for (
const file of EXAMPLES
) {
const option =
document.createElement(
"option"
);

option.value = file;

option.textContent =
file.replace(
/.js$/,
""
);

choice.append(option);
}

/* ------------------------------------------------------------------------- */
/* Example selector                                                           */
/* ------------------------------------------------------------------------- */

choice.addEventListener(
"change",
() => {
selectExample(
choice.value
).catch(error => {
status.textContent =
"Example failed to load";

```
  status.className =
    "status error";

  output.textContent =
    error?.stack ||
    error?.message ||
    String(error);
});
```

}
);

/* ------------------------------------------------------------------------- */
/* New script                                                                  */
/* ------------------------------------------------------------------------- */

document
.querySelector("#new-script")
.addEventListener(
"click",
() => {
choice.value =
"blank.js";

```
  editor.value =
    window.casadiExamples?.["blank.js"] ||
    "// Write a CasADi script here.\n";

  currentTimeHorizon =
    1;

  updateLineNumbers();

  status.textContent =
    "New script";
}
```

);

/* ------------------------------------------------------------------------- */
/* Upload                                                                      */
/* ------------------------------------------------------------------------- */

document
.querySelector("#upload-script")
.addEventListener(
"click",
() => fileInput.click()
);

fileInput.addEventListener(
"change",
async () => {
const file =
fileInput.files[0];

```
if (!file) {
  return;
}

editor.value =
  await file.text();

const existing =
  [...choice.options].find(
    option =>
      option.value === file.name
  );

if (!existing) {
  choice.add(
    new Option(
      file.name,
      file.name
    )
  );
}

choice.value =
  file.name;

sourceCache.set(
  file.name,
  editor.value
);

currentTimeHorizon =
  timeHorizon(
    editor.value
  );

updateLineNumbers();

status.textContent =
  `Opened ${file.name}`;
```

}
);

/* ------------------------------------------------------------------------- */
/* Editor events                                                              */
/* ------------------------------------------------------------------------- */

editor.addEventListener(
"input",
updateLineNumbers
);

editor.addEventListener(
"scroll",
() => {
lineNumbers.scrollTop =
editor.scrollTop;
}
);

/* ------------------------------------------------------------------------- */
/* Run                                                                         */
/* ------------------------------------------------------------------------- */

document
.querySelector("#editor-run")
.addEventListener(
"click",
runScript
);

/* ------------------------------------------------------------------------- */
/* Clear variables                                                            */
/* ------------------------------------------------------------------------- */

document
.querySelector("#clear-variables")
.addEventListener(
"click",
() => variables.replaceChildren()
);

/* ------------------------------------------------------------------------- */
/* Clear plot                                                                 */
/* ------------------------------------------------------------------------- */

document
.querySelector("#clear-plot")
.addEventListener(
"click",
() => {
datasets.clear();

```
  refreshDatasetChoices();

  plotCanvas
    .getContext("2d")
    .clearRect(
      0,
      0,
      plotCanvas.width,
      plotCanvas.height
    );
}
```

);

/* ------------------------------------------------------------------------- */
/* Plot                                                                        */
/* ------------------------------------------------------------------------- */

document
.querySelector("#plot-data")
.addEventListener(
"click",
drawPlot
);

/* ------------------------------------------------------------------------- */
/* Download                                                                    */
/* ------------------------------------------------------------------------- */

document
.querySelector("#download-script")
.addEventListener(
"click",
() => {
const link =
document.createElement("a");

```
  link.href =
    URL.createObjectURL(
      new Blob(
        [editor.value],
        {
          type:
            "text/javascript"
        }
      )
    );

  link.download =
    choice.value;

  link.click();

  URL.revokeObjectURL(
    link.href
  );
}
```

);

/* ------------------------------------------------------------------------- */
/* Initial state                                                               */
/* ------------------------------------------------------------------------- */

selectExample(
"blank.js"
);

/* ------------------------------------------------------------------------- */
/* Preload CasADi                                                             */
/* ------------------------------------------------------------------------- */

loadCasadi(
CASADI_BASE
)
.then(module => {
casadi = module;

```
runButton.disabled =
  false;

status.textContent =
  `CasADi ${CASADI_VERSION} WASM runtime ready`;
```

})
.catch(error => {
status.textContent =
"Runtime failed";

```
status.className =
  "status error";

output.textContent =
  error?.stack ||
  error?.message ||
  String(error);
```

});
