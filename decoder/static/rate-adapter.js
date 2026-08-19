/* Dynamic rate adaptation: adjust blockLen based on frame decode success.
 *
 * Feedback loop: if >90% of frames decode OK, increase blockLen (more KB/packet).
 * If <60%, decrease (more packets/sec but smaller). Smooth exponential ramp.
 */
(function (root) {
    "use strict";

    class RateAdapter {
        constructor(startBlockLen, minBlockLen = 256, maxBlockLen = 8000) {
            this.blockLen = startBlockLen;
            this.minBlockLen = minBlockLen;
            this.maxBlockLen = maxBlockLen;
            this.successCount = 0;
            this.failCount = 0;
            this.window = 30; // moving window: adapt every N frames
            this.lastAdapt = 0;
        }
        recordSuccess() {
            this.successCount++;
            this.tryAdapt();
        }
        recordFailure() {
            this.failCount++;
            this.tryAdapt();
        }
        tryAdapt() {
            const total = this.successCount + this.failCount;
            if (total < this.window) return;
            const successRate = this.successCount / total;
            let newBlockLen = this.blockLen;
            if (successRate > 0.90) {
                // Very good: increase by 15%
                newBlockLen = Math.floor(this.blockLen * 1.15);
                if (root.VEF_DEBUG) console.log(`[RateAdapter] success rate ${(successRate * 100).toFixed(0)}% -> increase blockLen ${this.blockLen} -> ${newBlockLen}`);
            } else if (successRate < 0.60) {
                // Poor: decrease by 20%
                newBlockLen = Math.floor(this.blockLen * 0.80);
                if (root.VEF_DEBUG) console.log(`[RateAdapter] success rate ${(successRate * 100).toFixed(0)}% -> decrease blockLen ${this.blockLen} -> ${newBlockLen}`);
            }
            newBlockLen = Math.max(this.minBlockLen, Math.min(this.maxBlockLen, newBlockLen));
            if (newBlockLen !== this.blockLen) {
                this.blockLen = newBlockLen;
                this.lastAdapt = Date.now();
            }
            this.successCount = 0;
            this.failCount = 0;
        }
    }
    root.VEFRateAdapter = RateAdapter;
})(typeof window !== "undefined" ? window : globalThis);
