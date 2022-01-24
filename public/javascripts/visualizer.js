class Visualizer {

	#drawVisual = null ;
	#canvas ;
	#analyser ;

	constructor(canvas) {
		let WIDTH = canvas.width;
		let HEIGHT = canvas.height;
		let canvasCtx = canvas.getContext("2d");

		canvasCtx.fillStyle = 'rgb(0, 0, 0)';
		canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);

		this.#canvas = canvas ;
	}

	start(analyser) {
		this.#analyser = analyser ;

		if (this.#drawVisual == null) {
			this._draw();
		}
	}
	
	stop() {
		if (this.#drawVisual != null) {
			window.cancelAnimationFrame(this.#drawVisual);
			this.#drawVisual = null ;
		}
	}

	_draw() {
		this.#drawVisual = requestAnimationFrame(() => {
			this._draw();
		});

		let analyser = this.#analyser ;
		let canvas = this.#canvas ;
		let canvasCtx = canvas.getContext("2d");

		let WIDTH = canvas.width;
		let HEIGHT = canvas.height;

		canvasCtx.clearRect(0, 0, WIDTH, HEIGHT) ;

		var bufferLengthAlt = 256 ;
		analyser.fftSize = bufferLengthAlt;
		var dataArrayAlt = new Uint8Array(bufferLengthAlt);

		canvasCtx.clearRect(0, 0, WIDTH, HEIGHT);

		analyser.getByteFrequencyData(dataArrayAlt);

		canvasCtx.fillStyle = 'rgb(0, 0, 0)';
		canvasCtx.fillRect(0, 0, WIDTH, HEIGHT);

		var barWidth = (WIDTH / bufferLengthAlt) * 2.5;
		var barHeight;
		var x = 0;

		for(var i = 0; i < bufferLengthAlt; i++) {
			barHeight = dataArrayAlt[i];

			canvasCtx.fillStyle = 'rgb(50,' + (barHeight+100) + ',50)';
			canvasCtx.fillRect(x,HEIGHT-barHeight/2,barWidth,barHeight/2);

			x += barWidth + 1;
		}
	};
}