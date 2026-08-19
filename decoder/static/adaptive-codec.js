/* PURE color-grid adaptive codec. NO QR FALLBACK.
 * Dinâmica: adjust cores (16→32→64) based on real-time success rate.
 * No patents, no standard codecs — just pure revolutionary pixel-packing.
 */
(function(root){
    const G = root.VEFColorGrid;
    class PureAdaptiveCodec {
        constructor() {
            this.colorMode = 16;  // start safe
            this.successRate = 1.0;
            this.frameCount = 0;
            this.successCount = 0;
        }
        encode(bytes) {
            const palette = this._getPalette(this.colorMode);
            return this._encodeWithPalette(bytes, palette);
        }
        decode(imageData, cols, rows) {
            const palette = this._getPalette(this.colorMode);
            return this._decodeWithPalette(imageData, cols, rows, palette);
        }
        _getPalette(colorCount) {
            if (colorCount === 16) return G.PALETTE;
            // Extend to 32/64 by interpolating
            const base = G.PALETTE.slice(0, colorCount);
            while (base.length < colorCount) {
                base.push(this._generateNewColor(base.length));
            }
            return base;
        }
        _generateNewColor(idx) {
            const h = (idx / 32) * 360;
            const v = 0.5 + (idx % 4) * 0.1;
            const c = v * 0.8;
            const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
            const m = v - c;
            let r, g, b;
            if (h < 60) [r, g, b] = [c, x, 0];
            else if (h < 120) [r, g, b] = [x, c, 0];
            else if (h < 180) [r, g, b] = [0, c, x];
            else if (h < 240) [r, g, b] = [0, x, c];
            else if (h < 300) [r, g, b] = [x, 0, c];
            else [r, g, b] = [c, 0, x];
            return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
        }
        _encodeWithPalette(bytes, palette) {
            const bitsPerPixel = Math.log2(palette.length);
            const pixels = new Uint8ClampedArray(bytes.length * 8 / bitsPerPixel * 4).fill(255);
            const w = Math.ceil(Math.sqrt(pixels.length / 4));
            const h = Math.ceil(pixels.length / 4 / w);
            let bitPos = 0;
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    let v = 0;
                    for (let b = 0; b < bitsPerPixel; b++) {
                        const byteIdx = bitPos >> 3, bitIdx = 7 - (bitPos & 7);
                        const bit = bitPos < bytes.length * 8 ? (bytes[byteIdx] >> bitIdx) & 1 : 0;
                        v = (v << 1) | bit;
                        bitPos++;
                    }
                    const rgb = palette[v % palette.length];
                    const o = (y * w + x) * 4;
                    pixels[o] = rgb[0]; pixels[o + 1] = rgb[1]; pixels[o + 2] = rgb[2]; pixels[o + 3] = 255;
                }
            }
            return { cols: w, rows: h, pixels };
        }
        _decodeWithPalette(imageData, cols, rows, palette) {
            const { data } = imageData;
            const bitsPerPixel = Math.log2(palette.length);
            const bits = [];
            for (let y = 0; y < Math.min(rows, imageData.height); y++) {
                for (let x = 0; x < Math.min(cols, imageData.width); x++) {
                    const o = (y * imageData.width + x) * 4;
                    const rgb = [data[o], data[o + 1], data[o + 2]];
                    const idx = this._nearestColor(rgb, palette);
                    for (let b = bitsPerPixel - 1; b >= 0; b--) {
                        bits.push((idx >> b) & 1);
                    }
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
        _nearestColor(rgb, palette) {
            let best = 0, bestDist = Infinity;
            for (let i = 0; i < palette.length; i++) {
                const c = palette[i];
                const d = (rgb[0] - c[0]) ** 2 + (rgb[1] - c[1]) ** 2 + (rgb[2] - c[2]) ** 2;
                if (d < bestDist) { bestDist = d; best = i; }
            }
            return best;
        }
        recordFrameResult(success) {
            this.frameCount++;
            if (success) this.successCount++;
            const newRate = this.successCount / Math.max(1, this.frameCount);
            this.successRate = this.successRate * 0.8 + newRate * 0.2;
            this._adaptDensity();
        }
        _adaptDensity() {
            if (this.successRate > 0.96 && this.colorMode === 16) {
                this.colorMode = 32;
                if (window.VEF_DEBUG) console.log('[Adapter] 16→32 cores');
            } else if (this.successRate > 0.98 && this.colorMode === 32) {
                this.colorMode = 64;
                if (window.VEF_DEBUG) console.log('[Adapter] 32→64 cores');
            } else if (this.successRate < 0.70 && this.colorMode === 64) {
                this.colorMode = 32;
                if (window.VEF_DEBUG) console.log('[Adapter] 64→32 cores');
            } else if (this.successRate < 0.60 && this.colorMode === 32) {
                this.colorMode = 16;
                if (window.VEF_DEBUG) console.log('[Adapter] 32→16 cores');
            }
        }
    }
    root.VEFPureAdaptiveCodec = PureAdaptiveCodec;
})(typeof window !== "undefined" ? window : globalThis);
