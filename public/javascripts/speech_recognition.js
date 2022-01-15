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
    let param = "" ;
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
        authorization = authorization.trim() ;

        param += "?u=";
        param += encodeURIComponent(authorization);
    }

    if (loggingOptOut != 0) {
        if (domainId.length > 0) {
            domainId += ' ';
        }

        domainId += "loggingOptOut=True";
    }

    formData.append("d", domainId);
    formData.append("a", targetFile);

    const postParam = {
        method: "POST",
        body: formData
    }

    $("#speechRecognitionButton").html("アップロード中...") ;

    let data = await fetch(serverURL + param, postParam).then(response => response.json()) ;

    if (data["sessionid"] == undefined) {
        alert("音声認識を開始することができませんでした。\n" + data["message"]) ;
        $("#speechRecognitionButton").html("音声認識結果を取得") ;
        isSpeechRecognizing = false ;
    } else if (data["sessionid"] == "") {
        alert("音声認識を開始することができませんでした。\n" + data["message"]) ;
        $("#speechRecognitionButton").html("音声認識結果を取得") ;
        isSpeechRecognizing = false ;
    } else {
        let sessionId = data["sessionid"] ;

        let startedDate = Date.now() ;

        $("#speechRecognitionButton").html("処理を待っています...") ;

        let count = 0 ;

        let timer = setInterval(async () => {
            const param = {
                headers: {"Authorization": "Bearer " + authorization},
            }

            let data = await fetch(serverURL + "/" + sessionId, param).then(response => response.json()) ;

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

                $("#speechRecognitionButton").html("音声認識結果を取得") ;
                
                isSpeechRecognizing = false ;

                alert("音声認識処理が完了しました。結果が表示されます。") ;

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
                    $("#speechRecognitionButton").html("処理を待っています...<br />" + timeIntervalText + "経過") ;
                } else if (data["status"] == "started") {
                    $("#speechRecognitionButton").html("処理を開始しました...<br />" + timeIntervalText + "経過") ;
                } else if (data["status"] == "processing") {
                    $("#speechRecognitionButton").html("結果を取得しています...<br />" + timeIntervalText + "経過") ;
                } else {
                    
                }
            }

        }, 5000) ;
    }
}