async function onClickSaveAsCsvButton(e) {
	let offsetTime = Number($("#offsetTimeLength").val()) ;
	let content = "00:00:00,00:00:00,\r\n" ;

	for (let key in lines) {
		let line = lines[key] ;
		
		if (line[0] + offsetTime < 0) {
			continue ;
		}

		let textClassName = "#text" + Number(key) ;

		line[2] = $(textClassName).val() ;

		if (line[2] == "") {
			continue ;
		}

		let startTime = secToTime(line[0] + offsetTime, ".") ;
		let endTime = secToTime(line[1] + offsetTime, ".") ;
		
		content += startTime + "," + endTime ;
		
		for (let i=2; i<line.length; i++) {
			content += ",\"" + line[i] + "\"" ;
		}

		content += "\r\n" ;
	}

	let fileName = $("#appDataFileName").val() ;

	fileName = fileName.replaceAll(".captionEditor", "") ;
	fileName = fileName.replaceAll(".jimakuEditor", "") ;
	fileName += ".csv" ;

	saveAsFile(content , fileName) ;
}

async function onClickSaveAsTextButton(e) {
	let content = "" ;

	for (let key in lines) {
		let line = lines[key] ;
		
		let textClassName = "#text" + Number(key) ;

		line[2] = $(textClassName).val() ;

		if (line[2] == "") {
			continue ;
		}
		
		content += line[2] ;

		if (content.endsWith("。")) {
			content += "\r\n" ;
		}
	}

	let fileName = $("#appDataFileName").val() ;

	fileName = fileName.replaceAll(".captionEditor", "") ;
	fileName = fileName.replaceAll(".jimakuEditor", "") ;
	fileName += ".txt" ;
	
	saveAsFile(content, fileName) ;
}

async function onClickSaveAsSrtButton(e) {
	let spinner = '<div class="d-flex justify-content-center"><div class="spinner-border text-secondary my-3" role="status"><span class="visually-hidden">Loading...</span></div></div>' ;

	$("#toExportSrtSpinner").empty() ;
	$("#toExportSrtSpinner").append(spinner) ;

	let offsetTime = Number($("#offsetTimeLength").val()) ;
	let copiedLines = [] ;

	for (let key in lines) {
		let line = lines[key] ;
		
		if (line[0] + offsetTime < 0) {
			continue ;
		}

		let textClassName = "#text" + Number(key) ;

		line[2] = $(textClassName).val() ;

		if (line[2] == "") {
			continue ;
		}

		let startTime = line[0] + offsetTime ;
		let endTime = line[1] + offsetTime ;

		let element = {} ;

		element["startTime"] = startTime ;
		element["endTime"] = endTime ;
		element["content"] = formatReadingForSrt(line[2], true) ;
		element["translation"] = line[3] ;

		copiedLines.push(element) ;
	}

	let content = await generateSrtData(copiedLines, true, appDataProperties["language"]) ;

	let fileName = $("#appDataFileName").val() ;

	fileName = fileName.replaceAll(".captionEditor", "") ;
	fileName = fileName.replaceAll(".jimakuEditor", "") ;

	if (appDataProperties["language"] == "ja") {
		fileName += ".ja_JP.srt" ;
	} else {
		fileName += "." + appDataProperties["language"] + ".srt" ;
	}

	$("#toExportSrtSpinner").empty() ;

	saveAsFile(content, fileName) ;
}

async function onClickConvertToSrtButton(e) {
	if (appDataProperties["converted"] == true) {
		alert("このデータは既にハコ割りをしています。") ;
		return ;
	}

	if (window.confirm("ハコ割りをすると元に戻せません。現在の作業中のデータを一度保存してからこの処理を行うことをお勧めします。続行しますか？") == false) {
		return ;
	}

	let spinner = '<div class="d-flex justify-content-center"><div class="spinner-border text-secondary my-3" role="status"><span class="visually-hidden">Loading...</span></div></div>' ;

	$("#convertToSrtSpinner").empty() ;
	$("#convertToSrtSpinner").append(spinner) ;

	let offsetTime = Number($("#offsetTimeLength").val()) ;
	let copiedLines = [] ;

	for (let key in lines) {
		let line = lines[key] ;
		
		if (line[0] + offsetTime < 0) {
			continue ;
		}

		let textClassName = "#text" + Number(key) ;

		line[2] = $(textClassName).val() ;

		if (line[2] == "") {
			continue ;
		}

		let startTime = line[0] + offsetTime ;
		let endTime = line[1] + offsetTime ;

		if (startTime == endTime) {
			continue ;
		}

		let element = {} ;

		element["startTime"] = startTime ;
		element["endTime"] = endTime ;
		element["content"] = line[2] ;
		element["translation"] = line[3] ;

		copiedLines.push(element) ;
	}

	let content = await convertSrtData(copiedLines, false, appDataProperties["language"]) ;
	
	$("#convertToSrtSpinner").empty() ;

	lines = convertToArray(content) ;

	details = [] ;

	for (let key in lines) {
		let line = lines[key] ;

		line[0] = Number(line[0]) ;
		line[1] = Number(line[1]) ;

		details.push({}) ;
	}

	$("#offsetTimeLength").val("0") ;

	appDataProperties["converted"] = true ;

	updateSubtitleData() ;

	alert("ハコ割りが完了しました。") ;
}

async function onClicAppendReadingButton(e) {
	if (appDataProperties["converted"] != true) {
		alert("この処理はハコ割り後に行うことができます。") ;
		return ;
	}

	if (appDataProperties["apppendReading"] == true) {
		alert("すでに一度読みを降っているので再度行うことはできません。") ;
		return ;
	}

	if (appDataProperties["language"] != "ja") {
		alert("この処理は日本語のデータにのみ行うことができます。") ;
		return ;
	}

	if (window.confirm("漢字に読みを振ると元に戻せません。現在の作業中のデータを一度保存してからこの処理を行うことをお勧めします。続行しますか？") == false) {
		return ;
	}

	let spinner = '<div class="d-flex justify-content-center"><div class="spinner-border text-secondary my-3" role="status"><span class="visually-hidden">Loading...</span></div></div>' ;

	$("#appendReadingSpinner").empty() ;
	$("#appendReadingSpinner").append(spinner) ;

	let contents = [] ;

	for (let key in lines) {
		let line = lines[key] ;
		
		let textClassName = "#text" + Number(key) ;

		line[2] = $(textClassName).val() ;

		if (line[2] == "") {
			continue ;
		}

		contents.push(line[2]) ;
	}

	contents = await appendReading(contents, appDataProperties["language"]) ;
	
	$("#appendReadingSpinner").empty() ;

	for (let key in lines) {
		let line = lines[key] ;

		line[2] = contents[key] ;
	}

	appDataProperties["apppendReading"] = true ;

	updateSubtitleData() ;
}

function onClickSaveAsSrtDataWithoutReadingButton(e) {
	if (appDataProperties["converted"] != true) {
		alert("この機能はハコ割りをした後に使用できます。") ;
		return ;
	}

	saveAsSrtData(false) ;
}

function onClickSaveAsSrtDataButton(e) {
	if (appDataProperties["converted"] != true) {
		alert("この機能はハコ割りをした後に使用できます。") ;
		return ;
	}

	if (appDataProperties["apppendReading"] != true) {
		alert("この機能は漢字に読みを振った後に使用できます。") ;
		return ;
	}

	saveAsSrtData(true) ;
}

function saveAsSrtData(hasReading) {
	let srtData = "" ;
	let replacingDots = $('#replacingDots').prop("checked") ;

	let offsetTime = Number($("#offsetTimeLength").val()) ;
	let num = 1 ;

	for (let key in lines) {
		let line = lines[key] ;
		
		if (line[0] + offsetTime < 0) {
			continue ;
		}

		let textClassName = "#text" + Number(key) ;

		line[2] = $(textClassName).val() ;

		if (line[2] == "") {
			continue ;
		}

		let startTime = line[0] + offsetTime ;
		let endTime = line[1] + offsetTime ;

		if (startTime == endTime) {
			continue ;
		}
		
		let text = line[2] ;

		if (replacingDots) {
			text = text.replaceAll("、", " ") ;
			text = text.replaceAll("、", " ") ;
			text = text.replaceAll("。", "") ;
		}

		text = formatReadingForSrt(text, hasReading) ;
		
		text = text.replaceAll("\r\n", "\n") ;
		text = text.replaceAll(/(\n)+/g, "\n") ;
		text = text.trim() ;

		let element = (Number(num)) + "\n" + secToTime(startTime, ",") + " --> " + secToTime(endTime, ",") + "\n" + text + "\n\n" ;

		num++ ;
		srtData += element ;
	}

	let fileName = $("#appDataFileName").val() ;

	fileName = fileName.replaceAll(".captionEditor", "") ;
	fileName = fileName.replaceAll(".jimakuEditor", "") ;

	if (appDataProperties["language"] == "ja") {
		if (appDataProperties["apppendReading"] != true) {
			fileName += ".ja_JP.srt" ;
		} else {
			if (hasReading) {
				fileName += "_読み仮名あり.ja_JP.srt" ;
			} else {
				fileName += "_読み仮名なし.ja_JP.srt" ;
			}
		}
	} else {
		fileName += "." + appDataProperties["language"] + ".srt" ;
	}

	saveAsFile(srtData, fileName) ;
}

function onClickSaveAsSrvDataButton(e) {
	if (appDataProperties["converted"] != true) {
		alert("この機能はハコ割りをした後に使用できます。") ;
		return ;
	}

	if (appDataProperties["apppendReading"] != true) {
		alert("この機能は漢字に読みを振った後に使用できます。") ;
		return ;
	}

	let srvData = '<?xml version="1.0" encoding="utf-8"?>' ;
	srvData += '<timedtext format="3">' ;
	srvData += '<head>' ;
	srvData += '<pen id="1" />' ;
	srvData += '<pen id="2" rb="1" />' ;
	srvData += '<pen id="3" rb="2" />' ;
	srvData += '<pen id="4" rb="4" />' ;
	srvData += '<pen id="5" rb="5" />' ;
	srvData += '<ws id="1" ju="0" />' ;
	srvData += '<wp id="1" ap="7" ah="50" av="100" />' ;
	srvData += '</head>' ;
	srvData += '<body>' ;

	let replacingDots = $('#replacingDots').prop("checked") ;

	let offsetTime = Number($("#offsetTimeLength").val()) ;
	let num = 1 ;

	for (let key in lines) {
		let line = lines[key] ;
		
		if (line[0] + offsetTime < 0) {
			continue ;
		}

		let textClassName = "#text" + Number(key) ;

		line[2] = $(textClassName).val() ;

		if (line[2] == "") {
			continue ;
		}

		let startTime = line[0] + offsetTime ;
		let endTime = line[1] + offsetTime ;

		if (startTime == endTime) {
			continue ;
		}
		
		let text = line[2] ;

		if (replacingDots) {
			text = text.replaceAll("、", " ") ;
			text = text.replaceAll("、", " ") ;
			text = text.replaceAll("。", "") ;
		}

		text = formatReadingForSrv(text) ;
		
		text = text.replaceAll("\r\n", "\n") ;
		text = text.replaceAll(/(\n)+/g, "\n") ;
		text = text.trim() ;

		srvData += '<p t="' + Math.floor(startTime * 1000) + '" d="' + Math.floor((endTime - startTime) * 1000) + '" ws="1" wp="1">' ;
		srvData += text ;
		srvData += '</p>' ;
	}

	srvData += '</body>' ;
	srvData += '</timedtext>' ;

	let fileName = $("#appDataFileName").val() ;

	fileName = fileName.replaceAll(".captionEditor", "") ;
	fileName = fileName.replaceAll(".jimakuEditor", "") ;

	if (appDataProperties["language"] == "ja") {
		fileName += "_読み仮名あり.ja_JP.srv3" ;
	} else {
		fileName += "." + appDataProperties["language"] + ".srv3" ;
	}

	saveAsFile(srvData, fileName) ;
}

function onClickSaveAppDataFunction(e) {
	saveAppData(lines, details, appDataProperties) ;
}

function onClickSaveAcpWordDataButton(e) {
	let fileName = $("#acpWordDataFileName").val() ;
	
	if (fileName == undefined || fileName == null || fileName == "") {
		alert("ファイル名を入力してください。") ;
		return ;
	}

	let acpProfileWords = $("#acpProfileWords").val() ;

	saveAsFile(acpProfileWords , fileName) ;
}

let translationDialog ;

async function onClickModalTranslationDialogButton() {
	if (lines.length == 0) {
		alert("データを読み込んでください。") ;
		return ;
	}

	if (appDataProperties["converted"] == true) {
		alert("すでにハコ割りされています。翻訳はハコ割り前のデータを使って行ってください。") ;
		return ;
	}

	if (appDataProperties["translated"] == true) {
		if (!window.confirm("すでに翻訳されています。内容が上書きされるので現在の作業中のデータを一度保存してからこの処理を行うことをお勧めします。続行しますか？")) {
			return ;
		}
	}
		
	let toLanguage = localStorage.getItem("toLanguage") ;

	if (toLanguage != undefined) {
		$('#toLanguageSelect').val(toLanguage) ;
	} else {
		$('#toLanguageSelect').val("en") ;
	}

	let fromLanguage = $("#fromLanguageSelect").val() ;
	
	if (appDataProperties["translated"] == true) {
		fromLanguage = appDataProperties["originalLanguage"] ;
	}

	$("#originalLanguageLabel").text(translationLanguages[fromLanguage]) ;

	translationDialog = new bootstrap.Modal(document.getElementById('translationDialog'));
	translationDialog.show() ;
}

async function onClickMakeTranslationButton() {
	$("#makeTranslationButton").prop("disabled", true);
	$("#makeTranslationCancelButton").prop("disabled", true);
	
	let spinner = '<div class="d-flex justify-content-center"><div class="spinner-border text-secondary my-3" role="status"><span class="visually-hidden">Loading...</span></div></div>' ;
	
	$("#makingTranslationSpinner").empty() ;
	$("#makingTranslationSpinner").append(spinner) ;

	let fromLanguage = $("#fromLanguageSelect").val() ;
	let toLanguage = $("#toLanguageSelect").val() ;

	localStorage.setItem("toLanguage", toLanguage) ;

	if (appDataProperties["translated"] == true) {
		for (let key in lines) {
			let line = lines[key] ;

			line[2] = line[3] ;
			line[3] = "" ;
			line[5] = line[2] ;
		}

		fromLanguage = appDataProperties["originalLanguage"] ;
	}

	if (fromLanguage == toLanguage) {
		alert("同じ言語への翻訳はできません。") ;
	} else {
		await getTranslation(fromLanguage, toLanguage, (length, index, line) => {
			$("#translationProgressing").text(index + "/" + length) ;
		}) ;

		appDataProperties["translated"] = true ;
		appDataProperties["language"] = toLanguage ;
		appDataProperties["originalLanguage"] = fromLanguage ;

		$("#fromLanguageSelect").val(appDataProperties["language"]) ;

		updateSubtitleData() ;
	}

	$("#makeTranslationButton").prop("disabled", false);
	$("#makeTranslationCancelButton").prop("disabled", false);
	
	$("#makingTranslationSpinner").empty() ;
	$("#translationProgressing").text("") ;

	translationDialog.hide();
}

function onClickSaveOriginalDataButton() {
	if (appDataProperties["translated"] != true) {
		alert("この操作は翻訳後に行うことができます。") ;
		return ;
	}

	if (appDataProperties["converted"] == true) {
		alert("すでにハコ割りされています。この操作はハコ割り前にのみ行うことができます。") ;
		return ;
	}

	let newAppDataProperties = {} ;

	for (let key in appDataProperties) {
		newAppDataProperties[key] = appDataProperties[key] ;
	}

	newAppDataProperties["language"] = newAppDataProperties["originalLanguage"] ;
	
	delete newAppDataProperties["translated"] ;
	delete newAppDataProperties["originalLanguage"] ;

	let newLines = [] ;

	for (let key in lines) {
		let line = lines[key] ;

		let newLine = Array.from(line) ;

		newLine[2] = newLine[3] ;
		newLine[3] = "" ;
		newLine[5] = newLine[2] ;

		newLines.push(newLine) ;
	}

	saveAppData(newLines, details, newAppDataProperties) ;
}

// unused
function onClickSeparateByDotButton() {
	if (lines.length == 0) {
		alert("データを読み込んでください。") ;
		return ;
	}

	if (appDataProperties["converted"] == true) {
		alert("すでにハコ割りされています。この操作はハコ割り前のデータを使って行ってください。") ;
		return ;
	}

	if (appDataProperties["translated"] == true) {
		alert("すでに翻訳されています。この操作は翻訳前のデータに対して行うことができます。") ;
		return ;
	}

	if (appDataProperties["language"] != "ja") {
		alert("この操作は日本語の編集データに対してのみ行うことができます。") ;
		return ;
	}

	let newLines = [] ;
	let newDetails = [] ;

	for (let key in lines) {
		let line = lines[key] ;
		let detail = details[key] ;

		let duration = line[1] - line[0] ;
		let text = line[2] ;

		if (text == "") {
			continue ;
		}

		let timePerChar = duration / text.length ;

		let blocks = text.split("。") ;

		if (blocks.length > 1) {
			let startTime = line[0] ;

			for (let blockkey in blocks) {
				let block = blocks[blockkey] ;

				if (block == "") {
					continue ;
				}

				let endTime = startTime + block.length * timePerChar ;

				let newLine = Array.from(line) ;

				newLine[0] = startTime ;
				newLine[1] = endTime ;
				newLine[2] = block + "。" ;

				newLines.push(newLine) ;
				newDetails.push(detail) ;

				startTime = endTime ;
			}
		} else {
			newLines.push(line) ;
			newDetails.push(detail) ;
		}
	}

	lines = newLines ;
	details = newDetails ;

	updateSubtitleData() ;
}

