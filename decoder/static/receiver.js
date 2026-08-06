/* Camera/video receiver for the 800x600 colour-block Fountain stream. */
(() => {
    "use strict";

    const P = window.VEFProtocol;
    const F = window.VEFFountain;
    const $ = id => document.getElementById(id);
    const state = {
        active: false,
        stream: null,
        sourceUrl: null,
        sourceMode: null,
        selectedVideo: null,
        animationFrame: null,
        canvasContext: null,
        frameCount: 0,
        validFrames: 0,
        framesSinceFps: 0,
        lastFpsAt: 0,
        fps: 0,
        calibrator: null,
        geometry: null,
        decoder: null,
        transfer: null,
        fileData: null,
        fileName: "received_file",
        debug: false,
        processing: false
    };

    function log(message) {
        console.log("[VEF-3 receiver]", message);
        if (state.debug && $("debug-log")) $("debug-log").insertAdjacentHTML("beforeend", `<div>${message}</div>`);
    }

    function showMessage(text, type = "info", persistent = false) {
        const element = $("message");
        element.textContent = text;
        element.className = `message ${type}`;
        element.classList.remove("hidden");
        if (!persistent) window.setTimeout(() => element.classList.add("hidden"), 3500);
    }

    function updateStatus(text, type = "") {
        $("status").textContent = text;
        $("status").className = `status-value ${type}`;
    }

    function clearTransfer() {
        state.decoder = null;
        state.transfer = null;
        state.fileData = null;
        state.fileName = "received_file";
        state.validFrames = 0;
        $("download-btn").classList.add("hidden");
        updateProgress();
    }

    // Solve the eight unknowns of a projective transform. The four L markers
    // give us camera points; the known frame coordinates give us the target.
    function solveHomography(source, target) {
        const matrix = [];
        for (let i = 0; i < 4; i++) {
            const [x, y] = source[i];
            const [u, v] = target[i];
            matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
            matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
        }
        for (let column = 0; column < 8; column++) {
            let pivot = column;
            for (let row = column + 1; row < 8; row++) if (Math.abs(matrix[row][column]) > Math.abs(matrix[pivot][column])) pivot = row;
            if (Math.abs(matrix[pivot][column]) < 1e-9) return null;
            [matrix[column], matrix[pivot]] = [matrix[pivot], matrix[column]];
            const divisor = matrix[column][column];
            for (let j = column; j < 9; j++) matrix[column][j] /= divisor;
            for (let row = 0; row < 8; row++) {
                if (row === column) continue;
                const factor = matrix[row][column];
                for (let j = column; j < 9; j++) matrix[row][j] -= factor * matrix[column][j];
            }
        }
        return matrix.map(row => row[8]).concat(1);
    }

    function project(transform, x, y) {
        const denominator = transform[6] * x + transform[7] * y + 1;
        return [
            (transform[0] * x + transform[1] * y + transform[2]) / denominator,
            (transform[3] * x + transform[4] * y + transform[5]) / denominator
        ];
    }

    function colourMatches(red, green, blue, target) {
        return Math.abs(red - target[0]) + Math.abs(green - target[1]) + Math.abs(blue - target[2]) < 180;
    }

    // Find the largest connected component for each marker colour. Data cells
    // can contain the same colours, but the 48x8 L is much larger than one
    // 8x8 data cell, so the marker wins in its quadrant.
    function findMarker(imageData, target, quadrant) {
        const step = 3;
        const cols = Math.ceil(imageData.width / step);
        const rows = Math.ceil(imageData.height / step);
        const visited = new Uint8Array(cols * rows);
        const inQuadrant = (x, y) => {
            if (quadrant === "TL") return x < imageData.width / 2 && y < imageData.height / 2;
            if (quadrant === "TR") return x >= imageData.width / 2 && y < imageData.height / 2;
            if (quadrant === "BL") return x < imageData.width / 2 && y >= imageData.height / 2;
            return x >= imageData.width / 2 && y >= imageData.height / 2;
        };
        const matches = (gx, gy) => {
            const x = Math.min(imageData.width - 1, gx * step);
            const y = Math.min(imageData.height - 1, gy * step);
            const index = (y * imageData.width + x) * 4;
            return inQuadrant(x, y) && colourMatches(imageData.data[index], imageData.data[index + 1], imageData.data[index + 2], target);
        };
        let best = null;
        for (let gy = 0; gy < rows; gy++) {
            for (let gx = 0; gx < cols; gx++) {
                const mark = gy * cols + gx;
                if (visited[mark] || !matches(gx, gy)) continue;
                const queue = [[gx, gy]];
                visited[mark] = 1;
                let count = 0, minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
                while (queue.length) {
                    const [xg, yg] = queue.pop();
                    const x = xg * step, y = yg * step;
                    count++; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
                    for (const [nx, ny] of [[xg - 1, yg], [xg + 1, yg], [xg, yg - 1], [xg, yg + 1]]) {
                        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
                        const ni = ny * cols + nx;
                        if (!visited[ni] && matches(nx, ny)) { visited[ni] = 1; queue.push([nx, ny]); }
                    }
                }
                if (!best || count > best.count) best = { count, minX, minY, maxX, maxY };
            }
        }
        if (!best || best.count < 12) return null;
        if (quadrant === "TL") return [best.minX, best.minY];
        if (quadrant === "TR") return [best.maxX, best.minY];
        if (quadrant === "BL") return [best.minX, best.maxY];
        return [best.maxX, best.maxY];
    }

    function detectGeometry(imageData) {
        const observed = [
            findMarker(imageData, [0, 255, 0], "TL"),
            findMarker(imageData, [255, 0, 0], "TR"),
            findMarker(imageData, [0, 0, 255], "BL"),
            findMarker(imageData, [255, 255, 0], "BR")
        ];
        if (observed.some(point => !point)) return null;
        const ideal = [P.MARKER_ANCHORS.TL, P.MARKER_ANCHORS.TR, P.MARKER_ANCHORS.BL, P.MARKER_ANCHORS.BR];
        const transform = solveHomography(observed, ideal);
        if (!transform) return null;
        return { transform, width: imageData.width, height: imageData.height };
    }

    function mapIdealToImage(geometry, imageData, x, y) {
        if (geometry && geometry.transform) {
            // The detected transform maps camera -> ideal. Invert by solving
            // the reverse four-corner transform when the geometry is created.
            return project(geometry.inverse, x, y);
        }
        return [x / P.FRAME_WIDTH * imageData.width, y / P.FRAME_HEIGHT * imageData.height];
    }

    function sampleIdeal(imageData, geometry, x, y, radiusOverride = null) {
        const [centerX, centerY] = mapIdealToImage(geometry, imageData, x, y);
        const radius = radiusOverride ?? Math.max(1, Math.round(Math.min(imageData.width / P.FRAME_WIDTH, imageData.height / P.FRAME_HEIGHT) * 2));
        let red = 0, green = 0, blue = 0, count = 0;
        for (let dy = -radius; dy <= radius; dy += Math.max(1, Math.floor(radius / 2))) {
            for (let dx = -radius; dx <= radius; dx += Math.max(1, Math.floor(radius / 2))) {
                const px = Math.max(0, Math.min(imageData.width - 1, Math.round(centerX + dx)));
                const py = Math.max(0, Math.min(imageData.height - 1, Math.round(centerY + dy)));
                const index = (py * imageData.width + px) * 4;
                red += imageData.data[index]; green += imageData.data[index + 1]; blue += imageData.data[index + 2]; count++;
            }
        }
        return [Math.round(red / count), Math.round(green / count), Math.round(blue / count)];
    }

    // Build the reverse transform used by mapIdealToImage.
    function geometryWithInverse(imageData) {
        const direct = detectGeometry(imageData);
        if (!direct) return null;
        const ideal = [P.MARKER_ANCHORS.TL, P.MARKER_ANCHORS.TR, P.MARKER_ANCHORS.BL, P.MARKER_ANCHORS.BR];
        const observed = [
            findMarker(imageData, [0, 255, 0], "TL"), findMarker(imageData, [255, 0, 0], "TR"),
            findMarker(imageData, [0, 0, 255], "BL"), findMarker(imageData, [255, 255, 0], "BR")
        ];
        direct.inverse = solveHomography(ideal, observed);
        return direct.inverse ? direct : null;
    }

    function sampleGrid(imageData, geometry, col, row) {
        return sampleIdeal(imageData, geometry, P.GRID_OFFSET_X + (col + 0.5) * P.BLOCK_SIZE, P.GRID_OFFSET_Y + (row + 0.5) * P.BLOCK_SIZE);
    }

    function sampleTile(imageData, geometry, col, row) {
        const samples = [];
        for (let cell = 0; cell < 16; cell++) {
            const x = P.GRID_OFFSET_X + col * P.BLOCK_SIZE + (cell % 4 + 0.5) * 2;
            const y = P.GRID_OFFSET_Y + row * P.BLOCK_SIZE + (Math.floor(cell / 4) + 0.5) * 2;
            // One center sample per micro-cell keeps the mobile decoder below
            // its camera frame budget; the cell itself is already 2x2 logical pixels.
            samples.push(sampleIdeal(imageData, geometry, x, y, 1));
        }
        return samples;
    }

    function readMetadata(imageData, geometry) {
        const values = [];
        const rawCalibrator = new VEFTiles.ColourCalibrator();
        for (const row of P.METADATA_ROWS) for (let col = 0; col < P.FRAME_COLS; col++) {
            values.push(VEFTiles.decodeSamples(sampleTile(imageData, geometry, col, row), rawCalibrator).value);
        }
        return values;
    }

    function calibrateFull(imageData, geometry) {
        const calibrator = new VEFTiles.ColourCalibrator();
        const [startCol, startRow] = P.CALIBRATION_GRID;
        for (let value = 0; value < 64; value++) {
            const extracted = VEFTiles.extract(sampleTile(imageData, geometry, startCol + value % 8, startRow + Math.floor(value / 8)));
            calibrator.add(extracted.colour, value & 3);
        }
        calibrator.finish();
        state.calibrator = calibrator;
        $("calibration").textContent = "Calibrado";
        $("calibration").className = "status-value success";
        $("calibration-value").textContent = "100%";
    }

    function calibrateReferences(imageData, geometry) {
        if (!state.calibrator) state.calibrator = new VEFTiles.ColourCalibrator();
        const cells = [...P.REFERENCE_CELLS];
        for (let index = 0; index < cells.length; index++) {
            const cell = cells[index];
            const extracted = VEFTiles.extract(sampleTile(imageData, geometry, cell % P.FRAME_COLS, Math.floor(cell / P.FRAME_COLS)));
            state.calibrator.add(extracted.colour, P.REFERENCE_VALUES[index] & 3);
        }
        state.calibrator.finish();
    }

    function updateProgress() {
        const decoder = state.decoder;
        const solved = decoder ? decoder.solvedCount : 0;
        const total = decoder ? decoder.k : 0;
        const frames = decoder ? decoder.framesNew : 0;
        const percent = total ? Math.min(100, Math.round(solved / total * 100)) : 0;
        $("packets-count").textContent = `${frames} frames · ${solved} / ${total || 0} blocos`;
        $("progress-bar").style.width = `${percent}%`;
        $("progress-percent").textContent = `${percent}%`;
        $("progress-text").textContent = total ? `${solved} blocos resolvidos · ${frames} pacotes` : "Aguardando Fountain…";
    }

    function createTransfer(header) {
        state.decoder = new F.FountainDecoder(header.k, header.blockLen, header.totalLen);
        state.transfer = header;
        state.fileData = null;
        state.fileName = header.filename;
        $("download-btn").classList.add("hidden");
        updateProgress();
    }

    function finishTransfer() {
        if (!state.decoder || !state.decoder.complete || !state.transfer) return;
        const data = state.decoder.assemble();
        if (!data) return;
        if (state.transfer.fileCrc32 && P.crc32(data) !== state.transfer.fileCrc32) {
            showMessage("Fountain completo, mas o CRC falhou. Continua a receber outros pacotes.", "error", true);
            return;
        }
        state.fileData = data;
        state.fileName = state.transfer.filename || "received_file";
        $("progress-bar").style.width = "100%";
        $("progress-percent").textContent = "100%";
        $("progress-text").textContent = "Ficheiro reconstruído";
        $("download-btn").classList.remove("hidden");
        updateStatus("Transferência completa", "success");
        showMessage(`Recebido: ${state.fileName}`, "success", true);
    }

    function processFrame(imageData) {
        if (!state.geometry || state.frameCount % 12 === 0) state.geometry = geometryWithInverse(imageData) || state.geometry;
        const geometry = state.geometry;
        const metadataValues = readMetadata(imageData, geometry);
        const header = P.parseHeader(P.valuesToBytes(metadataValues, P.HEADER_BYTES));
        if (!header) return;
        if (header.type === "calibration") {
            calibrateFull(imageData, geometry);
            updateStatus("Calibração recebida", "success");
            return;
        }
        if (header.k < 1 || header.k > 65536 || header.blockLen < 1 || header.blockLen > P.PAYLOAD_BYTES || header.indices.length < 1) return;
        if (!state.transfer || state.transfer.sessionId !== header.sessionId || state.transfer.k !== header.k) createTransfer(header);
        if (header.seq % 30 === 0) calibrateReferences(imageData, geometry);
        if (!state.calibrator) state.calibrator = new VEFTiles.ColourCalibrator();

        const values = [];
        let uncertainTiles = 0;
        for (const [col, row] of P.DATA_POSITIONS) {
            const decoded = VEFTiles.decodeSamples(sampleTile(imageData, geometry, col, row), state.calibrator);
            if (!decoded.valid) uncertainTiles++;
            values.push(decoded.value);
        }
        // Fountain handles missing frames, not silently corrupted frames. A
        // confidence gate is therefore safer than feeding a doubtful packet
        // into the decoder; the next sequence will arrive shortly.
        if (uncertainTiles > 80) return;
        const payload = P.valuesToBytes(values, header.blockLen);
        state.decoder.addPacket(header.seq, header.indices, payload);
        state.validFrames++;
        $("frame-id").textContent = `Seq: ${header.seq}`;
        updateProgress();
        finishTransfer();
    }

    function processLoop(timestamp) {
        if (!state.active) return;
        state.frameCount++;
        state.framesSinceFps++;
        if (!state.lastFpsAt) state.lastFpsAt = timestamp;
        if (timestamp - state.lastFpsAt >= 1000) {
            state.fps = state.framesSinceFps;
            state.framesSinceFps = 0;
            state.lastFpsAt = timestamp;
            $("fps").textContent = `FPS: ${state.fps}`;
        }
        const video = $("video");
        if (video.readyState >= 2 && !state.processing) {
            state.processing = true;
            try {
                const canvas = $("canvas");
                if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
                    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
                    state.canvasContext = canvas.getContext("2d", { willReadFrequently: true });
                }
                state.canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height);
                processFrame(state.canvasContext.getImageData(0, 0, canvas.width, canvas.height));
                $("frames-count").textContent = String(state.frameCount);
            } catch (error) {
                log(`Frame error: ${error.message}`);
            } finally { state.processing = false; }
        }
        state.animationFrame = requestAnimationFrame(processLoop);
    }

    function activateReadingUi(statusText) {
        state.active = true;
        state.frameCount = 0; state.framesSinceFps = 0; state.lastFpsAt = 0;
        state.calibrator = null; state.geometry = null;
        clearTransfer();
        $("video").classList.remove("hidden");
        $("start-btn").classList.add("hidden"); $("stop-btn").classList.remove("hidden");
        $("overlay").classList.remove("hidden"); $("frame-info").classList.remove("hidden");
        $("calibration-indicator").classList.remove("hidden");
        updateStatus(statusText, "success");
        state.animationFrame = requestAnimationFrame(processLoop);
    }

    async function startVideoFile(file) {
        if (!file) return;
        if (state.stream) state.stream.getTracks().forEach(track => track.stop());
        cancelAnimationFrame(state.animationFrame);
        if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
        const video = $("video");
        state.stream = null; state.sourceUrl = URL.createObjectURL(file); state.sourceMode = "file";
        video.srcObject = null; video.src = state.sourceUrl; video.controls = true; video.muted = true; video.loop = false;
        try { await video.play(); activateReadingUi("A ler vídeo guardado"); showMessage("A ler Fountain Codes do vídeo", "info"); }
        catch (error) { showMessage(`Não foi possível reproduzir o vídeo: ${error.message}`, "error", true); }
    }

    async function startCamera() {
        state.active = false; cancelAnimationFrame(state.animationFrame);
        if (state.stream) state.stream.getTracks().forEach(track => track.stop());
        state.stream = null;
        if (state.sourceUrl) { URL.revokeObjectURL(state.sourceUrl); state.sourceUrl = null; }
        state.sourceMode = "camera";
        const oldVideo = $("video"); oldVideo.removeAttribute("src"); oldVideo.load(); oldVideo.controls = false;
        if (!navigator.mediaDevices?.getUserMedia) { showMessage("A câmara precisa de HTTPS e permissão.", "error", true); return; }
        try {
            state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 800 } } });
            const video = $("video"); video.srcObject = state.stream; await video.play();
            activateReadingUi("Câmara ativa"); showMessage("Aponta para os L marcadores e blocos", "info");
        } catch (error) { showMessage(`Não foi possível abrir a câmara: ${error.message}`, "error", true); updateStatus("Erro na câmara", "error"); }
    }

    function stopCamera() {
        if (state.stream) state.stream.getTracks().forEach(track => track.stop());
        state.stream = null; state.active = false; cancelAnimationFrame(state.animationFrame);
        if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
        state.sourceUrl = null; state.sourceMode = null;
        const video = $("video"); video.srcObject = null; video.removeAttribute("src"); video.load(); video.controls = false; video.classList.add("hidden");
        $("start-btn").classList.remove("hidden"); $("stop-btn").classList.add("hidden"); $("overlay").classList.add("hidden"); $("frame-info").classList.add("hidden"); $("calibration-indicator").classList.add("hidden");
        updateStatus("Parado");
    }

    function downloadFile() {
        if (!state.fileData) return;
        const url = URL.createObjectURL(new Blob([state.fileData], { type: "application/octet-stream" }));
        const link = document.createElement("a"); link.href = url; link.download = state.fileName || "received_file";
        document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function retry() { clearTransfer(); updateStatus(state.active ? "A procurar Fountain stream" : "Pronto"); }
    window.toggleTheme = () => { state.debug = !state.debug; $("debug-panel").classList.toggle("hidden", !state.debug); };

    $("start-btn").addEventListener("click", startCamera);
    $("stop-btn").addEventListener("click", stopCamera);
    $("download-btn").addEventListener("click", downloadFile);
    $("retry-btn").addEventListener("click", retry);
    $("video-file-input").addEventListener("change", event => { state.selectedVideo = event.target.files[0] || null; $("read-video-btn").disabled = !state.selectedVideo; });
    $("read-video-btn").addEventListener("click", () => startVideoFile(state.selectedVideo));
    $("video").addEventListener("ended", () => { if (state.sourceMode === "file") { state.active = false; cancelAnimationFrame(state.animationFrame); updateStatus(state.decoder?.complete ? "Vídeo lido" : "Vídeo terminou", state.decoder?.complete ? "success" : "error"); } });
    updateProgress();
})();
