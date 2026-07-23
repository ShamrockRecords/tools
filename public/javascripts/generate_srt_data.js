async function convertSrtData(copiedlines, replacingDots, language) {
	const headers = {
		'Accept': 'application/json',
		  'Content-Type': 'application/json'
	};

	const param = {
		method: "POST",
		headers: headers,
		body: JSON.stringify({"lines" : copiedlines, "language" : language}),
	}

	copiedlines = await fetch("/jimakueditor/data", param).then(response => response.json()) ;

	return generateResult(copiedlines, replacingDots, language, function(num, tempBeginSec, tempEndSec, tempContent, tempTranslation) {
		return tempBeginSec + ',' + tempEndSec + ',\"' + tempContent + '\",\"' + tempTranslation + '\"\n' ;
	}) ;
}

async function generateSrtData(copiedlines, replacingDots, language) {
	const headers = {
		'Accept': 'application/json',
		  'Content-Type': 'application/json'
	};

	const param = {
		method: "POST",
		headers: headers,
		body: JSON.stringify({"lines" : copiedlines, "language" : language}),
	}

	copiedlines = await fetch("/jimakueditor/data", param).then(response => response.json()) ;

	return generateResult(copiedlines, replacingDots, language, function(num, tempBeginSec, tempEndSec, tempContent, tempTranslation) {
        let tempBeginTimeF = secToTime(tempBeginSec, ".") ;
        let tempEndTimeF = secToTime(tempEndSec, ".") ;

		return num.toString() + '\n' + tempBeginTimeF.replaceAll(".", ",") + ' --> ' + tempEndTimeF.replaceAll(".", ",") + '\n' + tempContent + '\n\n' ;
	}) ;
}

function generateResult(copiedlines, replacingDots, language, listener) {
	
    if (language == null || language == undefined || language == "") {
        language = "ja" ;
    }

    let result = "" ;
    let num = 1 ;
    let maxLengthPerLine = 15 ;
    let maxLengthPerBlock = maxLengthPerLine * 2 ;

    for (let i=0; i<copiedlines.length; i++) {
        let elements = copiedlines[i] ;

		let beginTime = elements["startTime"] ;
		let endTime = elements["endTime"] ;
		let contentArray = elements["content"] ;
        let translation = elements["translation"] ;

        if (contentArray.length == 0) {
            continue ;
        }

        let totalContentLength = contentLengthFromArray(contentArray) ;

        if (totalContentLength == 0) {
            continue ;
        }

        let timeOfChar = (endTime - beginTime) / totalContentLength ;
        let currentIndex = 0 ;
        let subtitleBlocks = divideIntoSubtitleBlocks(contentArray, maxLengthPerBlock, language) ;

        for (let block of subtitleBlocks) {
            let contentLength = contentLengthFromArray(block) ;
            let formattedBlock = devideWith(Array.from(block), maxLengthPerLine, language) ;
            let contentString = contentTextFromArray(formattedBlock) ;

            if (replacingDots) {
                contentString = contentString.replaceAll("、", " ") ;
                contentString = contentString.replaceAll("。", "") ;
            }

            contentString = cleanupContentString(contentString) ;

            if (contentString.length != 0 && contentString != "、" && contentString != "。") {
                let tempBeginTime = currentIndex * timeOfChar ;
                let tempEndTime = tempBeginTime + (timeOfChar * contentLength) ;
                let tempBeginSec = Number((beginTime).toString()) + tempBeginTime ;
                let tempEndSec = Number((beginTime).toString()) + tempEndTime ;

                if (tempBeginSec >= 0 && tempEndSec >= 0) {
                    result += listener(num, tempBeginSec, tempEndSec, contentString, translation) ;
                    num++ ;
                }
            }

            currentIndex += contentLength ;
        }
    }

    return result ;
}

function divideIntoSubtitleBlocks(contentArray, maxLength, language) {
    let result = [] ;
    let currentBlock = [] ;

    for (let element of contentArray) {
        let content = getContentText(element) ;
        let prospectiveBlock = currentBlock.concat([element]) ;
        let prospectiveLength = contentLayoutLengthFromArray(prospectiveBlock) ;

        // 行頭禁止要素を次の字幕へ送るくらいなら、30文字超過を許容して現在の字幕へ含める。
        if (currentBlock.length != 0 &&
            prospectiveLength > maxLength &&
            !isNoLineStartElement(element, language)) {
            result.push(currentBlock) ;
            currentBlock = [] ;
        }

        currentBlock.push(element) ;

        if (isEndOfSentence(content)) {
            result.push(currentBlock) ;
            currentBlock = [] ;
        }
    }

    if (currentBlock.length != 0) {
        result.push(currentBlock) ;
    }

    return result ;
}

function getLayoutText(text) {
    return text.replaceAll("、", " ").replaceAll("。", "") ;
}

function contentTextFromArray(array) {
    let content = "" ;

    for (let element of array) {
        content += getContentText(element) ;
    }

    return content ;
}

function cleanupContentString(content) {
    content = content.replaceAll("\r\n", "\n") ;
    content = content.replaceAll(/(\n)+/g, "\n") ;
    content = content.replaceAll(/[ \t]+\n/g, "\n") ;
    content = content.replaceAll(/\n[ \t]+/g, "\n") ;
    content = content.replaceAll("\n、", "\n") ;
    content = content.replaceAll("\n。", "\n") ;
    content = content.replaceAll("\n.", ".") ;
    content = content.replaceAll(/^(、)+/g, "") ;
    content = content.replaceAll(/^(。)+/g, "") ;

    return content.trim() ;
}

function isEndOfSentence(content) {

    content = content.trim() ;

    let dict = {} ;

    dict["Dr."] = "" ;
    dict["Mr."] = "" ;
    dict["Ms."] = "" ;

    if (dict[content] != null) {
        return false ;
    }

    return content.endsWith("。") ||
        content.endsWith("！") ||
        content.endsWith("？") ||
        content.endsWith(".") ||
        content.endsWith("!") ||
        content.endsWith("?") ;
}

function contentLengthFromArray(array) {
    let length = 0 ;

    for (let key in array) {
        length += getContentText(array[key]).length ;
    }

    return length ;
}

function getContentText(element) {
    if (element == null) {
        return "" ;
    }

    if (typeof element == "string") {
        return element ;
    }

    return element["text"] || "" ;
}

function isNoLineStartElement(element, language) {
    let text = getContentText(element).trim() ;

    if (text == "") {
        return false ;
    }

    if (typeof element != "string" && element["noLineStart"] == true) {
        return true ;
    }

    if (language == "ja" || language.startsWith("zh-")) {
        if (/^[、。，．！？!?）」』】〕）\]\),.]/.test(text)) {
            return true ;
        }

        if (/^[ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ]/.test(text)) {
            return true ;
        }

        if (/^[ー々ゝゞヽヾ゛゜]/.test(text)) {
            return true ;
        }

        if (/^[ぁ-ん]$/.test(text)) {
            return true ;
        }
    }

    return false ;
}

function devideWith(contentArray, index, language) {
    let totalLength = contentLayoutLengthFromArray(contentArray) ;

    if (totalLength <= index) {
        return contentArray ;
    }

    let divideIndex = -1 ;
    let smallestOverflow = Infinity ;
    let smallestPreferredLinePenalty = Infinity ;
    let smallestDifference = Infinity ;

    for (let i=0; i<contentArray.length - 1; i++) {
        if (isNoLineStartElement(contentArray[i + 1], language)) {
            continue ;
        }

        let firstLineLength = contentLayoutLengthFromArray(contentArray.slice(0, i + 1)) ;
        let secondLineLength = contentLayoutLengthFromArray(contentArray.slice(i + 1)) ;
        let overflow = Math.max(0, firstLineLength - index) + Math.max(0, secondLineLength - index) ;
        let preferredLinePenalty = prefersPreviousLine(contentArray[i + 1], language) ? 1 : 0 ;
        let difference = Math.abs(firstLineLength - secondLineLength) ;

        // 15文字超過が最小の候補を優先する。同条件では連続する英単語を同じ行に保ち、
        // それでも同条件なら二行の文字数を近づける。
        if (overflow < smallestOverflow ||
            (overflow == smallestOverflow && preferredLinePenalty < smallestPreferredLinePenalty) ||
            (overflow == smallestOverflow &&
                preferredLinePenalty == smallestPreferredLinePenalty &&
                difference < smallestDifference)) {
            divideIndex = i + 1 ;
            smallestOverflow = overflow ;
            smallestPreferredLinePenalty = preferredLinePenalty ;
            smallestDifference = difference ;
        }
    }

    if (divideIndex != -1) {
        contentArray.splice(divideIndex, 0, "\n") ;
    }
    
    return contentArray ;
}

function prefersPreviousLine(element, language) {
    return language == "ja" &&
        typeof element != "string" &&
        element["preferPreviousLine"] == true ;
}

function contentLayoutLengthFromArray(array) {
    let text = getLayoutText(contentTextFromArray(array)).trim() ;
    let length = 0 ;

    for (let character of Array.from(text)) {
        length += /^[A-Za-z0-9]$/.test(character) ? 0.5 : 1 ;
    }

    return length ;
}
