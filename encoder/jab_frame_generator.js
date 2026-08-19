import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Polyfill fetch for node to load local WASM
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
    const urlString = String(url);
    if (urlString.startsWith("file://")) {
        const filePath = fileURLToPath(urlString);
        const data = fs.readFileSync(filePath);
        return {
            arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)
        };
    }
    return originalFetch(url, options);
};

// Import JabcodeJSInterface
import JabcodeJSInterface from "../decoder/static/third-party/jabcodeJSLib.min.js";

// --- Fountain Code Helper Functions ---
function mix32(value) {
    value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
    value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
    return (value ^ (value >>> 15)) >>> 0;
}

function randomFor(sessionId, sequence) {
    let state = mix32((sessionId ^ Math.imul(sequence + 1, 0x9e3779b1)) >>> 0) || 0x6d2b79f5;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0);
    };
}

function chooseIndices(k, sessionId, sequence) {
    if (k <= 1) return [0];
    if (sequence < k) return [sequence];

    const random = randomFor(sessionId, sequence);
    const degree = Math.min(k, 3 + (random() % 3));
    const selected = new Set();
    while (selected.size < degree) selected.add(random() % k);
    return [...selected].sort((a, b) => a - b);
}

class FountainEncoder {
    constructor(data, blockLength, sessionId) {
        this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
        this.blockLength = blockLength;
        this.sessionId = sessionId >>> 0;
        this.k = Math.max(1, Math.ceil(this.data.length / blockLength));
        this.blocks = [];
        for (let index = 0; index < this.k; index++) {
            const block = new Uint8Array(blockLength);
            block.set(this.data.slice(index * blockLength, (index + 1) * blockLength));
            this.blocks.push(block);
        }
    }

    packet(sequence) {
        const indices = chooseIndices(this.k, this.sessionId, sequence);
        const output = new Uint8Array(this.blockLength);
        for (const index of indices) {
            const block = this.blocks[index];
            for (let offset = 0; offset < output.length; offset++) output[offset] ^= block[offset];
        }
        return { indices, data: output };
    }
}

// --- JAB Code Utilities ---
const JAB_COLORS = 8;

function toBase64(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let result = "";
    const step = 0x8000;
    for (let i = 0; i < data.length; i += step) result += String.fromCharCode(...data.subarray(i, i + step));
    return btoa(result);
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

function packPacket({ sessionId, seq, k, blockLen, totalLen, fileCrc32, indices, filename, data, compressed, originalLen }) {
    return JSON.stringify({
        v: 1, s: sessionId >>> 0, q: seq >>> 0, k: k >>> 0, b: blockLen >>> 0,
        n: totalLen >>> 0, o: (originalLen || totalLen) >>> 0, z: compressed ? 1 : 0,
        c: fileCrc32 >>> 0, i: indices, f: toBase64(utf8(filename || "received_file")), d: toBase64(data)
    });
}

function isPrecompressed(filename) {
    const ext = filename.split(".").pop().toLowerCase();
    const map = {
        pdf: "application/pdf",
        zip: "application/zip",
        gz: "application/gzip",
        mp3: "audio/mpeg",
        mp4: "video/mp4",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
    };
    const type = map[ext] || "";
    const media = type.split(";")[0].toLowerCase();
    if (media.startsWith("video/")) return true;
    if (media.startsWith("image/")) return !/bmp|svg|tiff|x-icon|vnd\.microsoft\.icon|x-ms-bmp/.test(media);
    if (media.startsWith("audio/")) return !/wav|wave|aiff|basic|l16/.test(media);
    return ["application/zip","application/gzip","application/x-gzip","application/x-7z-compressed","application/x-rar-compressed","application/vnd.rar","application/x-bzip2","application/x-bzip","application/x-tar","application/zstd","application/java-archive","application/vnd.openxmlformats-officedocument.wordprocessingml.document","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet","application/vnd.openxmlformats-officedocument.presentationml.presentation","application/vnd.oasis.opendocument.text","application/vnd.oasis.opendocument.spreadsheet","application/vnd.oasis.opendocument.presentation"].includes(media) || media.endsWith("+zip");
}

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error("Usage: node jab_frame_generator.js <input_file> <output_dir> [fps] [requested_block_len] [target_frames]");
        process.exit(1);
    }

    const inputFile = args[0];
    const outputDir = args[1];
    const fps = args[2] ? parseInt(args[2], 10) : 30;
    const requestedBlockLen = args[3] ? parseInt(args[3], 10) : 2877;
    const targetFrames = args[4] ? parseInt(args[4], 10) : null;

    if (!fs.existsSync(inputFile)) {
        console.error(`Input file not found: ${inputFile}`);
        process.exit(1);
    }

    fs.mkdirSync(outputDir, { recursive: true });

    const originalData = fs.readFileSync(inputFile);
    const filename = path.basename(inputFile);
    const originalLen = originalData.length;
    const fileCrc32 = crc32(originalData);

    // Compress if worth it
    let data = originalData;
    let compressed = false;
    if (originalLen >= 768 && !isPrecompressed(filename)) {
        try {
            const compressedBuffer = zlib.gzipSync(originalData);
            if (compressedBuffer.length + 64 < originalLen) {
                data = compressedBuffer;
                compressed = true;
            }
        } catch (_) {}
    }

    // Initialize JAB
    const jab = new JabcodeJSInterface();
    await jab._ready();

    // Session ID
    const sessionId = Math.floor(Math.random() * 0xffffffff);

    // Find block length
    let blockLen = Math.max(256, Math.floor(requestedBlockLen));
    while (blockLen >= 256) {
        const probe = {
            sessionId,
            seq: 0,
            k: 1,
            blockLen,
            totalLen: data.length,
            fileCrc32,
            indices: [0],
            filename,
            data: new Uint8Array(blockLen)
        };
        try {
            await jab.encode_message(packPacket(probe), 1, JAB_COLORS);
            break;
        } catch (error) {
            blockLen = Math.floor(blockLen / 2);
        }
    }

    if (blockLen < 256) {
        console.error("Could not find a valid block length");
        process.exit(1);
    }

    // Initialize Fountain Encoder
    const fountain = new FountainEncoder(data, blockLen, sessionId);
    const k = fountain.k;

    const numFrames = targetFrames || Math.ceil(k * 2.1);

    console.log(JSON.stringify({
        filename,
        originalLen,
        compressed,
        compressedLen: data.length,
        sessionId,
        blockLen,
        k,
        numFrames,
        fileCrc32
    }));

    // Generate and save frames
    for (let seq = 0; seq < numFrames; seq++) {
        const packet = fountain.packet(seq);
        const probe = {
            sessionId,
            seq,
            k,
            blockLen,
            totalLen: data.length,
            fileCrc32,
            indices: packet.indices,
            filename,
            data: packet.data,
            compressed,
            originalLen
        };

        const dataUrl = await jab.encode_message(packPacket(probe), 1, JAB_COLORS);
        const base64 = dataUrl.split(",")[1];
        const framePath = path.join(outputDir, `frame_${String(seq).padStart(4, "0")}.png`);
        fs.writeFileSync(framePath, Buffer.from(base64, "base64"));
    }

    process.exit(0);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
