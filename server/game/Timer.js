class Timer {
    constructor(duration, onTick, onEnd) {
        this.duration = duration;
        this.remaining = duration;
        this.onTick = onTick;
        this.onEnd = onEnd;
        this.intervalId = null;
        this.isRunning = false;
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;
        this.remaining = this.duration;

        this.intervalId = setInterval(() => {
            this.remaining--;
            if (this.onTick) {
                this.onTick(this.remaining);
            }
            if (this.remaining <= 0) {
                this.stop();
                if (this.onEnd) {
                    this.onEnd();
                }
            }
        }, 1000);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        this.isRunning = false;
    }

    getRemaining() {
        return this.remaining;
    }

    addTime(seconds) {
        this.remaining += seconds;
    }
}

module.exports = Timer;
