# JAB Code runtime

`jabcode.wasm` is a WebAssembly build of the Fraunhofer SIT [JAB Code core]
(https://github.com/jabcode/jabcode) (MIT), compiled to `wasm32-wasi` with
Zig. `jabcodeJSLib.min.js` is a small self-contained ES-module loader for it,
used by `jab-transfer.js` for both encoding and decoding the visual frames.

## Why this build exists

The original code shipped the prebuilt `jabcodeJSLib.min.js` from
[TMSSassen/JABCodeJS](https://github.com/TMSSassen/JABCodeJS). That
distribution's committed build contains the literal placeholder
`<<< WASM_BINARY_FILE >>>` in place of the encoder WebAssembly, so it cannot
produce or read a real JAB Code. Rebuilding it requires Emscripten and a
prebuilt `libjabcode.a`, which is why the app was effectively unable to do
more than tiny transfers.

This repo instead compiles the JAB Code core to wasm directly. The public
surface exposed to the app is unchanged: `new JabcodeJSInterface()` with
`encode_message(text, symbols, colors)` -> PNG data-URL string, and
`decode_message(blob)` -> `Promise<string>`.

## Rebuilding `jabcode.wasm`

```sh
# 1. Install Zig (e.g. `pip install ziglang`)
# 2. Clone the JAB Code core sources
git clone https://github.com/jabcode/jabcode /tmp/jabcode
# 3. Rebuild
decoder/static/third-party/jabcode-build/build-wasm.sh /tmp/jabcode
```

The build script and the custom C interface live in `jabcode-build/`.

## Licence

- JAB Code core: MIT — Copyright (c) 2026 Fraunhofer SIT.
- Loader (`jabcodeJSLib.min.js`): embeds the BSD `PNGlib` PNG writer
  (Copyright (c) 2010 Robert Eisele). See `JABCodeJS-LICENSE.MD` for the
  upstream notices retained from the original port.
