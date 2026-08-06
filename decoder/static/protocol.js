/* VEF-3 colour-block frame protocol. Sender and receiver load this module. */
(function (root) {
    "use strict";

    const FRAME_WIDTH = 800;
    const FRAME_HEIGHT = 600;
    const FRAME_COLS = 80;
    const FRAME_ROWS = 50;
    const BLOCK_SIZE = 8;
    const GRID_OFFSET_X = 80;
    const GRID_OFFSET_Y = 100;
    const METADATA_ROWS = [48, 49];
    const METADATA_VALUES = FRAME_COLS * METADATA_ROWS.length;
    const REFERENCE_CELLS = new Set([0, 1, FRAME_COLS, FRAME_COLS + 1]);
    const REFERENCE_VALUES = [0, 21, 42, 63];
    const DATA_POSITIONS = [];
    for (let row = 0; row < METADATA_ROWS[0]; row++) {
        for (let col = 0; col < FRAME_COLS; col++) {
            if (!REFERENCE_CELLS.has(row * FRAME_COLS + col)) DATA_POSITIONS.push([col, row]);
        }
    }
    const DATA_VALUES = DATA_POSITIONS.length;
    const BITS_PER_VALUE = 6;
    const PAYLOAD_BYTES = Math.floor(DATA_VALUES * BITS_PER_VALUE / 8);
    const FOUNTAIN_BLOCK_SIZE = PAYLOAD_BYTES;
    const HEADER_BYTES = METADATA_VALUES / 2;
    const LEVELS = [0, 85, 170, 255];
    const MAX_INDICES = 5;
    const CALIBRATION_GRID = [36, 21];
    const CALIBRATION_GRID_SIZE = 8;
    const MARKER_SIZE = 48;
    const MARKER_THICKNESS = 8;
    const MARKER_ANCHORS = {
        TL: [24, 36],
        TR: [FRAME_WIDTH - 24, 36],
        BL: [24, FRAME_HEIGHT - 36],
        BR: [FRAME_WIDTH - 24, FRAME_HEIGHT - 36]
    };
    const MAGIC_DATA = [0x56, 0x34, 0x44]; // V4D
    const MAGIC_CALIBRATION = [0x56, 0x34, 0x43]; // V4C
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    function asBytes(data) {
        if (data instanceof Uint8Array) return data;
        if (data instanceof ArrayBuffer) return new Uint8Array(data);
        return new Uint8Array(data || []);
    }

    // Pack bytes densely across six-bit tiles; this uses all six bits of the
    // symbol instead of wasting four bits per byte.
    function bytesToValues(data, valueCount) {
        const bytes = asBytes(data);
        const values = [];
        let buffer = 0;
        let bits = 0;
        for (const byte of bytes) {
            buffer = (buffer << 8) | byte;
            bits += 8;
            while (bits >= BITS_PER_VALUE) {
                bits -= BITS_PER_VALUE;
                values.push((buffer >> bits) & 0x3f);
            }
        }
        if (bits) values.push((buffer << (BITS_PER_VALUE - bits)) & 0x3f);
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
        for (const value of values) {
            buffer = (buffer << BITS_PER_VALUE) | (value & 0x3f);
            bits += BITS_PER_VALUE;
            while (bits >= 8) {
                bits -= 8;
                result.push((buffer >> bits) & 0xff);
                if (byteCount !== undefined && result.length >= byteCount) return new Uint8Array(result.slice(0, byteCount));
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

    function writeUint16(bytes, offset, value) {
        bytes[offset] = (value >>> 8) & 0xff;
        bytes[offset + 1] = value & 0xff;
    }

    function readUint16(bytes, offset) {
        return (bytes[offset] << 8) | bytes[offset + 1];
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
        bytes.set(options.calibration ? MAGIC_CALIBRATION : MAGIC_DATA, 0);
        if (options.calibration) return bytes;

        bytes[3] = 1;
        writeUint32(bytes, 4, options.sessionId >>> 0);
        writeUint32(bytes, 8, options.seq >>> 0);
        writeUint32(bytes, 12, options.k >>> 0);
        writeUint16(bytes, 16, options.blockLen >>> 0);
        writeUint32(bytes, 18, options.totalLen >>> 0);
        writeUint32(bytes, 22, options.fileCrc32 >>> 0);
        const indices = [...new Set(options.indices || [])].slice(0, MAX_INDICES);
        bytes[26] = indices.length;
        indices.forEach((index, i) => writeUint16(bytes, 28 + i * 2, index));
        const name = encoder.encode(options.filename || "").slice(0, 30);
        bytes[38] = name.length;
        bytes.set(name, 39);
        return bytes;
    }

    function parseHeader(data) {
        const bytes = asBytes(data);
        if (bytes.length < HEADER_BYTES) return null;
        if (bytes[0] === MAGIC_CALIBRATION[0] && bytes[1] === MAGIC_CALIBRATION[1] && bytes[2] === MAGIC_CALIBRATION[2]) {
            return { type: "calibration", version: bytes[3] };
        }
        if (bytes[0] !== MAGIC_DATA[0] || bytes[1] !== MAGIC_DATA[1] || bytes[2] !== MAGIC_DATA[2] || bytes[3] !== 1) return null;
        const degree = bytes[26];
        if (degree > MAX_INDICES) return null;
        const nameLength = Math.min(bytes[38], 30);
        const indices = [];
        for (let i = 0; i < degree; i++) indices.push(readUint16(bytes, 28 + i * 2));
        return {
            type: "data",
            version: bytes[3],
            sessionId: readUint32(bytes, 4),
            seq: readUint32(bytes, 8),
            k: readUint32(bytes, 12),
            blockLen: readUint16(bytes, 16),
            totalLen: readUint32(bytes, 18),
            fileCrc32: readUint32(bytes, 22),
            degree,
            indices,
            filename: decoder.decode(bytes.slice(39, 39 + nameLength)) || "received_file"
        };
    }

    let crcTable = null;
    function crc32(dataLike) {
        const data = asBytes(dataLike);
        if (!crcTable) {
            crcTable = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                crcTable[n] = c >>> 0;
            }
        }
        let crc = 0xffffffff;
        for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    function renderCells(canvas, cells) {
        const ctx = prepareCanvas(canvas);
        const image = ctx.createImageData(FRAME_WIDTH, FRAME_HEIGHT);
        image.data.fill(0);
        // An ImageData buffer starts transparent when filled with zeroes. If
        // alpha stays 0, the page controls underneath show through the frame
        // and the result looks like a broken overlay. The optical frame must
        // be an opaque black canvas outside the tile grid.
        for (let alpha = 3; alpha < image.data.length; alpha += 4) image.data[alpha] = 255;
        for (let row = 0; row < FRAME_ROWS; row++) for (let col = 0; col < FRAME_COLS; col++) {
            root.VEFTiles.paintTile(image.data, FRAME_WIDTH, GRID_OFFSET_X + col * BLOCK_SIZE, GRID_OFFSET_Y + row * BLOCK_SIZE, cells[row * FRAME_COLS + col]);
        }
        ctx.putImageData(image, 0, 0);
        drawMarkers(ctx);
    }

    function metadataCells(cells, header) {
        const values = bytesToValues(header, METADATA_VALUES);
        for (let i = 0; i < values.length; i++) cells[METADATA_ROWS[Math.floor(i / FRAME_COLS)] * FRAME_COLS + (i % FRAME_COLS)] = values[i];
    }

    function drawMarkers(ctx) {
        const drawL = (x, y, horizontalRight, verticalDown, colour) => {
            ctx.fillStyle = colour;
            const hx = horizontalRight ? x : x - MARKER_SIZE;
            const hy = verticalDown ? y : y - MARKER_THICKNESS;
            const vx = horizontalRight ? x : x - MARKER_THICKNESS;
            const vy = verticalDown ? y : y - MARKER_SIZE;
            ctx.fillRect(hx, hy, MARKER_SIZE, MARKER_THICKNESS);
            ctx.fillRect(vx, vy, MARKER_THICKNESS, MARKER_SIZE);
        };
        drawL(24, 36, true, true, "rgb(0,255,0)");
        drawL(FRAME_WIDTH - 24, 36, false, true, "rgb(255,0,0)");
        drawL(24, FRAME_HEIGHT - 36, true, false, "rgb(0,0,255)");
        drawL(FRAME_WIDTH - 24, FRAME_HEIGHT - 36, false, false, "rgb(255,255,0)");
    }

    function prepareCanvas(canvas) {
        canvas.width = FRAME_WIDTH;
        canvas.height = FRAME_HEIGHT;
        canvas.style.imageRendering = "pixelated";
        return canvas.getContext("2d", { alpha: false });
    }

    function drawCalibrationFrame(canvas) {
        const cells = new Uint8Array(FRAME_COLS * FRAME_ROWS);
        const [startCol, startRow] = CALIBRATION_GRID;
        for (let value = 0; value < 64; value++) cells[(startRow + Math.floor(value / CALIBRATION_GRID_SIZE)) * FRAME_COLS + startCol + value % CALIBRATION_GRID_SIZE] = value;
        metadataCells(cells, packHeader({ calibration: true }));
        renderCells(canvas, cells);
    }

    function drawDataFrame(canvas, payload, header, seq) {
        const cells = new Uint8Array(FRAME_COLS * FRAME_ROWS);
        const values = bytesToValues(payload, DATA_VALUES);
        for (let i = 0; i < DATA_POSITIONS.length; i++) {
            const [col, row] = DATA_POSITIONS[i]; cells[row * FRAME_COLS + col] = values[i];
        }
        if ((seq % 30) === 0) REFERENCE_CELLS.forEach((cell, index) => { cells[cell] = REFERENCE_VALUES[index]; });
        metadataCells(cells, header);
        renderCells(canvas, cells);
    }

    root.VEFProtocol = {
        FRAME_WIDTH, FRAME_HEIGHT, FRAME_COLS, FRAME_ROWS, BLOCK_SIZE,
        GRID_OFFSET_X, GRID_OFFSET_Y, METADATA_ROWS, METADATA_VALUES,
        REFERENCE_CELLS, REFERENCE_VALUES, DATA_POSITIONS, DATA_VALUES,
        PAYLOAD_BYTES, FOUNTAIN_BLOCK_SIZE, HEADER_BYTES, LEVELS,
        MAX_INDICES, CALIBRATION_GRID, CALIBRATION_GRID_SIZE,
        MARKER_SIZE, MARKER_THICKNESS, MARKER_ANCHORS,
        bytesToValues, valuesToBytes, valueToRgb, packHeader, parseHeader,
        crc32, drawCalibrationFrame, drawDataFrame, prepareCanvas
    };
})(window);
