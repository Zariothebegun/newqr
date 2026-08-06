/* Camera receiver for the shared VEF-3 frame protocol. */
(() => {
    "use strict";

    const P = window.VEFProtocol;
    const $ = id => document.getElementById(id);
    const state = {
        cameraActive: false,
        stream: null,
        sourceUrl: null,
        sourceMode: null,
        animationFrame: null,
        canvasContext: null,
        frameCount: 0,
        validFrames: 0,
        lastFpsAt: 0,
        framesSinceFps: 0,
        fps: 0,
        lastWidth: 0,
        lastHeight: 0,
        calibrator: null,
        transfer: null,
        fileData: null,
        fileName: "received_file",
        selectedVideo: null,
        debug: false,
        processing: false
    };

    class ColorCalibrator {
        constructor() {
            this.samples = [[], [], []];
            this.centers = [P.LEVELS.slice(), P.LEVELS.slice(), P.LEVELS.slice()];
            this.ready = false;
        }

        add(measured, value) {
            const expected = P.valueToRgb(value);
            for (let channel = 0; channel < 3; channel++) {
                const level = P.LEVELS.indexOf(expected[channel]);
                if (level >= 0) this.samples[channel][level].push(measured[channel]);
            }
        }

        finish() {
            for (let channel = 0; channel < 3; channel++) {
                for (let level = 0; level < 4; level++) {
                    const values = this.samples[channel][level];
                    if (values.length) {
                        this.centers[channel][level] = values.reduce((sum, value) => sum + value, 0) / values.length;
                    }
                }
            }
            this.ready = true;
        }

        channelToLevel(value, channel) {
            let best = 0;
            let distance = Infinity;
            for (let level = 0; level < this.centers[channel].length; level++) {
                const next = Math.abs(value - this.centers[channel][level]);
                if (next < distance) {
                    best = level;
                    distance = next;
                }
            }
            return best;
        }

        decode(r, g, b) {
            const rLevel = this.channelToLevel(r, 0);
            const gLevel = this.channelToLevel(g, 1);
            const bLevel = this.channelToLevel(b, 2);
            return rLevel * 16 + gLevel * 4 + bLevel;
        }
    }

    function log(message) {
        console.log("[VEF-3 receiver]", message);
        if (state.debug && $("debug-log")) {
            $("debug-log").insertAdjacentHTML("beforeend", `<div>${new Date().toISOString().slice(11, 19)} ${message}</div>`);
        }
    }

    function showMessage(text, type = "info", persistent = false) {
        const message = $("message");
        if (!message) return;
        message.textContent = text;
        message.className = `message ${type}`;
        message.classList.remove("hidden");
        if (!persistent) window.setTimeout(() => message.classList.add("hidden"), 3500);
    }

    function updateStatus(text, type = "") {
        const element = $("status");
        element.textContent = text;
        element.className = `status-value ${type}`;
    }

    function sampleBlock(imageData, col, row) {
        const scaleX = imageData.width / P.FRAME_COLS;
        const scaleY = imageData.height / P.FRAME_ROWS;
        const centerX = (col + 0.5) * scaleX;
        const centerY = (row + 0.5) * scaleY;
        const radiusX = Math.max(1, Math.floor(scaleX * 0.18));
        const radiusY = Math.max(1, Math.floor(scaleY * 0.18));
        let red = 0;
        let green = 0;
        let blue = 0;
        let count = 0;

        // Sample a small center square, avoiding block edges and camera blur.
        for (let dy = -radiusY; dy <= radiusY; dy += Math.max(1, Math.floor(radiusY / 2))) {
            for (let dx = -radiusX; dx <= radiusX; dx += Math.max(1, Math.floor(radiusX / 2))) {
                const x = Math.max(0, Math.min(imageData.width - 1, Math.floor(centerX + dx)));
                const y = Math.max(0, Math.min(imageData.height - 1, Math.floor(centerY + dy)));
                const index = (y * imageData.width + x) * 4;
                red += imageData.data[index];
                green += imageData.data[index + 1];
                blue += imageData.data[index + 2];
                count++;
            }
        }
        return [Math.round(red / count), Math.round(green / count), Math.round(blue / count)];
    }

    function readValues(imageData, rows, calibrator) {
        const values = [];
        for (const row of rows) {
            for (let col = 0; col < P.FRAME_COLS; col++) {
                const [red, green, blue] = sampleBlock(imageData, col, row);
                values.push(calibrator.decode(red, green, blue));
            }
        }
        return values;
    }

    function readMetadata(imageData) {
        const raw = new ColorCalibrator();
        const values = [];
        for (let col = 0; col < P.METADATA_VALUES; col++) {
            const [red, green, blue] = sampleBlock(imageData, col, P.METADATA_ROW);
            values.push(raw.decode(red, green, blue));
        }
        return values;
    }

    function calibrate(imageData) {
        const calibrator = new ColorCalibrator();
        for (let value = 0; value < 64; value++) {
            const col = 10 + (value % 8);
            const row = 5 + Math.floor(value / 8);
            calibrator.add(sampleBlock(imageData, col, row), value);
        }
        calibrator.finish();
        state.calibrator = calibrator;
        $("calibration").textContent = "Calibrado";
        $("calibration").className = "status-value success";
        $("calibration-value").textContent = "100%";
        log("Calibração recebida");
    }

    function createTransfer(header) {
        state.transfer = {
            fileId: header.fileId,
            totalPackets: header.totalPackets,
            originalSize: header.originalSize,
            fileCrc32: header.fileCrc32,
            filename: header.filename,
            packets: new Map(),
            completed: false
        };
        state.fileData = null;
        state.fileName = header.filename;
        $("download-btn").classList.add("hidden");
        updateProgress();
    }

    function updateProgress() {
        const transfer = state.transfer;
        const received = transfer ? transfer.packets.size : 0;
        const total = transfer ? transfer.totalPackets : 0;
        const percent = total ? Math.min(100, Math.round(received / total * 100)) : 0;
        $("packets-count").textContent = `${received} / ${total || 0}`;
        $("progress-bar").style.width = `${percent}%`;
        $("progress-percent").textContent = `${percent}%`;
        $("progress-text").textContent = total ? `${received} blocos recebidos` : "Aguardando blocos…";
    }

    function clearTransfer() {
        state.transfer = null;
        state.fileData = null;
        state.fileName = "received_file";
        state.validFrames = 0;
        $("download-btn").classList.add("hidden");
        updateProgress();
    }

    function finishTransfer() {
        const transfer = state.transfer;
        if (!transfer || transfer.completed || transfer.packets.size < transfer.totalPackets) return;

        const result = new Uint8Array(transfer.originalSize);
        let offset = 0;
        for (let index = 0; index < transfer.totalPackets; index++) {
            const packet = transfer.packets.get(index);
            if (!packet) return;
            const remaining = result.length - offset;
            const chunk = packet.slice(0, Math.max(0, remaining));
            result.set(chunk, offset);
            offset += chunk.length;
        }

        if (transfer.fileCrc32 && P.crc32(result) !== transfer.fileCrc32) {
            showMessage("Os blocos chegaram, mas a verificação falhou. Continua a apontar a câmara.", "error", true);
            log("CRC32 inválido; a transferência continua aberta");
            return;
        }

        transfer.completed = true;
        state.fileData = result;
        state.fileName = transfer.filename || "received_file";
        updateStatus("Transferência completa", "success");
        $("progress-bar").style.width = "100%";
        $("progress-percent").textContent = "100%";
        $("progress-text").textContent = "Ficheiro pronto para descarregar";
        $("download-btn").classList.remove("hidden");
        showMessage(`Recebido: ${state.fileName}`, "success", true);
        log(`Ficheiro completo (${result.length} bytes)`);
    }

    function processFrame(imageData) {
        const metadataValues = readMetadata(imageData);
        const metadataBytes = P.valuesToBytes(metadataValues, P.HEADER_BYTES);
        const header = P.parseHeader(metadataBytes);

        if (header && header.type === "calibration") {
            calibrate(imageData);
            return;
        }
        if (!header || header.type !== "data") return;

        // A sender may be opened after its calibration frames. The default
        // thresholds are still valid, so decoding can start immediately.
        if (!state.calibrator) state.calibrator = new ColorCalibrator();
        if (!state.transfer || state.transfer.fileId !== header.fileId ||
            state.transfer.totalPackets !== header.totalPackets) {
            createTransfer(header);
        }

        const values = readValues(imageData, Array.from({ length: P.DATA_ROWS }, (_, i) => P.DATA_START_ROW + i), state.calibrator);
        const payload = P.valuesToBytes(values, header.payloadLength);
        if (!state.transfer.packets.has(header.packetIndex)) {
            state.transfer.packets.set(header.packetIndex, payload);
            state.validFrames++;
        }
        finishTransfer();
        updateProgress();
        $("frame-id").textContent = `Bloco: ${header.packetIndex}`;
        $("calibration-value").textContent = state.calibrator.ready ? "100%" : "—";
    }

    function processLoop(timestamp) {
        if (!state.cameraActive) return;
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
                    canvas.width = video.videoWidth;
                    canvas.height = video.videoHeight;
                    state.canvasContext = canvas.getContext("2d", { willReadFrequently: true });
                }
                state.canvasContext.drawImage(video, 0, 0, canvas.width, canvas.height);
                processFrame(state.canvasContext.getImageData(0, 0, canvas.width, canvas.height));
                $("frames-count").textContent = String(state.frameCount);
            } catch (error) {
                log(`Frame error: ${error.message}`);
            } finally {
                state.processing = false;
            }
        }
        state.animationFrame = requestAnimationFrame(processLoop);
    }

    function activateReadingUi(statusText) {
        state.cameraActive = true;
        state.frameCount = 0;
        state.framesSinceFps = 0;
        state.lastFpsAt = 0;
        state.calibrator = null;
        clearTransfer();
        $("video").classList.remove("hidden");
        $("start-btn").classList.add("hidden");
        $("stop-btn").classList.remove("hidden");
        $("overlay").classList.remove("hidden");
        $("frame-info").classList.remove("hidden");
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
        state.stream = null;
        state.sourceUrl = URL.createObjectURL(file);
        state.sourceMode = "file";
        video.srcObject = null;
        video.src = state.sourceUrl;
        video.controls = true;
        video.muted = true;
        video.loop = false;
        try {
            await video.play();
            activateReadingUi("A ler vídeo guardado");
            showMessage("A ler os blocos do vídeo neste dispositivo", "info");
        } catch (error) {
            log(`Video error: ${error.message}`);
            showMessage("Não foi possível reproduzir este vídeo neste navegador.", "error", true);
        }
    }

    async function startCamera() {
        state.cameraActive = false;
        cancelAnimationFrame(state.animationFrame);
        if (state.stream) state.stream.getTracks().forEach(track => track.stop());
        state.stream = null;
        if (state.sourceUrl) {
            URL.revokeObjectURL(state.sourceUrl);
            state.sourceUrl = null;
        }
        state.sourceMode = "camera";
        const previousVideo = $("video");
        previousVideo.removeAttribute("src");
        previousVideo.load();
        previousVideo.controls = false;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showMessage("Este navegador não permite acesso à câmara", "error", true);
            return;
        }
        try {
            state.stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 800 } }
            });
            const video = $("video");
            video.srcObject = state.stream;
            await video.play();
            activateReadingUi("Câmara ativa");
            showMessage("Aponta para o ecrã dos blocos", "info");
        } catch (error) {
            log(`Camera error: ${error.message}`);
            showMessage("Não foi possível abrir a câmara. Verifica as permissões.", "error", true);
            updateStatus("Erro na câmara", "error");
        }
    }

    function stopCamera() {
        if (state.stream) state.stream.getTracks().forEach(track => track.stop());
        state.stream = null;
        state.cameraActive = false;
        cancelAnimationFrame(state.animationFrame);
        if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
        state.sourceUrl = null;
        state.sourceMode = null;
        $("video").srcObject = null;
        $("video").removeAttribute("src");
        $("video").load();
        $("video").controls = false;
        $("video").classList.add("hidden");
        $("start-btn").classList.remove("hidden");
        $("stop-btn").classList.add("hidden");
        $("overlay").classList.add("hidden");
        $("frame-info").classList.add("hidden");
        $("calibration-indicator").classList.add("hidden");
        updateStatus("Parado");
    }

    function downloadFile() {
        if (!state.fileData) return;
        const url = URL.createObjectURL(new Blob([state.fileData], { type: "application/octet-stream" }));
        const link = document.createElement("a");
        link.href = url;
        link.download = state.fileName || "received_file";
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function retry() {
        clearTransfer();
        updateStatus(state.cameraActive ? "A procurar transferência" : "Pronto");
    }

    window.toggleTheme = () => {
        state.debug = !state.debug;
        $("debug-panel").classList.toggle("hidden", !state.debug);
    };

    $("start-btn").addEventListener("click", startCamera);
    $("stop-btn").addEventListener("click", stopCamera);
    $("download-btn").addEventListener("click", downloadFile);
    $("retry-btn").addEventListener("click", retry);
    $("video-file-input").addEventListener("change", event => {
        state.selectedVideo = event.target.files[0] || null;
        $("read-video-btn").disabled = !state.selectedVideo;
    });
    $("read-video-btn").addEventListener("click", () => startVideoFile(state.selectedVideo));
    $("video").addEventListener("ended", () => {
        if (state.sourceMode === "file") {
            state.cameraActive = false;
            cancelAnimationFrame(state.animationFrame);
            updateStatus(state.transfer && state.transfer.completed ? "Vídeo lido" : "Vídeo terminou", state.transfer && state.transfer.completed ? "success" : "error");
        }
    });
    updateProgress();
    log("Receiver pronto");
})();
