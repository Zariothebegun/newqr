/* High-density colour-grid visual codec — replaces the JAB Code/wasm layer.
 *
 * Why: measured JAB (this project's wasm build) tops out around ~3.5 KB/s of
 * PURE encode+decode compute, regardless of frame size (see git history /
 * README benchmarks) — nowhere near enough for anything video-sized. That
 * ceiling comes from JAB's LDPC error-correction and finder-pattern search,
 * which are expensive by design (they're what make JAB robust to arbitrary
 * camera angles and printed-code wear). We don't need that much robustness
 * for a screen-to-camera link the user points deliberately: we need speed.
 *
 * This codec renders payload bytes directly as a grid of coloured cells
 * (4 bits/cell via a 16-colour palette) with 4 solid corner markers for a
 * perspective fix and a calibration strip so the decoder can adapt its
 * colour classifier to the *current frame's* actual lighting instead of
 * assuming fixed RGB values. Both encode and decode are plain canvas/pixel
 * math — no wasm, no ECC search — so they cost low-single-digit
 * milliseconds even at large grid sizes, instead of JAB's 150-700ms.
 *
 * Trade-off, stated plainly: JAB self-corrects bit errors via LDPC; this
 * codec does not. Instead every frame carries its own CRC32 (see
 * packet-binary.js) and a frame that doesn't check out is simply dropped —
 * the Fountain layer above already assumes frames get dropped and repeats
 * until enough arrive, so this is the same failure-handling philosophy JAB
 * already used here, just pushed one layer up.
 */
(function (root) {
    "use strict";

    // ---- Palette -------------------------------------------------------
    // 16 colours = 4 bits/cell. Full saturation/value so they stay far apart
    // in colour space even under a camera's auto white-balance. Marker
    // colour (pure magenta) is deliberately NOT in this wheel so corner
    // detection can never be confused with a data cell.
    const MARKER_RGB = [255, 0, 255];
    const PALETTE = (() => {
        const colors = [[0, 0, 0], [255, 255, 255]]; // black, white always included: cheapest to tell apart
        const hueSteps = 14; // + black/white = 16
        for (let i = 0; i < hueSteps; i++) {
            // Skip the wedge around 300 degrees (magenta) so no data colour
            // is ever a near-miss for the marker colour.
            const hue = (i / hueSteps) * 300; // 0..300, leaves 300-360 free
            colors.push(hsvToRgb(hue, 1, 1));
        }
        return colors;
    })();
    const BITS_PER_CELL = 4; // log2(16)

    function hsvToRgb(h, s, v) {
        const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
        let r, g, b;
        if (h < 60) [r, g, b] = [c, x, 0];
        else if (h < 120) [r, g, b] = [x, c, 0];
        else if (h < 180) [r, g, b] = [0, c, x];
        else if (h < 240) [r, g, b] = [0, x, c];
        else if (h < 300) [r, g, b] = [x, 0, c];
        else [r, g, b] = [c, 0, x];
        return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }
    function colorDist2(a, b) {
        const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
        return dr * dr + dg * dg + db * db;
    }
    function nearestIndex(rgb, palette) {
        let best = 0, bestDist = Infinity;
        for (let i = 0; i < palette.length; i++) {
            const d = colorDist2(rgb, palette[i]);
            if (d < bestDist) { bestDist = d; best = i; }
        }
        return best;
    }

    // ---- Geometry --------------------------------------------------------
    // All sizes are in "modules" (1 module = 1 native pixel, upscaled via
    // CSS `image-rendering: pixelated` exactly like the old JAB frames were,
    // so the rest of the send/receive UI needs no changes).
    const MARKER_SIZE = 6;      // solid magenta corner squares, in modules
    const QUIET_ZONE = 4;       // white margin around the whole code
    const CAL_SWATCH = 2;       // calibration swatch size, in modules

    function gridGeometry(cols, rows) {
        // Calibration strip: one extra row under the top markers holding
        // all 16 palette colours as swatches, `CAL_SWATCH` modules tall.
        const calRow = MARKER_SIZE; // sits right below the top corner markers
        return { cols, rows, calRow };
    }

    // capacityBytes(cols, rows) -> usable data bytes for a given grid size,
    // after subtracting the 4 markers and the calibration strip.
    function capacityBytes(cols, rows) {
        // Count usable cells exactly the way dataCellPositions walks them,
        // rather than approximating reserved regions with a formula — a
        // formula that under-counts real overhead (e.g. wider-than-nominal
        // calibration swatches on larger grids) silently produces frames a
        // few dozen bytes too small for the payload they were sized for.
        let usableCells = 0;
        for (const _ of dataCellPositions(cols, rows)) usableCells++;
        return Math.floor(usableCells * BITS_PER_CELL / 8);
    }
    // Pick the smallest square-ish grid that fits `byteLen` bytes.
    function gridForBytes(byteLen) {
        let side = 32;
        while (capacityBytes(side, side) < byteLen && side < 4096) side += 8;
        return { cols: side, rows: side };
    }

    // Deterministic cell -> (x,y) walk that skips marker & calibration
    // regions, shared by encode and decode so they always agree on order.
    function* dataCellPositions(cols, rows) {
        const calSwatchesPerRow = Math.max(1, Math.floor(cols / CAL_SWATCH));
        for (let y = 0; y < rows; y++) {
            const inTopMarkerBand = y < MARKER_SIZE;
            const inBottomMarkerBand = y >= rows - MARKER_SIZE;
            const inCalBand = y >= MARKER_SIZE && y < MARKER_SIZE + CAL_SWATCH;
            for (let x = 0; x < cols; x++) {
                const inLeftMarker = x < MARKER_SIZE;
                const inRightMarker = x >= cols - MARKER_SIZE;
                if ((inTopMarkerBand || inBottomMarkerBand) && (inLeftMarker || inRightMarker)) continue; // corner marker
                if (inCalBand) continue; // calibration strip reserved across the full row
                yield [x, y];
            }
        }
    }
    function calibrationSwatchRects(cols) {
        // 16 swatches laid out left-to-right just under the top markers,
        // each CAL_SWATCH x CAL_SWATCH modules, starting after the left
        // marker column and stopping before the right marker column.
        const startX = MARKER_SIZE, endX = cols - MARKER_SIZE;
        const available = endX - startX;
        const swatchW = Math.max(2, Math.floor(available / PALETTE.length));
        const rects = [];
        for (let i = 0; i < PALETTE.length; i++) {
            rects.push({ x: startX + i * swatchW, y: MARKER_SIZE, w: Math.min(swatchW, CAL_SWATCH * 4), h: CAL_SWATCH });
        }
        return rects;
    }

    // ---- Encode: bytes -> {cols, rows, pixels(Uint8ClampedArray RGBA)} ---
    function encodeFrame(bytes) {
        const { cols, rows } = gridForBytes(bytes.length);
        const pixels = new Uint8ClampedArray(cols * rows * 4).fill(255); // white background
        function setCell(x, y, rgb) {
            const o = (y * cols + x) * 4;
            pixels[o] = rgb[0]; pixels[o + 1] = rgb[1]; pixels[o + 2] = rgb[2]; pixels[o + 3] = 255;
        }
        function fillRect(x0, y0, w, h, rgb) {
            for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setCell(x, y, rgb);
        }
        // 4 corner markers
        fillRect(0, 0, MARKER_SIZE, MARKER_SIZE, MARKER_RGB);
        fillRect(cols - MARKER_SIZE, 0, MARKER_SIZE, MARKER_SIZE, MARKER_RGB);
        fillRect(0, rows - MARKER_SIZE, MARKER_SIZE, MARKER_SIZE, MARKER_RGB);
        fillRect(cols - MARKER_SIZE, rows - MARKER_SIZE, MARKER_SIZE, MARKER_SIZE, MARKER_RGB);
        // calibration strip
        calibrationSwatchRects(cols).forEach((rect, i) => {
            fillRect(rect.x, rect.y, rect.w, rect.h, PALETTE[i]);
        });
        // data cells: walk nibble by nibble
        let bitPos = 0;
        const totalBits = bytes.length * 8;
        function nextNibble() {
            if (bitPos >= totalBits) return 0; // padding
            let v = 0;
            for (let b = 0; b < BITS_PER_CELL; b++) {
                const byteIdx = bitPos >> 3, bitIdx = 7 - (bitPos & 7);
                const bit = bitPos < totalBits ? (bytes[byteIdx] >> bitIdx) & 1 : 0;
                v = (v << 1) | bit;
                bitPos++;
            }
            return v;
        }
        for (const [x, y] of dataCellPositions(cols, rows)) {
            setCell(x, y, PALETTE[nextNibble()]);
        }
        return { cols, rows, pixels };
    }

    // ---- Homography (4-point DLT) ----------------------------------------
    // Solves for the 3x3 projective matrix H such that H * src = dst (both
    // homogeneous), given 4 point correspondences. Standard direct linear
    // transform; solved via Gaussian elimination on the 8x8 linear system.
    function computeHomography(srcPts, dstPts) {
        const A = [];
        const b = [];
        for (let i = 0; i < 4; i++) {
            const [x, y] = srcPts[i], [u, v] = dstPts[i];
            A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
            A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
        }
        const h = solveLinear(A, b); // 8 unknowns: h11..h32 (h33 = 1)
        if (!h) return null;
        return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
    }
    function solveLinear(A, b) {
        const n = A.length;
        const M = A.map((row, i) => [...row, b[i]]);
        for (let col = 0; col < n; col++) {
            let pivot = col;
            for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
            if (Math.abs(M[pivot][col]) < 1e-12) return null;
            [M[col], M[pivot]] = [M[pivot], M[col]];
            for (let r = 0; r < n; r++) {
                if (r === col) continue;
                const factor = M[r][col] / M[col][col];
                for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
            }
        }
        return M.map((row, i) => row[n] / row[i]);
    }
    function applyHomography(H, x, y) {
        const w = H[6] * x + H[7] * y + H[8];
        return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
    }

    // ---- Marker detection --------------------------------------------------
    // Loose magenta threshold (R high, B high, G low, R~B) tolerant of
    // white-balance drift, then largest-blob-per-quadrant via a simple flood
    // fill. Returns 4 centroids in [top-left, top-right, bottom-left,
    // bottom-right] order, or null if any quadrant has no clear blob.
    function looksLikeMarker(r, g, b) {
        return r > 120 && b > 120 && g < Math.min(r, b) * 0.6 && Math.abs(r - b) < 70;
    }
    function findMarkers(imageData) {
        const { width, height, data } = imageData;
        const stride = Math.max(1, Math.floor(Math.min(width, height) / 400)); // adaptive: fine on small frames, coarser on big ones
        const visited = new Uint8Array(width * height);
        const blobs = [];
        for (let y = 0; y < height; y += stride) {
            for (let x = 0; x < width; x += stride) {
                const idx = y * width + x;
                if (visited[idx]) continue;
                const o = idx * 4;
                if (!looksLikeMarker(data[o], data[o + 1], data[o + 2])) continue;
                // flood fill (BFS on the stride grid) to get size + bounding box.
                const stack = [[x, y]];
                visited[idx] = 1;
                let minX = x, maxX = x, minY = y, maxY = y, count = 0;
                while (stack.length) {
                    const [cx, cy] = stack.pop();
                    if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                    if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
                    count++;
                    for (const [dx, dy] of [[stride, 0], [-stride, 0], [0, stride], [0, -stride]]) {
                        const nx = cx + dx, ny = cy + dy;
                        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                        const nidx = ny * width + nx;
                        if (visited[nidx]) continue;
                        const no = nidx * 4;
                        if (!looksLikeMarker(data[no], data[no + 1], data[no + 2])) continue;
                        visited[nidx] = 1;
                        stack.push([nx, ny]);
                    }
                }
                const w = maxX - minX + stride, h = maxY - minY + stride;
                const aspect = w / h;
                // Reject slivers/noise: a real marker is roughly square and
                // has a plausible pixel count for its bounding box (a sparse
                // diagonal line of noise pixels has a big bbox but low fill).
                const fill = count / ((w / stride) * (h / stride));
                if (aspect > 0.5 && aspect < 2 && fill > 0.5 && count >= 4) {
                    blobs.push({ cx: (minX + maxX) / 2 + stride / 2, cy: (minY + maxY) / 2 + stride / 2, count });
                }
            }
        }
        if (blobs.length < 4) return null;
        // Keep the 4 largest plausible blobs (real markers are the biggest
        // solid magenta regions; smaller ones are noise/false positives).
        blobs.sort((a, b) => b.count - a.count);
        const top4 = blobs.slice(0, 4);
        // Assign TL/TR/BL/BR relative to the group's own centroid, so this
        // works under rotation/translation instead of assuming a fixed
        // on-screen layout.
        const gcx = top4.reduce((s, p) => s + p.cx, 0) / 4;
        const gcy = top4.reduce((s, p) => s + p.cy, 0) / 4;
        const tl = top4.find(p => p.cx <= gcx && p.cy <= gcy);
        const tr = top4.find(p => p.cx > gcx && p.cy <= gcy);
        const bl = top4.find(p => p.cx <= gcx && p.cy > gcy);
        const br = top4.find(p => p.cx > gcx && p.cy > gcy);
        if (!tl || !tr || !bl || !br) return null; // ambiguous layout, don't guess
        return [[tl.cx, tl.cy], [tr.cx, tr.cy], [bl.cx, bl.cy], [br.cx, br.cy]];
    }

    // ---- Decode: ImageData -> Uint8Array | null ---------------------------
    function decodeFrame(imageData, cols, rows) {
        const markers = findMarkers(imageData);
        if (!markers) return null;
        const [tl, tr, bl, br] = markers;
        // Marker centroids sit at the CENTER of each MARKER_SIZE block; map
        // those to the corresponding centre points in ideal grid space.
        const half = MARKER_SIZE / 2;
        const srcPts = [tl, tr, bl, br];
        const dstPts = [[half, half], [cols - half, half], [half, rows - half], [cols - half, rows - half]];
        const H = computeHomography(dstPts, srcPts); // grid-space -> image-space
        if (!H) return null;

        const { width, height, data } = imageData;
        function sample(gx, gy) {
            const [px, py] = applyHomography(H, gx, gy);
            if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
            // Clamp into bounds instead of rejecting: an edge cell landing
            // exactly on the image boundary (which happens routinely from
            // the +0.5 cell-centre offset, not just camera noise) should
            // still be sampled, just from whatever's nearest inside frame.
            const ix = Math.min(Math.max(Math.floor(px), 0), width - 1);
            const iy = Math.min(Math.max(Math.floor(py), 0), height - 1);
            const o = (iy * width + ix) * 4;
            return [data[o], data[o + 1], data[o + 2]];
        }

        // Per-frame colour classifier: sample the calibration swatches
        // through the SAME homography so it reflects this frame's actual
        // lighting/white balance, not a fixed assumption.
        const framePalette = [];
        for (const rect of calibrationSwatchRects(cols)) {
            const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
            const rgb = sample(cx, cy);
            if (!rgb) return null;
            framePalette.push(rgb);
        }

        const bits = [];
        for (const [x, y] of dataCellPositions(cols, rows)) {
            const rgb = sample(x + 0.5, y + 0.5);
            if (!rgb) return null;
            const idx = nearestIndex(rgb, framePalette);
            for (let b = BITS_PER_CELL - 1; b >= 0; b--) bits.push((idx >> b) & 1);
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

    root.VEFColorGrid = { PALETTE, BITS_PER_CELL, MARKER_SIZE, capacityBytes, gridForBytes, encodeFrame, decodeFrame, findMarkers, computeHomography, applyHomography };
})(typeof window !== "undefined" ? window : globalThis);
