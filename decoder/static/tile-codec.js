/*
 * VEF tile codec.
 *
 * A tile is not a flat colour square. It contains a 4x4 high-contrast symbol
 * (four bits) painted with one of four calibrated colours (two bits): 64
 * values per 8x8 tile. The symbol gives the camera something structural to
 * recognise even when exposure changes; the colour carries the extra bits.
 */
(function (root) {
    "use strict";

    const TILE_SIZE = 8;
    const MICRO_SIZE = 2;
    const MICRO_COUNT = 16;
    const COLORS = [
        [255, 255, 255], // white
        [255, 72, 72],   // red
        [72, 255, 112],  // green
        [72, 144, 255]   // blue
    ];

    function popcount(value) {
        let count = 0;
        while (value) { value &= value - 1; count++; }
        return count;
    }

    function bitDistance(a, b) { return popcount((a ^ b) & 0xffff); }

    // Select balanced 4x4 patterns with a useful minimum Hamming distance.
    // Every symbol has eight active cells, so the colour sample has the same
    // weight regardless of which symbol was chosen.
    function makePatterns() {
        const patterns = [];
        for (let candidate = 0; candidate <= 0xffff && patterns.length < 16; candidate++) {
            if (popcount(candidate) !== 8) continue;
            if (patterns.every(existing => bitDistance(existing, candidate) >= 6)) patterns.push(candidate);
        }
        return patterns;
    }

    const PATTERNS = makePatterns();
    const PATTERN_INDEX = new Map(PATTERNS.map((pattern, index) => [pattern, index]));

    function colour(value) { return COLORS[value & 3]; }

    const tileCache = new Array(64);

    function cachedTile(value) {
        const key = value & 63;
        if (tileCache[key]) return tileCache[key];
        const pixels = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
        const pattern = PATTERNS[(key >>> 2) & 15];
        const rgb = colour(key);
        for (let cell = 0; cell < MICRO_COUNT; cell++) {
            const on = (pattern >>> cell) & 1;
            for (let dy = 0; dy < MICRO_SIZE; dy++) for (let dx = 0; dx < MICRO_SIZE; dx++) {
                const x = (cell % 4) * MICRO_SIZE + dx;
                const y = Math.floor(cell / 4) * MICRO_SIZE + dy;
                const offset = (y * TILE_SIZE + x) * 4;
                pixels[offset] = on ? rgb[0] : 0;
                pixels[offset + 1] = on ? rgb[1] : 0;
                pixels[offset + 2] = on ? rgb[2] : 0;
                pixels[offset + 3] = 255;
            }
        }
        tileCache[key] = pixels;
        return pixels;
    }

    function paintTile(buffer, stride, x, y, value) {
        const tile = cachedTile(value);
        for (let row = 0; row < TILE_SIZE; row++) {
            const source = tile.subarray(row * TILE_SIZE * 4, (row + 1) * TILE_SIZE * 4);
            buffer.set(source, ((y + row) * stride + x) * 4);
        }
    }

    function drawTile(ctx, x, y, value, tileSize = TILE_SIZE) {
        if (tileSize === TILE_SIZE && ctx.canvas && ctx.canvas.width >= x + TILE_SIZE) {
            const image = new ImageData(cachedTile(value), TILE_SIZE, TILE_SIZE);
            ctx.putImageData(image, x, y);
            return;
        }
        const pattern = PATTERNS[(value >>> 2) & 15];
        const rgb = colour(value);
        const micro = tileSize / 4;
        for (let cell = 0; cell < MICRO_COUNT; cell++) {
            const on = (pattern >>> cell) & 1;
            ctx.fillStyle = on ? `rgb(${rgb[0]},${rgb[1]},${rgb[2]})` : "rgb(0,0,0)";
            ctx.fillRect(x + (cell % 4) * micro, y + Math.floor(cell / 4) * micro, micro, micro);
        }
    }

    function luminance(rgb) { return rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114; }

    function extract(samples) {
        const brightness = samples.map(luminance);
        let low = Math.min(...brightness);
        let high = Math.max(...brightness);
        // Keep the decision stable when a camera lifts black slightly.
        const threshold = low + (high - low) * 0.48;
        let mask = 0;
        const active = [];
        for (let cell = 0; cell < MICRO_COUNT; cell++) {
            if (brightness[cell] > threshold) { mask |= 1 << cell; active.push(cell); }
        }
        let bestPattern = 0;
        let bestDistance = Infinity;
        for (let index = 0; index < PATTERNS.length; index++) {
            const distance = bitDistance(mask, PATTERNS[index]);
            if (distance < bestDistance) { bestDistance = distance; bestPattern = index; }
        }
        const source = active.length ? active : [...Array(MICRO_COUNT).keys()];
        const measured = [0, 0, 0];
        for (const cell of source) {
            measured[0] += samples[cell][0];
            measured[1] += samples[cell][1];
            measured[2] += samples[cell][2];
        }
        return {
            pattern: bestPattern,
            patternDistance: bestDistance,
            colour: measured.map(value => value / source.length),
            contrast: high - low
        };
    }

    class ColourCalibrator {
        constructor() {
            this.samples = [[], [], [], []];
            this.centres = COLORS.map(rgb => rgb.slice());
            this.ready = false;
        }

        add(measured, colourIndex) {
            if (colourIndex >= 0 && colourIndex < 4) this.samples[colourIndex].push(measured);
        }

        finish() {
            for (let index = 0; index < 4; index++) {
                if (!this.samples[index].length) continue;
                this.centres[index] = [0, 1, 2].map(channel =>
                    this.samples[index].reduce((sum, sample) => sum + sample[channel], 0) / this.samples[index].length
                );
            }
            this.ready = true;
        }

        classify(measured) {
            let best = 0;
            let distance = Infinity;
            for (let index = 0; index < 4; index++) {
                const candidate = this.centres[index];
                const next = Math.hypot(measured[0] - candidate[0], measured[1] - candidate[1], measured[2] - candidate[2]);
                if (next < distance) { distance = next; best = index; }
            }
            return { index: best, distance };
        }
    }

    function decodeSamples(samples, calibrator = new ColourCalibrator()) {
        const shape = extract(samples);
        const colour = calibrator.classify(shape.colour);
        return {
            value: (shape.pattern << 2) | colour.index,
            pattern: shape.pattern,
            colour: colour.index,
            patternDistance: shape.patternDistance,
            colourDistance: colour.distance,
            contrast: shape.contrast,
            valid: shape.patternDistance <= 4 && shape.contrast >= 18
        };
    }

    root.VEFTiles = {
        TILE_SIZE,
        MICRO_SIZE,
        MICRO_COUNT,
        COLORS,
        PATTERNS,
        PATTERN_INDEX,
        drawTile,
        paintTile,
        cachedTile,
        extract,
        decodeSamples,
        ColourCalibrator
    };
})(window);
