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

    let dividing = true ;
 
    let result = "" ;
    let num = 1 ;
    let lengthPerLine =  (language == "ja" || language.startsWith("zh-")) ? 30 : 60 ;

    for (let i=0; i<copiedlines.length; i++) {
        let elements = copiedlines[i] ;

		let beginTime = elements["startTime"] ;
		let endTime = elements["endTime"] ;
		let contentArray = elements["content"] ;
        let translation = elements["translation"] ;

        if (contentArray.length == 0) {
            continue ;
        }

        let timeOfChar = 60000 / 300 ; // average
		let contentLength = 0 ;

		for (let key in contentArray) {
			contentLength += getContentText(contentArray[key]).length ;
		}

		timeOfChar = (endTime - beginTime) / contentLength ;

        let currnetIndex = 0 ;
        
        let tempContentArray = [] ;

        for (let i=0; i<=contentArray.length; i++) {
            
            let content = "" ;
            
            if (i < contentArray.length) {
                content = getContentText(contentArray[i]) ;
            }

            tempContentArray.push(contentArray[i] || content) ;

            if (content.endsWith("。") || 
                isEnglishEndOfToken(content) || 
                contentLengthFromArray(tempContentArray) >= lengthPerLine ||
                contentArray.length == i) {

                if (i < contentArray.length - 1 && isNoLineStartElement(contentArray[i + 1], language)) {
                    continue ;
                }

                let contentLength = 0 ;

                for (let key in tempContentArray) {
                    contentLength += getContentText(tempContentArray[key]).length
                }

                if (dividing) {
                    let countPerLine = (language == "ja" || language.startsWith("zh-")) ? 30 : 60 ;
                    let contentLength = contentLengthFromArray(tempContentArray) ;

                    if (countPerLine < contentLength) {
                        countPerLine = contentLength ;
                    }

                    tempContentArray = devideWith(tempContentArray, countPerLine / 2, language) ;
                }

                let contentString = "" ;

                for (let key in tempContentArray) {
                    contentString += getContentText(tempContentArray[key]) ;
                }
                                        
                if (replacingDots) {
                    contentString = contentString.replaceAll("、", " ") ;
                    contentString = contentString.replaceAll("、", " ") ;
                    contentString = contentString.replaceAll("。", "") ;
                }

                contentString = contentString.replaceAll("\r\n", "\n") ;
				contentString = contentString.replaceAll(/(\n)+/g, "\n") ;
                contentString = contentString.replaceAll("\n ", "\n") ;
                contentString = contentString.replaceAll("\n ", "\n") ;
                contentString = contentString.replaceAll("\n、", "\n") ;
                contentString = contentString.replaceAll("\n。", "\n") ;
                contentString = contentString.replaceAll("\n.", ".") ;
				contentString = contentString.replaceAll(/^(、)+/g, "") ;
                contentString = contentString.replaceAll(/^(。)+/g, "") ;
    
                contentString = contentString.trim();

                if (contentString.length != 0 && contentString != "、" && contentString != "。") {
                    let tempBeginTime = currnetIndex * timeOfChar ;   
                    let tempEndTime = tempBeginTime + (timeOfChar * contentLength) ;

                    let tempBeginSec = Number((beginTime).toString()) + tempBeginTime ;
                    let tempEndSec = Number((beginTime).toString()) + tempEndTime ;

                    if (tempBeginSec >= 0 && tempEndSec >= 0) {
                        result += listener(num, tempBeginSec, tempEndSec, contentString, translation) ;
                        num++ ;
                    }
                }

                currnetIndex += contentLength ;

                tempContentArray = [] ;
            }
        }
    }

    return result ;
}

function isEnglishEndOfToken(content) {

    content = content.trim() ;

    let dict = {} ;

    dict["Dr."] = "" ;
    dict["Mr."] = "" ;
    dict["Ms."] = "" ;

    if (dict[content] != null) {
        return false ;
    }

    return content.endsWith(".") || content.endsWith("!") || content.endsWith("?") ;
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

        if (/^[ぁ-ん]$/.test(text)) {
            return true ;
        }
    }

    return false ;
}

function devideWith(contentArray, index, language) {
    let length = 0 ;

    for (let i=0; i<contentArray.length; i++) {
        length += getContentText(contentArray[i]).length ;

        if (length > index) {
            let divideIndex = i + 1 ;

            while (divideIndex < contentArray.length && isNoLineStartElement(contentArray[divideIndex], language)) {
                divideIndex++ ;
            }

            if (divideIndex <= contentArray.length) {
                contentArray.splice(divideIndex, 0, "\n") ;
            }
            
            break ;
        }
    }
    
    return contentArray ;
}
