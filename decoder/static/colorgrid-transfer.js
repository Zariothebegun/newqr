/* Colour-grid transport adapter: same public shape as jab-transfer.js
 * (encodePacket/decodeImage/packPacket/unpackPacket/decodeStats) so
 * receiver.js and send/index.html only need to swap which module they
 * import — Fountain and the rest of the app are untouched.
 *
 * Packet framing is compact binary (no JSON/base64 — that was ~40% pure
 * overhead) with an explicit CRC32 over the whole packet. That CRC is load-
 * bearing here: unlike JAB's LDPC, this codec has no per-cell error
 * correction, so a frame that decodes with any bit errors MUST be caught
 * and dropped here rather than handed to the Fountain layer as if it were
 * good data. Fountain already assumes frames get dropped and just repeats,
 * so "drop the bad frame" is the same failure philosophy the app already
 * relied on with JAB — nothing upstream needs to change.
 */
(function (root) {
    "use strict";
    const G = root.VEFColorGrid;
    const MAX_FILE_BYTES = 64 * 1024 * 1024;
    const HEADER_MAGIC = 0xC6; // 1 byte, cheap sanity check before touching CRC

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

    // ---- Binary packet framing --------------------------------------------
    function packPacket({ sessionId, seq, k, blockLen, totalLen, fileCrc32, indices, filename, data, compressed, originalLen }) {
        const fnameBytes = utf8((filename || "received_file").slice(0, 200));
        const idx = (indices && indices.length ? indices : [0]).slice(0, 5);
        const headerLen = 1 + 4 + 4 + 4 + 4 + 4 + 4 + 1 + 4 + 1 + idx.length * 4 + 1 + fnameBytes.length;
        const total = 4 + headerLen + data.length + 4;
        const buf = new Uint8Array(total);
        const view = new DataView(buf.buffer);
        view.setUint32(0, total, true);
        let o = 4;
        buf[o] = HEADER_MAGIC; o += 1;
        view.setUint32(o, sessionId >>> 0, true); o += 4;
        view.setUint32(o, seq >>> 0, true); o += 4;
        view.setUint32(o, k >>> 0, true); o += 4;
        view.setUint32(o, blockLen >>> 0, true); o += 4;
        view.setUint32(o, totalLen >>> 0, true); o += 4;
        view.setUint32(o, (originalLen || totalLen) >>> 0, true); o += 4;
        buf[o] = compressed ? 1 : 0; o += 1;
        view.setUint32(o, fileCrc32 >>> 0, true); o += 4;
        buf[o] = idx.length; o += 1;
        for (const v of idx) { view.setUint32(o, v >>> 0, true); o += 4; }
        buf[o] = fnameBytes.length; o += 1;
        buf.set(fnameBytes, o); o += fnameBytes.length;
        buf.set(data, o); o += data.length;
        const crc = crc32(buf.subarray(0, o));
        view.setUint32(o, crc, true);
        return buf;
    }
    function unpackPacket(buf) {
        try {
            const MIN_LEN = 4 + 1 + 4 * 6 + 1 + 4 + 1 + 4 + 1 + 4;
            if (!buf || buf.length < MIN_LEN) return null;
            const declaredTotal = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, true);
            if (declaredTotal < MIN_LEN || declaredTotal > buf.length) return null;
            buf = buf.subarray(0, declaredTotal);
            if (buf[4] !== HEADER_MAGIC) return null;
            const declaredCrc = new DataView(buf.buffer, buf.byteOffset + buf.length - 4, 4).getUint32(0, true);
            const actualCrc = crc32(buf.subarray(0, buf.length - 4));
            if (declaredCrc !== actualCrc) return null;
            const view = new DataView(buf.buffer, buf.byteOffset);
            let o = 5;
            const sessionId = view.getUint32(o, true); o += 4;
            const seq = view.getUint32(o, true); o += 4;
            const k = view.getUint32(o, true); o += 4;
            const blockLen = view.getUint32(o, true); o += 4;
            const totalLen = view.getUint32(o, true); o += 4;
            const originalLen = view.getUint32(o, true); o += 4;
            const compressed = !!buf[o]; o += 1;
            const fileCrc32 = view.getUint32(o, true); o += 4;
            const idxCount = buf[o]; o += 1;
            if (idxCount < 1 || idxCount > 5) return null;
            const indices = [];
            for (let i = 0; i < idxCount; i++) { indices.push(view.getUint32(o, true)); o += 4; }
            const fnameLen = buf[o]; o += 1;
            const filename = fnameLen ? text(buf.subarray(o, o + fnameLen)) : "received_file";
            o += fnameLen;
            const dataEnd = buf.length - 4;
            if (o > dataEnd) return null;
            const data = buf.subarray(o, dataEnd);
            if (k < 1 || k > 65536 || blockLen < 1 || blockLen > 65536 || totalLen < 1 || totalLen > MAX_FILE_BYTES || originalLen < 1 || originalLen > MAX_FILE_BYTES || totalLen > originalLen) return null;
            if (data.length < blockLen) return null;
            return { sessionId, seq, k, blockLen, totalLen, originalLen, compressed, fileCrc32, indices, filename, data: data.slice(0, blockLen) };
        } catch (_) { return null; }
    }

    // ---- Encode/decode using the pixel-grid codec --------------------------
    async function encodePacket(packet) {
        const bytes = packPacket(packet);
        return G.encodeFrame(bytes); // {cols, rows, pixels}
    }
    
    function nearestIndex(rgb, palette) {
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < palette.length; i++) {
            const dr = rgb[0] - palette[i][0], dg = rgb[1] - palette[i][1], db = rgb[2] - palette[i][2];
            const d = dr * dr + dg * dg + db * db;
            if (d < bestDist) { bestDist = d; best = i; }
        }
        return best;
    }

    function decodeFrameWithMarkersAndSize(imageData, cols, rows, H) {
        const { width, height, data } = imageData;
        function sample(gx, gy) {
            const [px, py] = G.applyHomography(H, gx, gy);
            if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
            const ix = Math.min(Math.max(Math.floor(px), 0), width - 1);
            const iy = Math.min(Math.max(Math.floor(py), 0), height - 1);
            const o = (iy * width + ix) * 4;
            return [data[o], data[o + 1], data[o + 2]];
        }

        const framePalette = [];
        const startX = G.MARKER_SIZE, endX = cols - G.MARKER_SIZE;
        const available = endX - startX;
        const swatchW = Math.max(2, Math.floor(available / 16));
        for (let i = 0; i < 16; i++) {
            const cx = startX + i * swatchW + swatchW / 2;
            const cy = G.MARKER_SIZE + 1; // CAL_SWATCH / 2
            const rgb = sample(cx, cy);
            if (!rgb) return null;
            framePalette.push(rgb);
        }

        const bits = [];
        for (let y = 0; y < rows; y++) {
            const inTopMarkerBand = y < G.MARKER_SIZE;
            const inBottomMarkerBand = y >= rows - G.MARKER_SIZE;
            const inCalBand = y >= G.MARKER_SIZE && y < G.MARKER_SIZE + 2;
            for (let x = 0; x < cols; x++) {
                const inLeftMarker = x < G.MARKER_SIZE;
                const inRightMarker = x >= cols - G.MARKER_SIZE;
                if ((inTopMarkerBand || inBottomMarkerBand) && (inLeftMarker || inRightMarker)) continue;
                if (inCalBand) continue;
                
                const rgb = sample(x + 0.5, y + 0.5);
                if (!rgb) return null;
                const idx = nearestIndex(rgb, framePalette);
                for (let b = 3; b >= 0; b--) bits.push((idx >> b) & 1);
            }
        }

        const byteLen = bits.length >> 3;
        const out = new Uint8Array(byteLen);
        for (let i = 0; i < byteLen; i++) {
            let v = 0;
            for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
            out[i] = v;
        }
        return out;
    }

    const decodeStats = { attempts: 0, empty: 0, errors: 0, invalidPacket: 0, success: 0, lastError: null, lastMs: 0 };
    async function decodeImage(imageData, cols, rows) {
        decodeStats.attempts++;
        const t0 = (typeof performance !== "undefined") ? performance.now() : Date.now();
        
        const markers = G.findMarkers(imageData);
        if (!markers) {
            decodeStats.empty++;
            decodeStats.lastMs = ((typeof performance !== "undefined") ? performance.now() : Date.now()) - t0;
            return null;
        }

        const sizes = (cols && rows) ? [{cols, rows}] : [
            {cols: 32, rows: 32}, // 256 bytes
            {cols: 40, rows: 40}, // 512 bytes
            {cols: 56, rows: 56}, // 1024 bytes
            {cols: 72, rows: 72}, // 1918 bytes
            {cols: 80, rows: 80}  // 2877 bytes
        ];

        let raw = null;
        for (const size of sizes) {
            try {
                const [tl, tr, bl, br] = markers;
                const half = G.MARKER_SIZE / 2;
                const srcPts = [tl, tr, bl, br];
                const dstPts = [[half, half], [size.cols - half, half], [half, size.rows - half], [size.cols - half, size.rows - half]];
                const H = G.computeHomography(dstPts, srcPts);
                if (!H) continue;

                raw = decodeFrameWithMarkersAndSize(imageData, size.cols, size.rows, H);
                if (raw) {
                    const packet = unpackPacket(raw);
                    if (packet) {
                        decodeStats.success++;
                        decodeStats.lastMs = ((typeof performance !== "undefined") ? performance.now() : Date.now()) - t0;
                        return packet;
                    }
                }
            } catch (error) {
                // Try next size
            }
        }

        decodeStats.empty++;
        decodeStats.lastMs = ((typeof performance !== "undefined") ? performance.now() : Date.now()) - t0;
        return null;
    }
    
    root.VEFColorGridTransfer = { MAX_FILE_BYTES, crc32, encodePacket, decodeImage, packPacket, unpackPacket, decodeStats };
    root.VEFJab = root.VEFColorGridTransfer;
})(typeof window !== "undefined" ? window : globalThis);
