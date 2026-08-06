/* VEF tile codec: a readable 2x2 symbol plus a calibrated colour strip. */
(function (root) {
    "use strict";
    const TILE_SIZE = 8;
    const COLORS = [
        [255, 255, 255], // white
        [255, 72, 72],   // red
        [72, 255, 112],  // green
        [72, 144, 255]   // blue
    ];
    // Four large quadrants carry four symbol bits. Unlike pseudo-random noise,
    // this remains visibly structured when the full frame is on a screen.
    const PATTERNS = Array.from({ length: 16 }, (_, value) => value);
    const PATTERN_INDEX = new Map(PATTERNS.map((pattern, index) => [pattern, index]));
    const tileCache = new Array(64);

    function colour(value) { return COLORS[value & 3]; }
    function fillRect(buffer, stride, x, y, width, height, rgb) {
        for (let row = y; row < y + height; row++) for (let col = x; col < x + width; col++) {
            const offset = (row * stride + col) * 4;
            buffer[offset] = rgb[0]; buffer[offset + 1] = rgb[1]; buffer[offset + 2] = rgb[2]; buffer[offset + 3] = 255;
        }
    }

    function cachedTile(value) {
        const key = value & 63;
        if (tileCache[key]) return tileCache[key];
        const pixels = new Uint8ClampedArray(TILE_SIZE * TILE_SIZE * 4);
        const pattern = PATTERNS[(key >>> 2) & 15];
        const rgb = colour(key);
        fillRect(pixels, TILE_SIZE, 0, 0, 2, TILE_SIZE, rgb);
        for (let quadrant = 0; quadrant < 4; quadrant++) if ((pattern >>> quadrant) & 1) {
            fillRect(pixels, TILE_SIZE, 2 + (quadrant % 2) * 3, (quadrant > 1 ? 4 : 0), 3, 4, [255, 255, 255]);
        }
        tileCache[key] = pixels;
        return pixels;
    }

    function paintTile(buffer, stride, x, y, value) {
        const tile = cachedTile(value);
        for (let row = 0; row < TILE_SIZE; row++) buffer.set(tile.subarray(row * TILE_SIZE * 4, (row + 1) * TILE_SIZE * 4), ((y + row) * stride + x) * 4);
    }

    function drawTile(ctx, x, y, value, tileSize = TILE_SIZE) {
        if (tileSize === TILE_SIZE && ctx.canvas && ctx.canvas.width >= x + TILE_SIZE) {
            ctx.putImageData(new ImageData(cachedTile(value), TILE_SIZE, TILE_SIZE), x, y);
            return;
        }
        const pattern = PATTERNS[(value >>> 2) & 15], rgb = colour(value), scale = tileSize / TILE_SIZE;
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`; ctx.fillRect(x, y, 2 * scale, tileSize);
        for (let quadrant = 0; quadrant < 4; quadrant++) if ((pattern >>> quadrant) & 1) {
            ctx.fillStyle = "white";
            ctx.fillRect(x + (2 + (quadrant % 2) * 3) * scale, y + (quadrant > 1 ? 4 : 0) * scale, 3 * scale, 4 * scale);
        }
    }

    function luminance(rgb) { return rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114; }
    function extract(samples) {
        const brightness = samples.pattern.map(luminance);
        const low = Math.min(...brightness), high = Math.max(...brightness);
        const threshold = low + (high - low) * .48;
        let pattern = high - low < 1 && high > 128 ? 15 : 0;
        brightness.forEach((value, index) => { if (high - low >= 1 && value > threshold) pattern |= 1 << index; });
        return { pattern, patternDistance: 0, colour: samples.colour, contrast: high - low };
    }

    class ColourCalibrator {
        constructor() { this.samples = [[], [], [], []]; this.centres = COLORS.map(rgb => rgb.slice()); this.ready = false; }
        add(measured, index) { if (index >= 0 && index < 4) this.samples[index].push(measured); }
        finish() {
            for (let index = 0; index < 4; index++) if (this.samples[index].length) this.centres[index] = [0, 1, 2].map(channel => this.samples[index].reduce((sum, sample) => sum + sample[channel], 0) / this.samples[index].length);
            this.ready = true;
        }
        classify(measured) {
            let best = 0, distance = Infinity;
            for (let index = 0; index < 4; index++) { const c=this.centres[index], next=Math.hypot(measured[0]-c[0],measured[1]-c[1],measured[2]-c[2]); if(next<distance){best=index;distance=next;} }
            return { index: best, distance };
        }
    }

    function decodeSamples(samples, calibrator = new ColourCalibrator()) {
        const shape = extract(samples), colour = calibrator.classify(shape.colour);
        return { value: (shape.pattern << 2) | colour.index, pattern: shape.pattern, colour: colour.index, patternDistance: 0, colourDistance: colour.distance, contrast: shape.contrast, valid: shape.contrast >= 18 || shape.pattern === 0 || shape.pattern === 15 };
    }

    root.VEFTiles = { TILE_SIZE, COLORS, PATTERNS, PATTERN_INDEX, drawTile, paintTile, cachedTile, extract, decodeSamples, ColourCalibrator };
})(window);
