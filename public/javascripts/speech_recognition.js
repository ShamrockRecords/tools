let isSpeechRecognizing = false ;

async function runSpeechRecognition(completion) {
    if (mediafile == null) {
        alert("ファイルを読み込んでください。") ;
        return ;
    }

    if (isSpeechRecognizing) {
        alert("現在音声認識の処理中です。処理が終わるまでお待ちください。") ;
        return ;
    }

    if (lines.length != 0) {
        if (!confirm("既に編集対象の認識結果があります。上書きされますが宜しいですか？")) {
            return ;
        }
    }

    let grammarFileNames = $("#acpGrammarFileNameSelect").val() ;
    let profileId = $("#acpProfileId").val() ;
    let profileWords = $("#acpProfileWords").val() ;
    let authorization = $("#acpAppKey").val() ; 
    let loggingOptOut = $('[name=acpLoggingOptOut]').val();
    let ignoreReplyToken = $('#ignoreReplyToken').prop("checked") ;
    let diarization = $('#acpDiarization').prop("checked") ;
    let diarizationCount = $('#acpDiarizationCount').val() ;

    if (authorization == "") {
        alert("音声認識設定でAPPKEYを入力してください。") ;
        return ;
    }

    isSpeechRecognizing = true ;


    let spinner = '<div class="d-flex justify-content-center"><div class="spinner-border text-secondary my-3" role="status"><span class="visually-hidden">Loading...</span></div></div>' ;
				
    $("#toRunSpeechRecognitionSpinner").empty() ;
    $("#toRunSpeechRecognitionSpinner").append(spinner) ;

    // 変換
    let targetFile = mediafile ;

    const { createFFmpeg, fetchFile } = FFmpeg;
    const ffmpeg = createFFmpeg({ log: true });

    if (!targetFile.name.endsWith(".mp3") && !targetFile.name.endsWith(".wav")) {
        $("#speechRecognitionButton").html("ファイルを変換中...") ;

        ffmpeg.setProgress(({ ratio }) => {
            $("#speechRecognitionButton").html("ファイルを変換中... " + Math.floor(ratio * 100) + "%") ;
        });

        await ffmpeg.load();
        
        ffmpeg.FS('writeFile', 'temp', await fetchFile(targetFile));
        await ffmpeg.run('-i', 'temp', '-c:a', 'libmp3lame', '-vn', '-b:a', '256k', 'audio.mp3');
        const data = ffmpeg.FS('readFile', 'audio.mp3');
        
        targetFile = new Blob([data.buffer], { type: 'audio/mp3' }) ;
    }

    let serverURL = "https://acp-api-async.amivoice.com/v1/recognitions" ;

    var formData = new FormData();
    let domainId = "" ;

    domainId += "grammarFileNames=";
    domainId += encodeURIComponent(grammarFileNames);
    
    if (profileId != "") {
        if (domainId.length > 0) {
            domainId += ' ';
        }

        profileId = profileId.trim() ;

        domainId += "profileId=";
        domainId += encodeURIComponent(profileId);
    }

    if (profileWords != "") {
        if (domainId.length > 0) {
            domainId += ' ';
        }

        let array = convertToArray(profileWords) ;
        
        profileWords = "" ;

        for (let key in array) {
            let elements = array[key] ;

            if (elements.length == 2) {
                profileWords += elements[0].replaceAll(" ", "_") + " " + elements[1] + " 固有名詞" + "|" ;
            } else if (elements.length == 3) {
                profileWords += elements[0].replaceAll(" ", "_") + " " + elements[1] + " " + elements[2] + "|" ;
            }
        }

        profileWords = profileWords.slice( 0, -1 ) ;

        domainId += "profileWords=";
        domainId += encodeURIComponent(profileWords);
    }

    if (loggingOptOut != 0) {
        if (domainId.length > 0) {
            domainId += ' ';
        }

        domainId += "loggingOptOut=True";
    }

    if (diarization) {
        if (domainId.length > 0) {
            domainId += ' ';
        }

        domainId += "speakerDiarization=True";

        if (Number(diarizationCount) < 10) {
            if (domainId.length > 0) {
                domainId += ' ';
            }
    
            domainId += "diarizationMaxSpeaker=" + Number(diarizationCount) + " " + "diarizationMinSpeaker=" + Number(diarizationCount) ;
        }
    }

    console.log(domainId) ;

    if (authorization != "") {
        authorization = authorization.trim() ;
        authorization= encodeURIComponent(authorization);
    }

    formData.append("u", authorization);
    formData.append("d", domainId);
    formData.append("a", targetFile);

    const param = {
        method: "POST",
        body: formData
    }

    $("#speechRecognitionButton").html("アップロード中...") ;

    let data = await fetch(serverURL, param).then(response => response.json()) ;

    if (data["sessionid"] == undefined) {
        alert("音声認識を開始することができませんでした。" + "\n" + data["message"]) ;
        completion("") ;
        isSpeechRecognizing = false ;
    } else if (data["sessionid"] == "") {
        alert("音声認識を開始することができませんでした。" + "\n" + data["message"]) ;
        completion("") ;
        isSpeechRecognizing = false ;
    } else {
        let sessionId = data["sessionid"] ;

        let startedDate = Date.now() ;

        $("#speechRecognitionButton").html("処理を待っています...") ;

        let timer = setInterval(async () => {
            const param = {
                headers: {"Authorization": "Bearer " + authorization},
            }

            let data = await fetch(serverURL + "/" + sessionId, param).then(response => response.json()) ;

            if (data["status"] == "completed") {
                lines = [] ;
                details = [] ;

                let segments = data["segments"]
                let currentSpeakerName = "" ;

                for (let key in segments) {
                    let segment = segments[key] ;

                    //console.log(segment) ;

                    let results = segment["results"][0] ;
                    let tokens = results["tokens"] ;

                    let text = "" ;

                    let currentStartTime = "" ;
                    let currentEndTime = "" ;

                    for (let key in tokens) {
                        let token = tokens[key] ;

                        let startTime = token["starttime"] ;
                        currentEndTime = token["endtime"] ;
                        let speakerName = token["label"] ;
                        let written = token["written"] ;
                        
                        written = normalizeWrittenForm(written) ;

                        if (ignoreReplyToken == true) {
                            if (written == "はい" || written == "うん") {
                                continue ;
                            }
                        }

                        if (currentStartTime == "") {
                            currentStartTime = startTime ;
                        }

                        if (speakerName == undefined) {
                            speakerName = "" ;
                        }

                        if (currentSpeakerName != speakerName && speakerName != "" && written != "。" && written != "、") {
                            currentSpeakerName = speakerName ;

                            if (grammarFileNames == "-a-general-en") {
                                if (text != "") {
                                    text = text.trim() ;
                                    
                                    if (!text.endsWith(".")) {
                                        text += "." ;
                                    }
                                }

                                text += " " ;
                                text += currentSpeakerName + "/ " + written + " " ;
                            } else if (grammarFileNames == "-a-general-zh") {
                                if (text != "") {
                                    text = text.trim() ;
                                    
                                    if (!text.endsWith("。")) {
                                        text += "。" ;
                                    }
                                }

                                text += currentSpeakerName + "/ " + written ;
                            } else {
                                if (text != "") {
                                    if (text.endsWith("、")) {
                                        text = text.slice( 0, -1 ) ;
                                        text += "。" ;
                                    } else if (!text.endsWith("。")) {
                                        text += "。" ;
                                    }
                                }

                                text += currentSpeakerName + "／" + written ;
                            }
                        } else {
                            if (grammarFileNames == "-a-general-en") {
                                text += written + " " ;
                            } else {
                                if (written == "。" || written == "、") {
                                    if (text != "" && !text.endsWith("。") && !text.endsWith("、")) {
                                        text += written ;
                                    }
                                } else {
                                    text += written ;
                                }
                            }
                        }

                        if (text.length > 40 && (text.endsWith("。") || text.endsWith("、"))) {
                            text = text.trim() ;
                            text = text.replaceAll("＿", " ") ;

                            let line = [] ;

                            line.push(currentStartTime / 1000) ;
                            line.push(currentEndTime / 1000) ;
                            line.push(text) ;
                            line.push("") ;
                            line.push("") ;
                            line.push(text) ;

                            currentStartTime = "" ;
                            text = "" ;

                            lines.push(line) ;
                            details.push({}) ;
                        }
                    }

                    if (text.length > 0 && text != "。" && text != "、") {

                        text = text.trim() ;
                        text = text.replaceAll("＿", " ") ;

                        let line = [] ;

                        line.push(currentStartTime / 1000) ;
                        line.push(currentEndTime / 1000) ;
                        line.push(text) ;
                        line.push("") ;
                        line.push("") ;
                        line.push(text) ;

                        currentStartTime = "" ;
                        text = "" ;

                        lines.push(line) ;
                        details.push({}) ;
                    }
                }

                clearInterval(timer) ;
                acpStatusCheckTimer = null ;

                updateSubtitleData() ;

                completion("") ;
                
                isSpeechRecognizing = false ;
                $("#toRunSpeechRecognitionSpinner").empty() ;
            } else {
                let progressDate = Date.now() ;
                let timeInterval = progressDate - startedDate ;

                timeInterval = Math.floor(timeInterval / 1000) ;

                let min = Math.floor(timeInterval / 60) ;
                let sec = timeInterval % 60 ;
                let timeIntervalText = "" ;

                if (min == 0) {
                    timeIntervalText = sec + "秒" ;
                } else {
                    timeIntervalText = min + "分" + sec + "秒" ;
                }

                if (data["status"] == "queued") {
                    $("#speechRecognitionButton").html("処理を待っています..." + "<br />" + timeIntervalText + "経過") ;
                } else if (data["status"] == "started") {
                    $("#speechRecognitionButton").html("処理を開始しました..." + "<br />" + timeIntervalText + "経過") ;
                } else if (data["status"] == "processing") {
                    $("#speechRecognitionButton").html("結果を取得しています..." + "<br />" + timeIntervalText + "経過") ;
                } else {
                    
                }
            }

        }, 5000) ;
    }
}

function normalizeWrittenForm(written) {
    written = written.replaceAll("_", " ") ;

    return written ;
}