let isSpeechRecognizing = false ;

async function runSpeechRecognition() {
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

    let grammarFileNames = $("#acpGrammarFileNames").val() ;
    let profileId = $("#acpProfileId").val() ;
    let authorization = $("#acpAppKey").val() ; 
    let loggingOptOut = $('[name=acpLoggingOptOut]').val();

    if (authorization == "") {
        alert("音声認識設定でAPPKEYを入力してください。") ;
        return ;
    }

    isSpeechRecognizing = true ;

    // 変換
    let targetFile = mediafile ;

    const { createFFmpeg, fetchFile } = FFmpeg;
    const ffmpeg = createFFmpeg({ log: true });

    if (!targetFile.name.endsWith(".mp3") && !targetFile.name.endsWith(".wav")) {
        $("#speechRecognitionButton").val("ファイルを変換中...") ;

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

    if (authorization != "") {
        if (domainId.length > 0) {
            domainId += ' ';
        }

        authorization = authorization.trim() ;

        domainId += "authorization=";
        domainId += encodeURIComponent(authorization);
    }

    if (loggingOptOut != 0) {
        if (domainId.length > 0) {
            domainId += ' ';
        }

        domainId += "loggingOptOut=True";
    }

    //console.log(domainId) ;

    formData.append("d", domainId);
    formData.append("a", targetFile);

    const param = {
        method: "POST",
        body: formData
    }

    $("#speechRecognitionButton").val("アップロード中...") ;

    let data = await fetch(serverURL, param).then(response => response.json()) ;

    if (data["sessionid"] == undefined) {
        alert("Session Idが取得できませんでした。APPKEYが間違っている可能性があります。") ;
    } else if (data["sessionid"] == "") {
        alert("Session Idが取得できませんでした。APPKEYが間違っている可能性があります。") ;
    } else {
        let sessionId = data["sessionid"] ;

        $("#speechRecognitionButton").val("処理を待っています...") ;

        let count = 0 ;

        let timer = setInterval(async () => {
            const param = {
                headers: {"Authorization": "Bearer " + authorization},
            }

            let data = await fetch(serverURL + "/" + sessionId, param).then(response => response.json()) ;

            //console.log(data) ;

            count++ ;

            if (data["status"] == "completed") {
                lines = [] ;
                details = [] ;

                let segments = data["segments"]

                for (let key in segments) {
                    let segment = segments[key] ;
                    
                    let line = [] ;

                    let startTime = segment["results"][0]["starttime"] ;
                    let endTime = segment["results"][0]["endtime"] ;

                    line.push(startTime / 1000) ;
                    line.push(endTime / 1000) ;

                    let text = segment["text"].replaceAll("＿", " ") ;

                    line.push(text) ;

                    lines.push(line) ;
                    details.push({}) ;
                }

                clearInterval(timer) ;
                acpStatusCheckTimer = null ;

                updateSubtitleData() ;

                $("#speechRecognitionButton").val("音声認識結果を取得") ;
                
                isSpeechRecognizing = false ;

            } else {
                if (data["status"] == "queued") {
                    $("#speechRecognitionButton").val("処理を待っています... (" + count + ")") ;
                } else if (data["status"] == "started") {
                    $("#speechRecognitionButton").val("処理を開始しました (" + count + ")") ;
                } else if (data["status"] == "processing") {
                    $("#speechRecognitionButton").val("結果を取得しています... (" + count + ")") ;
                } else {
                    $("#speechRecognitionButton").val(data["status"]) ;
                    isSpeechRecognizing = false ;
                }
            }

        }, 5000) ;
    }
}