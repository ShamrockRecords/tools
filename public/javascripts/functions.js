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