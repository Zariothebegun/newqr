/* Systematic LT-style Fountain Codes shared by sender and receiver. */
(function (root) {
    "use strict";

    function mix32(value) {
        value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
        value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
        return (value ^ (value >>> 15)) >>> 0;
    }

    function randomFor(sessionId, sequence) {
        let state = mix32((sessionId ^ Math.imul(sequence + 1, 0x9e3779b1)) >>> 0) || 0x6d2b79f5;
        return () => {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0);
        };
    }

    function chooseIndices(k, sessionId, sequence) {
        if (k <= 1) return [0];
        // Systematic first pass: every source block has a degree-one packet.
        // This makes short files deterministic and gives the peeling decoder a
        // strong set of seeds before the redundant equations arrive.
        if (sequence < k) return [sequence];

        const random = randomFor(sessionId, sequence);
        const degree = Math.min(k, 3 + (random() % 3));
        const selected = new Set();
        while (selected.size < degree) selected.add(random() % k);
        return [...selected].sort((a, b) => a - b);
    }

    class FountainEncoder {
        constructor(data, blockLength, sessionId) {
            this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
            this.blockLength = blockLength;
            this.sessionId = sessionId >>> 0;
            this.k = Math.max(1, Math.ceil(this.data.length / blockLength));
            this.blocks = [];
            for (let index = 0; index < this.k; index++) {
                const block = new Uint8Array(blockLength);
                block.set(this.data.slice(index * blockLength, (index + 1) * blockLength));
                this.blocks.push(block);
            }
        }

        packet(sequence) {
            const indices = chooseIndices(this.k, this.sessionId, sequence);
            const output = new Uint8Array(this.blockLength);
            for (const index of indices) {
                const block = this.blocks[index];
                for (let offset = 0; offset < output.length; offset++) output[offset] ^= block[offset];
            }
            return { indices, data: output };
        }
    }

    class FountainDecoder {
        constructor(k, blockLength, totalLength) {
            this.k = k;
            this.blockLength = blockLength;
            this.totalLength = totalLength;
            this.solved = new Array(k).fill(null);
            this.pending = [];
            this.seen = new Set();
            this.solvedCount = 0;
            this.framesNew = 0;
            this.framesDuplicate = 0;
        }

        get complete() { return this.solvedCount >= this.k; }

        addPacket(sequence, indicesLike, payloadLike) {
            if (this.seen.has(sequence)) {
                this.framesDuplicate++;
                return;
            }
            this.seen.add(sequence);
            this.framesNew++;
            if (this.complete) return;

            const indices = [...new Set(indicesLike)].filter(index => index >= 0 && index < this.k);
            const payload = new Uint8Array(this.blockLength);
            payload.set(payloadLike.slice(0, this.blockLength));
            this._eliminate(indices, payload);
            if (!indices.length) return;
            if (indices.length === 1) {
                this._resolve(indices[0], payload);
            } else {
                this.pending.push({ indices, payload });
                this._peel();
            }
        }

        _eliminate(indices, payload) {
            for (let position = indices.length - 1; position >= 0; position--) {
                const solved = this.solved[indices[position]];
                if (!solved) continue;
                for (let offset = 0; offset < payload.length; offset++) payload[offset] ^= solved[offset];
                indices.splice(position, 1);
            }
        }

        _resolve(index, payload) {
            if (this.solved[index]) return;
            this.solved[index] = payload;
            this.solvedCount++;
            this._peel();
        }

        _peel() {
            let changed = true;
            while (changed) {
                changed = false;
                for (let position = this.pending.length - 1; position >= 0; position--) {
                    const equation = this.pending[position];
                    this._eliminate(equation.indices, equation.payload);
                    if (!equation.indices.length) {
                        this.pending.splice(position, 1);
                    } else if (equation.indices.length === 1) {
                        const index = equation.indices[0];
                        this.pending.splice(position, 1);
                        if (!this.solved[index]) {
                            this.solved[index] = equation.payload;
                            this.solvedCount++;
                            changed = true;
                        }
                    }
                }
            }
        }

        assemble() {
            if (!this.complete) return null;
            const output = new Uint8Array(this.totalLength);
            let offset = 0;
            for (const block of this.solved) {
                if (!block || offset >= output.length) break;
                const length = Math.min(block.length, output.length - offset);
                output.set(block.slice(0, length), offset);
                offset += length;
            }
            return output;
        }
    }

    root.VEFFountain = { FountainEncoder, FountainDecoder, chooseIndices };
})(window);
