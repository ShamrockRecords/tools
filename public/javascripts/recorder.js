class Recorder {

	#context = null ;
	#stream = null ;
	#source = null ;
	#proccessor = null ;

	analyser ;
	onAudioProcess = null ;

	constructor() {
		this.#context = new AudioContext() ;
		this.#proccessor = this.#context.createScriptProcessor(0, 1, 1);
		this.#proccessor.onaudioprocess = (e) => {
			if (this.onAudioProcess != null) {
				this.onAudioProcess(e) ;
			}
		} ;

		this.analyser = this.#context.createAnalyser();
		this.#context.suspend() ;
	}

	async resume(deviceId) {
		console.log(`resume : ${deviceId}`) ;

		this.#stream = await navigator.mediaDevices.getUserMedia ({audio: { deviceId: deviceId }}) ;
		this.#source = this.#context.createMediaStreamSource(this.#stream) ;

		this.#source.connect(this.analyser);
		this.analyser.connect(this.#proccessor);
		this.#proccessor.connect(this.#context.destination);

		this.#context.resume() ;
	}

	isRunning() {
		if (this.#stream != null) {
			return true ;
		} else {
			return false ;
		}
	}

	pause() {
		console.log(`pause`) ;

		if (this.#stream != null) {
			let tracks = this.#stream.getTracks();

			for (var i = 0; i < tracks.length; i++) {
				tracks[i].stop();
			}

			this.#stream = null ;
			this.#source.disconnect() ;
			this.#proccessor.disconnect() ;

			this.#context.suspend() ;
		}
	}

	static async currentDevices() {
		let devices = [] ;

		if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
			let stream = await navigator.mediaDevices.getUserMedia({audio: true}) ;

			if (stream != null) {
				devices = await navigator.mediaDevices.enumerateDevices() ;
			}
		}
		
		return devices ;
	}
}