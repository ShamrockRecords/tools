function timeToSec(time) {
	var elements = time.split(':') ;
	var millisec = 0 ;

	millisec += Number(elements[0] * 60 * 60) ;
	millisec += Number(elements[1] * 60) ;
	millisec += Number(elements[2]) ;

	return millisec ;
}

function secToTime(millisec, separator) {
	if (millisec < 0) {
		return "" ;
	}

	millisec *= 1000 ;

	millisec = Math.floor(millisec) ;
	
	var ms = millisec % 1000 ;
	var totalSeconds = Math.floor(millisec / 1000) ;
	var s = totalSeconds % 60 ;
	var m = Math.floor(totalSeconds / 60) % 60 ;
	var h = Math.floor(totalSeconds / (60 * 60)) ;

	return  ('00' + h).slice(-2) + ":" + ('00' + m).slice(-2) + ":" + ('00' + s).slice(-2) + separator + ('000' + ms).slice(-3) ;
}

function ParseToDate(dateStriing) {
    var s = dateStriing ;
    var a = s.split(/[^0-9]/);

    if (a.length == 7) {
        return new Date (a[0],a[1]-1,a[2],a[3],a[4],a[5],a[6]).getTime();
    } else if (a.length == 6) {
        return new Date (a[0],a[1]-1,a[2],a[3],a[4],a[5],0).getTime();
    } else if (a.length == 4) {
        return new Date (0,0,0,a[0],a[1],a[2],a[3]).getTime();
    } else if (a.length == 3) {
        return new Date (0,0,0,a[0],a[1],a[2],0).getTime();
    } else {
        return null ;
    }
}

function convertToArray(fileContent) {
	fileContent = fileContent.replaceAll("\r\n", "\n") ;
	var rawLines = parseToLines(fileContent) ;

	var ignoreCamma = false ;
	var element = "" ;
	var elements = [] ;
	var lines = [] ;

	for (var i=0; i<rawLines.length; i++) {
		col = 0 ;

		var rawLine = rawLines[i] ;

		if (rawLine == "") {
			continue ;
		}
		
		if (rawLine.startsWith("#")) {
			continue ;
		}

		for (var x=0; x<rawLine.length; x++) {
			var c = rawLine[x] ;

			if (c == '"') {
				ignoreCamma = !ignoreCamma ;
			} else if ((c == ',' || c == '\t') && !ignoreCamma) {
				elements.push(element) ;
				element = "" ;
			} else {
				element += c ;
			}
		}

		if (!ignoreCamma) {
			elements.push(element) ;
			lines.push(elements) ;

			element = "" ;
			elements = [] ;
		} else {
			element += '\n' ;
		}
	}

	return lines ;
}

function parseToLines(contents) {
	var lines = new Array() ;
	var ignoreCamma = false ;
	var line = "" ;

	for (var x=0; x<contents.length; x++) {
		var c = contents[x] ;

		if (c == '"') {
			ignoreCamma = !ignoreCamma ;
			line += c ;
		} else if (c == '\n' && !ignoreCamma) {
			lines.push(line) ;
			line = "" ;
		} else {
			line += c ;
		}
	}

	if (line != "") {
		lines.push(line) ;
	}

	return lines ;
}

function saveAsFile(contents, fileName) { 
	if (contents == "") {
		return ;
	}

	var blob = new Blob([contents], {type: "text/plain"}); 

	if(window.navigator.msSaveBlob) {
		window.navigator.msSaveBlob(blob, fileName);
	} else {
		var a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.target = '_blank';
		a.download = fileName;
		a.click();
	}
}

function loadSrtFile(contents) {
	data = []

	contents = contents.replaceAll("\r\n", "\n") ;

	contents.replace(
		/\d+\n^(\d+:.*)\n((?:(?!\d+:\d+:\d+).*\n*)+)\n$/gm,
		(string, time, text) => {
			if (time != "" && text != "") {
				data.push({
					time: {
					start: timeToSec(time.split(' --> ')[0].replaceAll(",", ".")),
					end: timeToSec(time.split(' --> ')[1].replaceAll(",", "."))
					},
					text: text.trim()
				}) ;
			}
		}
	) ;

	return data ;
}

function saveAppData(_lines, _details, _appDataProperties) {
	let fileName = $("#appDataFileName").val() ;
	
	if (fileName == undefined || fileName == null || fileName == "") {
		alert("ファイル名を入力してください。") ;
		return ;
	}

	let appData = {} ;

	commitAppData() ;
	
	if ($("#videoURL").val() != undefined) {
		appData["videoURL"] = $("#videoURL").val() ;
	}

	appData["lines"] = _lines ;
	appData["details"] = _details ;
	appData["offsetTimeLength"] = $("#offsetTimeLength").val() ;
	appData["appDataFileName"] = $("#appDataFileName").val() ;
	
	let shortcutWords = {} ;

	shortcutWords["shortcutWord1"] = $("#shortcutWord1").val() ;
	shortcutWords["shortcutWord2"] = $("#shortcutWord2").val() ;
	shortcutWords["shortcutWord3"] = $("#shortcutWord3").val() ;
	shortcutWords["shortcutWord4"] = $("#shortcutWord4").val() ;
	shortcutWords["shortcutWord5"] = $("#shortcutWord5").val() ;
	shortcutWords["shortcutWord6"] = $("#shortcutWord6").val() ;

	appData["shortcutWords"] = shortcutWords ;

	appData["properties"] = _appDataProperties ;

	saveAsFile(JSON.stringify(appData) , fileName) ;
}

async function appendReading(contents, language) {
	const headers = {
		'Accept': 'application/json',
		'Content-Type': 'application/json'
	};

	const param = {
		method: "POST",
		headers: headers,
		body: JSON.stringify({"contents" : contents, "language" : language}),
	}

	contents = await fetch("/jimakueditor/appendReading", param).then(response => response.json()) ;

	return contents ;
}

function formatReadingForSrt(text) {
	let resultText = "" ;
	let IsEnteredBracket = false ;

	for (let i=0; i<text.length; i++) {
		let c = text[i] ;

		if (c == "[") {
			IsEnteredBracket = true ;
		} else if (c == "]") {
			IsEnteredBracket = false ;
			resultText += "）" ;
		} else if (IsEnteredBracket && c == "|") {
			resultText += "（" ;
		} else {
			resultText += c ;
		}
	}

	return resultText ;
}

function formatReadingForSrv(text) {
	let resultText = "" ;
	let IsEnteredBracket = false ;
	let lineCount = 0 ;

	for (let i=0; i<text.length; i++) {
		let c = text[i] ;

		if (c == "[") {
			resultText += '<s p="2">' ;
			IsEnteredBracket = true ;
		} else if (c == "]") {
			resultText += '</s><s p="3">)</s>' ;
			IsEnteredBracket = false ;
		} else if (IsEnteredBracket && c == "|") {
			if (lineCount < 1) {
				resultText += '</s><s p="3">(</s><s p="4">' ;
			} else {
				resultText += '</s><s p="3">(</s><s p="5">' ;
			}
		} else if (c == "\n") {
			lineCount++ ;
			resultText += c ;
		} else {
			if (IsEnteredBracket) {
				resultText += c ;
			} else {
				resultText += '<s p="1">' + c + '</s>' ;
			}
		}
	}

	return resultText ;
}

function formatReadingForHtml(text) {
	let resultText = "" ;
	let IsEnteredBracket = false ;

	for (let i=0; i<text.length; i++) {
		let c = text[i] ;

		if (c == "[") {
			IsEnteredBracket = true ;
			resultText += '<ruby>' ;
		} else if (c == "]") {
			IsEnteredBracket = false ;
			resultText += '</rt></ruby>' ;
		} else if (IsEnteredBracket && c == "|") {
			resultText += '<rt>' ;
		} else {
			resultText += c ;
		}
	}

	return resultText ;
}