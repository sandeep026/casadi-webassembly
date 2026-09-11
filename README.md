# CasADi Lab

A small browser editor for running CasADi JavaScript examples with WebAssembly.

## Files

- `test.html` - page structure and controls.
- `style.css` - intentionally simple page styling.
- `app.js` - local example loading, CasADi WASM setup, execution, and output capture.
- `examples/` - one JavaScript file per CasADi example.
- `examples/blank.js` - starting point for custom code.
- `examples.js` - single catalog of the bundled examples.

## Run locally

Serve the folder over HTTP because browsers block local WASM fetches from `file://` URLs:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000/test.html`.

Examples are loaded from the local `examples/` directory. CasADi's WASM runtime and solver plugins are loaded from the pinned npm package on unpkg.

## Editor helpers

Scripts can send values to the IDE panels:

```js
inspect("solution", solution);
dataset("time", [0, 1, 2, 3]);
dataset("speed", [0, 2, 3, 4]);
```

After running, choose two datasets in Plot editor and press Plot. Labeled output such as `print("speed =", values)` is also promoted automatically into the Variables and Plot panels. Uploaded scripts can use the same helpers.
