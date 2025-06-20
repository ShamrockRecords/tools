// Local API
function loadLocalVideo(file) {
	localPlayer = $("#localVideoPreview").get(0) ;

	localPlayer.src = URL.createObjectURL(file) ;	
	
	$("#localVideoPreview").css("display", "initial") ;	

	$("#localVideoPreview").on("timeupdate", function(e) {
		updatePlayingTime(localPlayer.currentTime) ;
	}) ;

	$("#localVideoPreview").on("loadedmetadata", function(e) {
		
	});

	$("#videoTitle").text(file.name) ;

	let fileTitle = file.name.split('.').slice(0, -1).join('.')
	$("#appDataFileName").val(fileTitle + ".jimakuEditor") ;

	updatePlayingTime(0) ;
}

// YouTube API
function loadOnlineVideo(videoURL) {
	if (videoURL == "") {
		alert("YouTube動画のURLを入力してください。") ;
		return ;
	}
	
	let videoId = getVideoIdFromYouTubeURL(videoURL) ;

	if (videoId == "") {
		alert("YouTube動画のURLではありません。") ;
		return ;
	}

	if (ytPlayer != null) {
		ytPlayer.destroy() ;
	}

	$("#onlineVideoPreview").css("display", "initial") ;

	ytPlayer = new YT.Player(
		"onlineVideoPreview",
			{
			width: 16*30,
			height: 9*30,
			videoId: videoId,
			
			events: {
				'onReady': onPlayerReady,
				'onStateChange': onPlayerStateChange,
				'onError': onPlayerError
			}
		}
	);
}

let playingTimer = null ;

function onPlayerReady(event) {				
	$("#videoTitle").text(ytPlayer.getVideoData().title) ;

	if ($("#appDataFileName").val() == "") {
		$("#appDataFileName").val(ytPlayer.getVideoData().title + ".jimakuEditor") ;
	}
	
	updatePlayingTime(ytPlayer.getCurrentTime()) ;
}

function onPlayerStateChange(event) {
	switch (event.data) {
		case YT.PlayerState.ENDED:
			clearTimeout(playingTimer);
			playingTimer = null ;
			console.log("YT.PlayerState.ENDED") ;
			break ;
		case YT.PlayerState.PLAYING:
			clearTimeout(playingTimer);
			playingTimer = setInterval(onPlaying, 200);
			console.log("YT.PlayerState.PLAYING") ;
			break ;
		case YT.PlayerState.PAUSED:
			playerPlaying = false ;
			clearTimeout(playingTimer);
			playingTimer = null ;
			console.log("YT.PlayerState.PAUSED") ;
			break ;
		case YT.PlayerState.BUFFERING:
			console.log("YT.PlayerState.BUFFERING") ;
			break ;
		case YT.PlayerState.CUED:
			console.log("YT.PlayerState.CUED") ;
			break ;
	}
}

function onPlaying() {
	updatePlayingTime(ytPlayer.getCurrentTime()) ;
}

function onPlayerError(event) {

}

function updatePlayingTime(currentTime) {
	$("#videoTime").text(secToTime(Number(currentTime), '.')) ;

	if ($('#showPreviewAlways').prop("checked") || appDataProperties["converted"] == true) {
		let subtitle = getCurrentSubtitle(currentTime) ;

		subtitle = subtitle.replaceAll("\n", "<br />") ;

		$("#subtitlePreview").html(formatReadingForHtml(subtitle)) ;
	} else {
		$("#subtitlePreview").html("") ;
	}
}

function getVideoIdFromYouTubeURL(url) {
	var parser = new URL(url) ;

	if (parser.hostname == "youtu.be") {
		return parser.pathname.trim().substring(1) ; // Remove leading slash
	} else {
		if (parser.pathname.startsWith("/live")) {
			return parser.pathname.split("/").pop() ;
		} else if (parser.searchParams.has("v")) {
			return parser.searchParams.get("v") ;
		}
	}

	return "" ;
}

// Player wrapper
function playVideo() {
	subtitleIndex = 0 ;

	if (ytPlayer) {
		return ytPlayer.playVideo() ;
	} else if (localPlayer) {
		return localPlayer.play() ;
	}
}

function pauseVideo() {
	if (ytPlayer) {
		return ytPlayer.pauseVideo()
	} else if (localPlayer) {
		return localPlayer.pause() ;
	}
}

function isPlayingVideo() {
	if (ytPlayer) {
		return playingTimer != null ;
	} else if (localPlayer) {
		return localPlayer.paused == false ;
	}
}

function seekToVideo(time, autoPlay) {
	subtitleIndex = 0 ;

	if (ytPlayer) {
		ytPlayer.seekTo(time) ;
		if (autoPlay) {
			ytPlayer.playVideo() ;
		}
	} else if (localPlayer) {
		localPlayer.currentTime = time ;
		if (autoPlay) {
			localPlayer.play() ;
		}
	}
}

function playingGetCurrentTime() {
	if (ytPlayer) {
		return ytPlayer.getCurrentTime();
	} else if (localPlayer) {
		return localPlayer.currentTime ;
	}
}

function setPlaybackRate(rate) {
	if (ytPlayer != null) {
		ytPlayer.setPlaybackRate(rate) ;
	} else if (localPlayer) {
		localPlayer.playbackRate = rate ;
	}
}

function playingToggle() {
	if (!isPlayingVideo()) {
		playVideo()
	} else {
		pauseVideo() ;
	}
}

function playingFastForword(sec) {
	let currentTime = playingGetCurrentTime();

	seekToVideo(currentTime + sec, false) ;
	updatePlayingTime(currentTime + sec) ;
}

function playingRewind(sec) {
	let currentTime = playingGetCurrentTime();

	seekToVideo(currentTime - sec, false) ;
	updatePlayingTime(currentTime - sec) ;
}