/* Receiver for the calibrated VEF-3 symbol-tile Fountain stream. */
(() => {
    "use strict";
    const P = window.VEFProtocol;
    const F = window.VEFFountain;
    const T = window.VEFTiles;
    const $ = id => document.getElementById(id);
    const state = {
        active: false, stream: null, raf: 0, processing: false,
        frameCount: 0, validFrames: 0, framesSinceFps: 0, lastFpsAt: 0,
        geometry: null, calibrator: null, decoder: null, transfer: null,
        fileData: null, fileName: "received_file", complete: false
    };

    function setStatus(text, error = false) {
        const el = $("status");
        el.textContent = text;
        el.classList.toggle("error", error);
    }

    function message(text, kind = "info") {
        const el = $("message");
        el.textContent = text;
        el.hidden = false;
        el.dataset.kind = kind;
    }

    function clearTransfer() {
        state.decoder = null; state.transfer = null; state.fileData = null;
        state.fileName = "received_file"; state.complete = false; state.validFrames = 0;
        $("download-btn").hidden = true; $("retry-btn").hidden = true;
        updateProgress();
    }

    function updateProgress() {
        const solved = state.decoder ? state.decoder.solvedCount : 0;
        const total = state.decoder ? state.decoder.k : 0;
        const frames = state.decoder ? state.decoder.framesNew : 0;
        const percent = total ? Math.min(100, Math.round(solved / total * 100)) : 0;
        $("progress-label").textContent = `${percent}% · ${solved}/${total || 0} blocos`;
        $("eta-label").textContent = `${frames} frames recolhidos`;
        $("progress-bar").style.width = `${percent}%`;
        $("progress").setAttribute("aria-valuenow", String(percent));
        $("packets-count").textContent = `${frames} / ${total || 0}`;
    }

    function solveHomography(source, target) {
        const matrix = [];
        for (let i = 0; i < 4; i++) {
            const [x, y] = source[i], [u, v] = target[i];
            matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
            matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
        }
        for (let col = 0; col < 8; col++) {
            let pivot = col;
            for (let row = col + 1; row < 8; row++) if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
            if (Math.abs(matrix[pivot][col]) < 1e-9) return null;
            [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
            const divisor = matrix[col][col];
            for (let j = col; j < 9; j++) matrix[col][j] /= divisor;
            for (let row = 0; row < 8; row++) if (row !== col) {
                const factor = matrix[row][col];
                for (let j = col; j < 9; j++) matrix[row][j] -= factor * matrix[col][j];
            }
        }
        return matrix.map(row => row[8]).concat(1);
    }

    function project(h, x, y) {
        const d = h[6] * x + h[7] * y + 1;
        return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d];
    }

    function matches(data, x, y, colour) {
        const index = (y * data.width + x) * 4;
        return Math.abs(data.data[index] - colour[0]) + Math.abs(data.data[index + 1] - colour[1]) + Math.abs(data.data[index + 2] - colour[2]) < 180;
    }

    function findMarker(data, colour, quadrant) {
        const step = 3, cols = Math.ceil(data.width / step), rows = Math.ceil(data.height / step);
        const seen = new Uint8Array(cols * rows);
        const inQuad = (x, y) => quadrant === "TL" ? x < data.width / 2 && y < data.height / 2 : quadrant === "TR" ? x >= data.width / 2 && y < data.height / 2 : quadrant === "BL" ? x < data.width / 2 && y >= data.height / 2 : x >= data.width / 2 && y >= data.height / 2;
        const good = (gx, gy) => { const x=Math.min(data.width-1,gx*step), y=Math.min(data.height-1,gy*step); return inQuad(x,y) && matches(data,x,y,colour); };
        let best = null;
        for (let gy=0;gy<rows;gy++) for(let gx=0;gx<cols;gx++) {
            const mark=gy*cols+gx; if(seen[mark]||!good(gx,gy))continue;
            const queue=[[gx,gy]]; seen[mark]=1; let count=0,minX=Infinity,minY=Infinity,maxX=0,maxY=0;
            while(queue.length){const [xg,yg]=queue.pop();const x=xg*step,y=yg*step;count++;minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);for(const [nx,ny] of [[xg-1,yg],[xg+1,yg],[xg,yg-1],[xg,yg+1]]){if(nx<0||ny<0||nx>=cols||ny>=rows)continue;const ni=ny*cols+nx;if(!seen[ni]&&good(nx,ny)){seen[ni]=1;queue.push([nx,ny]);}}}
            if(!best||count>best.count)best={count,minX,minY,maxX,maxY};
        }
        if(!best||best.count<12)return null;
        return quadrant==="TL"?[best.minX,best.minY]:quadrant==="TR"?[best.maxX,best.minY]:quadrant==="BL"?[best.minX,best.maxY]:[best.maxX,best.maxY];
    }

    function detectGeometry(data) {
        const observed=[findMarker(data,[0,255,0],"TL"),findMarker(data,[255,72,72],"TR"),findMarker(data,[0,0,255],"BL"),findMarker(data,[255,255,0],"BR")];
        // Marker red/green are drawn as pure primary colours, but the tile
        // palette has softened versions; retry with the primary targets.
        if (!observed[1]) observed[1]=findMarker(data,[255,0,0],"TR");
        if (!observed[2]) observed[2]=findMarker(data,[0,0,255],"BL");
        if (!observed[3]) observed[3]=findMarker(data,[255,255,0],"BR");
        if(observed.some(point=>!point))return null;
        const ideal=[P.MARKER_ANCHORS.TL,P.MARKER_ANCHORS.TR,P.MARKER_ANCHORS.BL,P.MARKER_ANCHORS.BR];
        const inverse=solveHomography(ideal,observed);
        return inverse?{inverse}:null;
    }

    function mapIdeal(data, geometry, x, y) {
        return geometry ? project(geometry.inverse,x,y) : [x/P.FRAME_WIDTH*data.width,y/P.FRAME_HEIGHT*data.height];
    }

    function samplePoint(data, geometry, x, y, radius=1) {
        const [cx,cy]=mapIdeal(data,geometry,x,y);let r=0,g=0,b=0,n=0;
        for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++){const px=Math.max(0,Math.min(data.width-1,Math.round(cx+dx))),py=Math.max(0,Math.min(data.height-1,Math.round(cy+dy))),i=(py*data.width+px)*4;r+=data.data[i];g+=data.data[i+1];b+=data.data[i+2];n++;}
        return [Math.round(r/n),Math.round(g/n),Math.round(b/n)];
    }

    function tileSamples(data,geometry,col,row) {
        const samples=[];
        for(let cell=0;cell<16;cell++) samples.push(samplePoint(data,geometry,P.GRID_OFFSET_X+col*8+(cell%4+.5)*2,P.GRID_OFFSET_Y+row*8+(Math.floor(cell/4)+.5)*2,1));
        return samples;
    }

    function readHeader(data,geometry) {
        const raw=new T.ColourCalibrator(), values=[];
        for(const row of P.METADATA_ROWS)for(let col=0;col<P.FRAME_COLS;col++)values.push(T.decodeSamples(tileSamples(data,geometry,col,row),raw).value);
        return P.parseHeader(P.valuesToBytes(values,P.HEADER_BYTES));
    }

    function calibrateFull(data,geometry) {
        const calibrator=new T.ColourCalibrator(), [startCol,startRow]=P.CALIBRATION_GRID;
        for(let value=0;value<64;value++){const extracted=T.extract(tileSamples(data,geometry,startCol+value%8,startRow+Math.floor(value/8)));calibrator.add(extracted.colour,value&3);}
        calibrator.finish(); state.calibrator=calibrator; $("calibration").textContent="Calibrado"; setStatus("Calibração recebida");
    }

    function calibrateReferences(data,geometry) {
        if(!state.calibrator)state.calibrator=new T.ColourCalibrator(); const cells=[...P.REFERENCE_CELLS];
        for(let i=0;i<cells.length;i++){const cell=cells[i];state.calibrator.add(T.extract(tileSamples(data,geometry,cell%P.FRAME_COLS,Math.floor(cell/P.FRAME_COLS))).colour,P.REFERENCE_VALUES[i]&3);} state.calibrator.finish();
    }

    function createTransfer(header) {
        state.decoder=new F.FountainDecoder(header.k,header.blockLen,header.totalLen); state.transfer=header; state.complete=false; state.fileData=null; state.fileName=header.filename; $("download-btn").hidden=true; updateProgress();
    }

    function finishTransfer() {
        if(!state.decoder||!state.decoder.complete||!state.transfer||state.complete)return;
        const result=state.decoder.assemble();if(!result)return;
        if(state.transfer.fileCrc32&&P.crc32(result)!==state.transfer.fileCrc32){message("A verificação falhou; continua a receber para tentar outro conjunto de frames.","error");state.decoder=new F.FountainDecoder(state.transfer.k,state.transfer.blockLen,state.transfer.totalLen);return;}
        state.complete=true;state.fileData=result;state.fileName=state.transfer.filename||"received_file";$("progress-bar").style.width="100%";$("progress-label").textContent="100% · ficheiro pronto";$("download-btn").hidden=false;$("retry-btn").hidden=false;setStatus("Transferência completa");message(`Recebido: ${state.fileName}`,"success");
    }

    function processFrame(data) {
        if(!state.geometry||state.frameCount%12===0)state.geometry=detectGeometry(data)||state.geometry;
        const header=readHeader(data,state.geometry);if(!header)return;
        if(header.type==="calibration"){calibrateFull(data,state.geometry);return;}
        if(header.k<1||header.k>65536||header.blockLen<1||header.blockLen>P.PAYLOAD_BYTES||!header.indices.length)return;
        if(!state.transfer||state.transfer.sessionId!==header.sessionId||state.transfer.k!==header.k)createTransfer(header);
        if(header.seq%30===0)calibrateReferences(data,state.geometry);
        if(!state.calibrator)state.calibrator=new T.ColourCalibrator();
        const values=[];let uncertain=0;
        for(const [col,row] of P.DATA_POSITIONS){const decoded=T.decodeSamples(tileSamples(data,state.geometry,col,row),state.calibrator);if(!decoded.valid)uncertain++;values.push(decoded.value);}
        if(uncertain>80)return;
        state.decoder.addPacket(header.seq,header.indices,P.valuesToBytes(values,header.blockLen));state.validFrames++;updateProgress();finishTransfer();
    }

    function loop(now){if(!state.active)return;state.frameCount++;state.framesSinceFps++;if(!state.lastFpsAt)state.lastFpsAt=now;if(now-state.lastFpsAt>=1000){$("fps").textContent=String(state.framesSinceFps);state.framesSinceFps=0;state.lastFpsAt=now;$("frames-count").textContent=String(state.frameCount);}const video=$("video");if(video.readyState>=2&&!state.processing){state.processing=true;try{const canvas=$("canvas");if(canvas.width!==video.videoWidth||canvas.height!==video.videoHeight){canvas.width=video.videoWidth;canvas.height=video.videoHeight;$("canvas").getContext("2d",{willReadFrequently:true});}const ctx=$("canvas").getContext("2d");ctx.drawImage(video,0,0,canvas.width,canvas.height);processFrame(ctx.getImageData(0,0,canvas.width,canvas.height));}catch(error){message(`Erro a ler frame: ${error.message}`,"error");}finally{state.processing=false;}}state.raf=requestAnimationFrame(loop);}

    async function startCamera(){if(!navigator.mediaDevices?.getUserMedia){message("A câmara precisa de HTTPS e permissão.","error");return;}try{state.stream=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:{ideal:"environment"},width:{ideal:Number($("cfg-width").value)},height:{ideal:800},frameRate:{ideal:Number($("cfg-capfps").value)}}});const video=$("video");video.srcObject=state.stream;await video.play();state.active=true;state.frameCount=0;state.framesSinceFps=0;state.lastFpsAt=0;state.geometry=null;state.calibrator=null;clearTransfer();$("preview").hidden=false;$("diagnostics").hidden=false;$("start-btn").hidden=true;$("stop-btn").hidden=false;const settings=state.stream.getVideoTracks()[0].getSettings();$("camera-actual").textContent=`${settings.width||"?"}×${settings.height||"?"} @ ${Math.round(settings.frameRate||0)} fps`;setStatus("Câmara ativa · aponta para os marcadores L");state.raf=requestAnimationFrame(loop);}catch(error){message(`Não foi possível abrir a câmara: ${error.message}`,"error");setStatus("Erro na câmara",true);}}

    function stopCamera(){if(state.stream)state.stream.getTracks().forEach(track=>track.stop());state.stream=null;state.active=false;cancelAnimationFrame(state.raf);$("video").srcObject=null;$("preview").hidden=true;$("diagnostics").hidden=true;$("start-btn").hidden=false;$("stop-btn").hidden=true;setStatus("Parado");}
    function downloadFile(){if(!state.fileData)return;const url=URL.createObjectURL(new Blob([state.fileData],{type:"application/octet-stream"}));const link=document.createElement("a");link.href=url;link.download=state.fileName;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
    function retry(){clearTransfer();setStatus(state.active?"A procurar outro stream":"Pronto para ler um stream");}
    $("start-btn").addEventListener("click",startCamera);$("stop-btn").addEventListener("click",stopCamera);$("download-btn").addEventListener("click",downloadFile);$("retry-btn").addEventListener("click",retry);updateProgress();
})();
