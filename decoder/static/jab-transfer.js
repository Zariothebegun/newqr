/* JAB Code transport adapter. The JAB image is the visual layer; Fountain
 * remains the loss-tolerant file layer. */
(function (root) {
    "use strict";
    const JAB_SYMBOLS = 24;
    const JAB_COLORS = 8;
    const MAX_FILE_BYTES = 64 * 1024 * 1024;
    let jabPromise;

    function toBase64(bytes) {
        const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let result = "";
        const step = 0x8000;
        for (let i = 0; i < data.length; i += step) result += String.fromCharCode(...data.subarray(i, i + step));
        return btoa(result);
    }
    function fromBase64(text) {
        const binary = atob(text);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return bytes;
    }
    function crc32(data) {
        const table = crc32.table || (crc32.table = new Uint32Array(256));
        if (!crc32.ready) {
            for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); table[n] = c >>> 0; }
            crc32.ready = true;
        }
        let crc = 0xffffffff;
        for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }
    function utf8(text) { return new TextEncoder().encode(text); }
    function text(bytes) { return new TextDecoder().decode(bytes); }

    function packPacket({ sessionId, seq, k, blockLen, totalLen, fileCrc32, indices, filename, data }) {
        return JSON.stringify({
            v: 1, s: sessionId >>> 0, q: seq >>> 0, k: k >>> 0, b: blockLen >>> 0,
            n: totalLen >>> 0, c: fileCrc32 >>> 0, i: indices, f: toBase64(utf8(filename || "received_file")), d: toBase64(data)
        });
    }
    function unpackPacket(encoded) {
        let packet;
        try { packet = JSON.parse(encoded); } catch (_) { return null; }
        if (!packet || packet.v !== 1 || !Number.isSafeInteger(packet.s) || !Number.isSafeInteger(packet.q) || !Number.isSafeInteger(packet.k) || !Number.isSafeInteger(packet.b) || !Number.isSafeInteger(packet.n) || !Array.isArray(packet.i) || typeof packet.d !== "string") return null;
        if (packet.k < 1 || packet.k > 65536 || packet.b < 1 || packet.b > 16384 || packet.n < 1 || packet.n > MAX_FILE_BYTES || packet.i.length < 1 || packet.i.length > 5) return null;
        try {
            const data = fromBase64(packet.d);
            const filename = packet.f ? text(fromBase64(packet.f)) : "received_file";
            if (data.length < packet.b) return null;
            return { sessionId: packet.s >>> 0, seq: packet.q >>> 0, k: packet.k, blockLen: packet.b, totalLen: packet.n, fileCrc32: packet.c >>> 0, indices: packet.i.map(Number), filename, data: data.slice(0, packet.b) };
        } catch (_) { return null; }
    }
    async function jab() {
        if (!jabPromise) jabPromise = import("/static/third-party/jabcodeJSLib.min.js?v=jab-1").then(module => new (module.default || root.JabcodeJSInterface)());
        return jabPromise;
    }
    async function encodePacket(packet) {
        const instance = await jab();
        // JAB's own palette, finder patterns and LDPC ECC are deliberately
        // retained. The only thing we replace is the payload protocol inside.
        return instance.encode_message(packPacket(packet), JAB_SYMBOLS, JAB_COLORS);
    }
    async function decodeImage(blob) {
        const instance = await jab();
        try { return unpackPacket(await instance.decode_message(blob)); } catch (_) { return null; }
    }
    root.VEFJab = { JAB_SYMBOLS, JAB_COLORS, MAX_FILE_BYTES, crc32, encodePacket, decodeImage, packPacket, unpackPacket };
})(window);
