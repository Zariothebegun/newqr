#!/usr/bin/env bash
# Rebuild the JAB Code WebAssembly module (`jabcode.wasm`) from source.
#
# The shipped `jabcodeJSLib.min.js` is a self-contained loader for this wasm.
# The upstream TMSSassen/JABCodeJS distribution's committed build ships a
# `<<< WASM_BINARY_FILE >>>` placeholder instead of the real encoder, so it
# cannot produce or read a JAB Code. We therefore compile the Fraunhofer SIT
# JAB Code core (MIT) to wasm32-wasi ourselves and ship a tiny custom C
# interface (`jabcode_interface.c`) that exposes encode/decode over raw RGBA.
#
# Requires:
#   - zig (any recent release; `pip install ziglang` works) with wasm32-wasi
#   - a clone of https://github.com/jabcode/jabcode (the core C sources)
#
# Usage:
#   ./build-wasm.sh /path/to/jabcode-src  [output.wasm]
set -euo pipefail

JAB_SRC="${1:?usage: build-wasm.sh <jabcode-src> [output.wasm]}"
OUT="${2:-$(dirname "$0")/../jabcode.wasm}"
ZIG="${ZIG:-zig}"
SRC="$JAB_SRC/src/jabcode"

cd "$(dirname "$0")"

echo ">> Compiling JAB Code core (wasm32-wasi) ..."
OBJ=$(mktemp -d)
for f in encoder binarizer decoder detector interleave ldpc mask pseudo_random sample transform; do
    $ZIG cc -target wasm32-wasi -O2 -std=c11 \
        -I"$SRC" -I"$SRC/include" -c "$SRC/$f.c" -o "$OBJ/$f.o"
done

echo ">> Compiling custom interface ..."
$ZIG cc -target wasm32-wasi -O2 -std=c11 \
    -I"$SRC" -I"$SRC/include" -c jabcode_interface.c -o "$OBJ/interface.o"

echo ">> Linking jabcode.wasm ..."
$ZIG cc -target wasm32-wasi -O2 \
    -Wl,--no-entry \
    -Wl,--export=encode_image \
    -Wl,--export=decode_image \
    -Wl,--export=getDefaultSymbolNumber \
    -Wl,--export=getDefaultColorNumber \
    -Wl,--export=malloc \
    -Wl,--export=free \
    -Wl,--export=__wasm_call_ctors \
    -o "$OUT" "$OBJ"/*.o

rm -rf "$OBJ"
echo ">> Wrote $OUT"
