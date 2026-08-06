/* Shared browser protocol for the VEF-3 sender and receiver. */
(function (root) {
    "use strict";

    const FRAME_COLS = 80;
    const FRAME_ROWS = 50;
    const BLOCK_SIZE = 8;
    const DATA_START_ROW = 2;
    const DATA_END_ROW = 48;
    const METADATA_ROW = 49;
    const DATA_ROWS = DATA_END_ROW - DATA_START_ROW;
    const DATA_VALUES = FRAME_COLS * DATA_ROWS;
    const METADATA_VALUES = FRAME_COLS;
    const HEADER_BYTES = 60;
    const PAYLOAD_BYTES = Math.floor(DATA_VALUES * 6 / 8);
    const LEVELS = [0, 85, 170, 255];
    const MAGIC_DATA = [0x56, 0x33, 0x44]; // V3D
    const MAGIC_CALIBRATION = [0x56, 0x33, 0x43]; // V3C

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function asBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        return new Uint8Array(data || []);
    }

    function bytesToValues(data, valueCount) {
        const bytes = asBytes(data);
        const values = [];
        let buffer = 0;
        let bits = 0;

        for (const byte of bytes) {
            buffer = (buffer << 8) | byte;
            bits += 8;
            while (bits >= 6) {
                bits -= 6;
                values.push((buffer >> bits) & 0x3f);
            }
        }

        if (bits > 0) {
            values.push((buffer << (6 - bits)) & 0x3f);
        }

        if (valueCount !== undefined) {
            while (values.length < valueCount) values.push(0);
            return values.slice(0, valueCount);
        }
        return values;
    }

    function valuesToBytes(values, byteCount) {
        const result = [];
        let buffer = 0;
        let bits = 0;

        for (const rawValue of values) {
            buffer = (buffer << 6) | (rawValue & 0x3f);
            bits += 6;
            while (bits >= 8) {
                bits -= 8;
                result.push((buffer >> bits) & 0xff);
                if (byteCount !== undefined && result.length >= byteCount) {
                    return new Uint8Array(result.slice(0, byteCount));
                }
            }
        }

        return new Uint8Array(byteCount === undefined ? result : result.slice(0, byteCount));
    }

    function valueToRgb(value) {
        return [
            LEVELS[Math.floor(value / 16)],
            LEVELS[Math.floor(value / 4) % 4],
            LEVELS[value % 4]
        ];
    }

    function writeUint24(bytes, offset, value) {
        bytes[offset] = (value >>> 16) & 0xff;
        bytes[offset + 1] = (value >>> 8) & 0xff;
        bytes[offset + 2] = value & 0xff;
    }

    function readUint24(bytes, offset) {
        return ((bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2]) >>> 0;
    }

    function writeUint32(bytes, offset, value) {
        bytes[offset] = (value >>> 24) & 0xff;
        bytes[offset + 1] = (value >>> 16) & 0xff;
        bytes[offset + 2] = (value >>> 8) & 0xff;
        bytes[offset + 3] = value & 0xff;
    }

    function readUint32(bytes, offset) {
        return (((bytes[offset] << 24) >>> 0) |
            (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) |
            bytes[offset + 3]) >>> 0;
    }

    function packHeader(options) {
        const bytes = new Uint8Array(HEADER_BYTES);
        const calibration = Boolean(options.calibration);
        const magic = calibration ? MAGIC_CALIBRATION : MAGIC_DATA;
        bytes.set(magic, 0);
        if (calibration) return bytes;

        bytes[3] = 1;
        writeUint32(bytes, 4, options.fileId >>> 0);
        writeUint24(bytes, 8, options.packetIndex >>> 0);
        writeUint24(bytes, 11, options.totalPackets >>> 0);
        writeUint32(bytes, 14, options.originalSize >>> 0);
        bytes[18] = (options.payloadLength >>> 8) & 0xff;
        bytes[19] = options.payloadLength & 0xff;
        writeUint32(bytes, 20, options.fileCrc32 >>> 0);

        const name = encoder.encode(options.filename || "").slice(0, 36);
        bytes.set(name, 24);
        return bytes;
    }

    function parseHeader(bytesLike) {
        const bytes = asBytes(bytesLike);
        if (bytes.length < HEADER_BYTES) return null;

        if (bytes[0] === MAGIC_CALIBRATION[0] &&
            bytes[1] === MAGIC_CALIBRATION[1] &&
            bytes[2] === MAGIC_CALIBRATION[2]) {
            return { type: "calibration", version: bytes[3] };
        }

        if (bytes[0] !== MAGIC_DATA[0] || bytes[1] !== MAGIC_DATA[1] ||
            bytes[2] !== MAGIC_DATA[2] || bytes[3] !== 1) {
            return null;
        }

        const payloadLength = (bytes[18] << 8) | bytes[19];
        if (payloadLength > PAYLOAD_BYTES) return null;

        const name = decoder.decode(bytes.slice(24, 60)).replace(/\0+$/g, "");
        return {
            type: "data",
            version: bytes[3],
            fileId: readUint32(bytes, 4),
            packetIndex: readUint24(bytes, 8),
            totalPackets: readUint24(bytes, 11),
            originalSize: readUint32(bytes, 14),
            payloadLength,
            fileCrc32: readUint32(bytes, 20),
            filename: name || "received_file"
        };
    }

    let crcTable = null;
    function getCrcTable() {
        if (crcTable) return crcTable;
        crcTable = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) {
                c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
            }
            crcTable[n] = c >>> 0;
        }
        return crcTable;
    }

    function crc32(dataLike) {
        const data = asBytes(dataLike);
        const table = getCrcTable();
        let crc = 0xffffffff;
        for (const byte of data) {
            crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        }
        return (crc ^ 0xffffffff) >>> 0;
    }

    function drawMarkers(ctx) {
        // The markers live in rows 0, 1 and 48, outside the data area. Keeping
        // them out of the payload is important: a camera can then read every
        // data block without having to guess which cells were overwritten.
        const width = FRAME_COLS * BLOCK_SIZE;
        const height = FRAME_ROWS * BLOCK_SIZE;
        const size = BLOCK_SIZE;
        const bottom = height - (2 * BLOCK_SIZE);

        ctx.fillStyle = "rgb(0,255,0)";
        ctx.fillRect(0, 0, size, size);
        ctx.fillStyle = "rgb(255,0,0)";
        ctx.fillRect(width - size, 0, size, size);
        ctx.fillStyle = "rgb(0,0,255)";
        ctx.fillRect(0, bottom, size, size);
        ctx.fillStyle = "rgb(255,255,0)";
        ctx.fillRect(width - size, bottom, size, size);
    }

    function drawValue(ctx, col, row, value) {
        const rgb = valueToRgb(value);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(col * BLOCK_SIZE, row * BLOCK_SIZE, BLOCK_SIZE, BLOCK_SIZE);
    }

    function prepareCanvas(canvas) {
        canvas.width = FRAME_COLS * BLOCK_SIZE;
        canvas.height = FRAME_ROWS * BLOCK_SIZE;
        canvas.style.imageRendering = "pixelated";
        return canvas.getContext("2d", { alpha: false });
    }

    function drawCalibrationFrame(canvas) {
        const ctx = prepareCanvas(canvas);
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawMarkers(ctx);

        for (let i = 0; i < 64; i++) {
            const value = i;
            drawValue(ctx, 10 + (i % 8), 5 + Math.floor(i / 8), value);
        }
        for (let i = 0; i < METADATA_VALUES; i++) {
            drawValue(ctx, i, METADATA_ROW, bytesToValues(packHeader({ calibration: true }), METADATA_VALUES)[i]);
        }
    }

    function drawDataFrame(canvas, payload, header) {
        const ctx = prepareCanvas(canvas);
        ctx.fillStyle = "black";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        drawMarkers(ctx);

        const values = bytesToValues(payload, DATA_VALUES);
        for (let i = 0; i < values.length; i++) {
            drawValue(ctx, i % FRAME_COLS, DATA_START_ROW + Math.floor(i / FRAME_COLS), values[i]);
        }

        const metadata = bytesToValues(header, METADATA_VALUES);
        for (let i = 0; i < metadata.length; i++) {
            drawValue(ctx, i, METADATA_ROW, metadata[i]);
        }
    }

    root.VEFProtocol = {
        FRAME_COLS,
        FRAME_ROWS,
        BLOCK_SIZE,
        DATA_START_ROW,
        DATA_END_ROW,
        METADATA_ROW,
        DATA_ROWS,
        DATA_VALUES,
        METADATA_VALUES,
        HEADER_BYTES,
        PAYLOAD_BYTES,
        LEVELS,
        bytesToValues,
        valuesToBytes,
        valueToRgb,
        packHeader,
        parseHeader,
        crc32,
        drawCalibrationFrame,
        drawDataFrame,
        prepareCanvas
    };
})(window);
