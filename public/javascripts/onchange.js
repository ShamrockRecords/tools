function onChangeAppDataFile(e) {
	let fileList = $('#appDataFile').get(0).files;
	let result = fileList[0];
	let reader = new FileReader() ;

	reader.readAsText(result) ;

	reader.addEventListener('load', function() {
		let content = reader.result ;
		let appData = JSON.parse(content) ;

		let videoURL = "" ;
		
		if (appData["videoURL"] != undefined) {
			videoURL = appData["videoURL"] ;
		}

		lines = appData["lines"] ;
		details= appData["details"] ;

		if (details == undefined) {
			details = [] ;

			for (let key in lines) {
				details.push({}) ;
			}
		}

		let offsetTimeLength = appData["offsetTimeLength"] ;
		let shortcutWords = appData["shortcutWords"] ;
		let appDataFileName = appData["appDataFileName"] ;

		appDataProperties = appData["properties"] == undefined ? {} : appData["properties"] ;

		if (appDataProperties["language"] == undefined) {
			appDataProperties["language"] = "ja" ;
		}

		$("#fromLanguageSelect").val(appDataProperties["language"]) ;

		$("#offsetTimeLength").val(offsetTimeLength) ;
		$("#videoURL").val(videoURL) ;
		$("#appDataFileName").val(appDataFileName) ;

		if (shortcutWords != undefined) {
			$("#shortcutWord1").val(shortcutWords["shortcutWord1"]) ;
			$("#shortcutWord2").val(shortcutWords["shortcutWord2"]) ;
			$("#shortcutWord3").val(shortcutWords["shortcutWord3"]) ;
			$("#shortcutWord4").val(shortcutWords["shortcutWord4"]) ;
			$("#shortcutWord5").val(shortcutWords["shortcutWord5"]) ;
			$("#shortcutWord6").val(shortcutWords["shortcutWord6"]) ;
		}

		if (mediaType == "youtube") {
			if (videoURL != "") {
				loadOnlineVideo(videoURL) ;
			}
		}

		$("#appDataFile").val("") ;

		prevStartTimeAdjustingIndex = -1 ;
		prevEndTimeAdjustingIndex = -1 ;
		
		updateSubtitleData() ;
	}) ;
}

function onChangeSubtitleFile(e) {
	let fileList = $('#subtitleFile').get(0).files;
	let result = fileList[0];

	let reader = new FileReader() ;
	let fileName = result.name.split('.')[0] + ".csv" ;

	reader.readAsText(result) ;

	reader.addEventListener('load', function() {
		let content = reader.result ;
		
		let srtElements = loadSrtFile(content) ;

		if (srtElements.length != 0) {
			// SRT File
			lines = [] ;
			details = [] ;
			appDataProperties = {} ;

			for (let key in srtElements) {
				let srt = srtElements[key] ;

				let line = [] ;

				line.push(srt.time.start) ;
				line.push(srt.time.end) ;
				line.push(srt.text.replaceAll("\r\n", "\n")) ;

				lines.push(line) ;
				details.push({}) ;
			}

			appDataProperties["converted"] = true ; 
		} else {
			// CSV File
			lines = convertToArray(content) ;

			details = [] ;
			appDataProperties = {} ;

			let isFirstLine = true ;

			let relativeStartTime = 0 ;

			for (let i=0; i<lines.length; i++) {
				let line = lines[i] ;
				let nextLine = []
				
				if (i < lines.length - 1) {
					nextLine = lines[i+1] ;
				}

				line[0] = ParseToDate(line[0]) / 1000 ;

				if (line[1] == "") {
					if (nextLine.length != 0) {
						line[1] = ParseToDate(nextLine[0]) / 1000 ;
					} else {
						line[1] = line[0] + 1 ;
					}
				} else {
					line[1] = ParseToDate(line[1]) / 1000 ;
				}

				if (isFirstLine) {
					relativeStartTime = line[0] ;
					isFirstLine = false ;
				}
		
				line[0] -= relativeStartTime ;
				line[1] -= relativeStartTime ;

				details.push({}) ;
			}
		}

		appDataProperties["language"] = "ja" ;

		$("#fromLanguageSelect").val(appDataProperties["language"]) ;

		updateSubtitleData() ;
	}) ;

	$("#subtitleFile").val("") ;
}

function onChangeAcpWordDataFile(e) {
	let fileList = $('#acpWordDataFile').get(0).files;
	let result = fileList[0];
	let reader = new FileReader() ;

	reader.readAsText(result) ;

	reader.addEventListener('load', function() {
		let content = reader.result ;
		
		$("#acpProfileWords").val(content) ; 
		$("#acpWordDataFileName").val(e.target.files[0].name) ;
		$("#acpWordDataFile").val("") ;

		storeSettings() ;
	}) ;
}
