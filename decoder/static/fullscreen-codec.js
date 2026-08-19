/* ULTRA DENSE: Full screen (1080×1920) pixel-packed colour grid.
 * 
 * - 64 colours = 6 bits/pixel
 * - ~778 KB per frame in theory
 * - 30 fps = 23 MB/s theoretical; 1-2 MB/s realistic with errors
 * 
 * No wasm, no complex homography. Just: render full screen,
 * decode via colour classifier (eventually ML-based).
 */
(function (root) {
    "use strict";

    const PALETTE_16 = (() => {
        const p = [[0,0,0],[255,255,255]];
        for (let i = 0; i < 14; i++) {
            const h = (i/14)*300;
            const c = 255*0.9, x = c*(1-Math.abs(((h/60)%2)-1)), m = 255*0.1;
            let r,g,b;
            if(h<60)[r,g,b]=[c,x,0]; else if(h<120)[r,g,b]=[x,c,0];
            else if(h<180)[r,g,b]=[0,c,x]; else if(h<240)[r,g,b]=[0,x,c];
            else if(h<300)[r,g,b]=[x,0,c]; else [r,g,b]=[c,0,x];
            p.push([Math.round(r+m),Math.round(g+m),Math.round(b+m)]);
        }
        return p;
    })();
    
    const PALETTE_64 = (() => {
        const p = [];
        // Generate 64 distinct colours via HSV sweep + brightness variation
        for (let b = 0; b < 4; b++) { // brightness: 0.3, 0.5, 0.7, 0.9
            const v = 0.3 + b*0.15;
            for (let h = 0; h < 16; h++) { // 16 hues per brightness
                const hue = (h/16)*360;
                const s = 0.8 + Math.random()*0.2;
                const c = v*s, x = c*(1-Math.abs(((hue/60)%2)-1)), m = v-c;
                let r,g,b_val;
                if(hue<60)[r,g,b_val]=[c,x,0]; else if(hue<120)[r,g,b_val]=[x,c,0];
                else if(hue<180)[r,g,b_val]=[0,c,x]; else if(hue<240)[r,g,b_val]=[0,x,c];
                else if(hue<300)[r,g,b_val]=[x,0,c]; else [r,g,b_val]=[c,0,x];
                p.push([Math.round((r+m)*255),Math.round((g+m)*255),Math.round((b_val+m)*255)]);
            }
        }
        return p;
    })();

    function colorDist2(a,b){ const dr=a[0]-b[0], dg=a[1]-b[1], db=a[2]-b[2]; return dr*dr+dg*dg+db*db; }
    function nearestIndex(rgb, palette) {
        let best=0, bestDist=Infinity;
        for(let i=0;i<palette.length;i++) { const d = colorDist2(rgb,palette[i]); if(d<bestDist){ bestDist=d; best=i; } }
        return best;
    }

    function encodeFullScreen(bytes, width=1080, height=1920, colorCount=16) {
        const palette = colorCount===16 ? PALETTE_16 : PALETTE_64;
        const bitsPerPixel = Math.log2(palette.length);
        // Prepend 4-byte length (LE) so decoder knows where payload ends
        const fullData = new Uint8Array(4 + bytes.length);
        new DataView(fullData.buffer).setUint32(0, bytes.length, true);
        fullData.set(bytes, 4);
        
        const pixels = new Uint8ClampedArray(width*height*4).fill(255);
        let bitPos = 0;
        const totalBits = fullData.length*8;
        
        for(let y=0; y<height; y++) {
            for(let x=0; x<width; x++) {
                let v = 0;
                for(let b=0; b<bitsPerPixel; b++) {
                    const byteIdx = bitPos>>3, bitIdx = 7-(bitPos&7);
                    const bit = bitPos < totalBits ? (fullData[byteIdx]>>bitIdx)&1 : 0;
                    v = (v<<1)|bit;
                    bitPos++;
                }
                const rgb = palette[v%palette.length];
                const o = (y*width+x)*4;
                pixels[o]=rgb[0]; pixels[o+1]=rgb[1]; pixels[o+2]=rgb[2]; pixels[o+3]=255;
            }
        }
        return { width, height, pixels };
    }

    function decodeFullScreen(imageData, width, height, colorCount=16) {
        const palette = colorCount===16 ? PALETTE_16 : PALETTE_64;
        const bitsPerPixel = Math.log2(palette.length);
        const { data } = imageData;
        const bits = [];
        
        for(let y=0; y<Math.min(height, imageData.height); y++) {
            for(let x=0; x<Math.min(width, imageData.width); x++) {
                const o = (y*imageData.width+x)*4;
                const rgb = [data[o], data[o+1], data[o+2]];
                const idx = nearestIndex(rgb, palette);
                for(let b=bitsPerPixel-1; b>=0; b--) bits.push((idx>>b)&1);
            }
        }
        
        // Read length from first 32 bits (little-endian)
        let len = 0;
        for(let i=0; i<32; i++) len |= bits[i]<<i;
        
        const byteLen = Math.min(len, Math.floor((bits.length-32)/8));
        const out = new Uint8Array(byteLen);
        for(let i=0; i<byteLen; i++) {
            let v=0;
            for(let b=0; b<8; b++) v=(v<<1)|bits[32 + i*8 + b];
            out[i]=v;
        }
        return out;
    }

    root.VEFFullScreenCodec = { PALETTE_16, PALETTE_64, encodeFullScreen, decodeFullScreen, nearestIndex };
})(typeof window !== "undefined" ? window : globalThis);
