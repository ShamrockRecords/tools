var express = require('express');
var router = express.Router() ;
var i18n = require("i18n");

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

// handlers

router.get('/', wrap(async function(req, res, next) { 
    res.render('tools/captionEditor/index', {
        appTitle: res.__('字幕エディター for YouTube'),
        rootURL: process.env.ROOT_URL + "/jimakueditor",
        mediaType: "youtube"
    });		 
})) ;

router.post('/data', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}
    
    var language = req.body.language ;
    var kuromoji = require("kuromoji");

    kuromoji.builder({ dicPath: "node_modules/kuromoji/dict" }).build(function (err, tokenizer) {

        let lines = req.body.lines ;
 
        if (err != null) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(lines));
            return ;
        }

        for (let key in lines) {
            let line = lines[key]
            var path = tokenizer.tokenize(line["content"]);

            let contentArray = [] ;
            let content = "" ;

            for (let key in path) {
                content += path[key]["surface_form"] ;

                if ((path[key]["pos"] == '助詞' && path[key]["pos_detail_1"] != '終助詞') ||
                    path[key]["pos"] == '感動詞' ||
                    path[key]["pos"] == '接続詞' ||
                    path[key]["pos"] == '連体詞' ||
                    (language != "ja" && path[key]["surface_form"] == " ") ||
                    path[key]["surface_form"] == "、" ||
                    path[key]["surface_form"] == "，" ||
                    path[key]["surface_form"] == "。") {
                    contentArray.push(content) ;
                    content = "" ;
                }
            }

            if (content != "") {
                contentArray.push(content) ;
            }

            line["content"] = contentArray ;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(lines));
    });    
})) ;

router.post('/appendReading', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}

    var kuromoji = require("kuromoji");

    kuromoji.builder({ dicPath: "node_modules/kuromoji/dict" }).build(function (err, tokenizer) {

        let contents = req.body.contents ;
 
        if (err != null) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(lines));
            return ;
        }

        let resultContents = [] ;

        for (let key in contents) {
            let content = contents[key]
            var path = tokenizer.tokenize(content);

            let surfaceFormAppended = "" ;
            let readingAppended = "" ;

            content = "" ;

            for (let key in path) {
                let token = path[key] ;

                let surfaceForm = token["surface_form"] ;
                let reading = token["reading"] ;

                if (reading != undefined) {
                    reading = katakanaToHiragana(reading) ;
                }

                if (reading != undefined && katakanaToHiragana(surfaceForm) != reading && reading != "") {
                    content += trimReading(surfaceForm, reading) ;

                    //surfaceFormAppended += surfaceForm ;
                    //readingAppended += reading ;
                } else {
                    if (surfaceFormAppended != "") {
                        content += trimReading(surfaceFormAppended, readingAppended) ;
                        surfaceFormAppended = "" ;
                        readingAppended = "" ;
                    }

                    content += surfaceForm ;
                }
            }

            if (surfaceFormAppended != "") {
                content += trimReading(surfaceFormAppended, readingAppended) ;
                surfaceFormAppended = "" ;
                readingAppended = "" ;
            }

            resultContents.push(content) ;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(resultContents));
    });    
})) ;

router.post('/get_public_dictionaries', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}

    let result = {} ;

    try {
        result = await getPublicDictionaries(req.body.token) ;
    } catch (e) {
        console.log(e) ;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
})) ;

router.post('/get_user_words_by_access_token', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}

    let result = {} ;

    try {
        result = await getUserWordsByAccessToken(req.body.token, req.body.accounts) ;
    } catch (e) {
        console.log(e) ;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
})) ;

router.post('/get_translation_languages', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}

    let result = {} ;

    try {
        result = await getTranslationLanguages(req.body.target, process.env.GOOGLE_API_KEY) ;
    } catch (e) {
        console.log(e) ;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
})) ;

router.post('/get_translation', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}

    let translation = "" ;

    try {
        let result = await translate(req.body.text, req.body.from, req.body.to, process.env.GOOGLE_API_KEY) ;

        translation = result.data.translations[0].translatedText ;
} catch (e) {
        console.log(e) ;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({"translation" : translation}));
})) ;

// functions

async function getPublicDictionaries(accessToken) {
	const headers = {
		'Accept': 'application/json',
		'Content-Type': 'application/json'
	};

	const param = {
		method: "POST",
		headers: headers,
		body: JSON.stringify({"token" : accessToken}),
	}

	return await fetch("https://words.udtalk.jp/api/get_public_dictionaries", param).then(response => response.json()) ;
}

async function getUserWordsByAccessToken(accessToken, accounts) {
	const headers = {
		'Accept': 'application/json',
		'Content-Type': 'application/json'
	};

	const param = {
		method: "POST",
		headers: headers,
		body: JSON.stringify({"accounts": accounts, "token" : accessToken}),
	}

	return await fetch("https://words.udtalk.jp/api/get_user_words_by_access_token", param).then(response => response.json()) ;
}

async function getTranslationLanguages(target, apiKey) {
	const headers = {
		'Accept': 'application/json',
		'Content-Type': 'application/json'
	};

	const param = {
		method: "GET",
		headers: headers,
	}

	return await fetch("https://translation.googleapis.com/language/translate/v2/languages?key=" + apiKey + "&target=" + target, param).then(response => response.json()) ;
}

async function translate(text, from, to, apiKey) {
	const headers = {
		'Accept': 'application/json',
		'Content-Type': 'application/json'
	};

	const param = {
		method: "GET",
		headers: headers,
	}

	return await fetch("https://translation.googleapis.com/language/translate/v2?key=" + apiKey + "&source=" + from + "&target=" + to + "&q=" + text, param).then(response => response.json()) ;
}

function katakanaToHiragana(katakana) {
    const katakanaMap = {
      'ア': 'あ', 'イ': 'い', 'ウ': 'う', 'エ': 'え', 'オ': 'お',
      'カ': 'か', 'キ': 'き', 'ク': 'く', 'ケ': 'け', 'コ': 'こ',
      'サ': 'さ', 'シ': 'し', 'ス': 'す', 'セ': 'せ', 'ソ': 'そ',
      'タ': 'た', 'チ': 'ち', 'ツ': 'つ', 'テ': 'て', 'ト': 'と',
      'ナ': 'な', 'ニ': 'に', 'ヌ': 'ぬ', 'ネ': 'ね', 'ノ': 'の',
      'ハ': 'は', 'ヒ': 'ひ', 'フ': 'ふ', 'ヘ': 'へ', 'ホ': 'ほ',
      'マ': 'ま', 'ミ': 'み', 'ム': 'む', 'メ': 'め', 'モ': 'も',
      'ヤ': 'や', 'ユ': 'ゆ', 'ヨ': 'よ',
      'ラ': 'ら', 'リ': 'り', 'ル': 'る', 'レ': 'れ', 'ロ': 'ろ',
      'ワ': 'わ', 'ヲ': 'を', 'ン': 'ん',
      'ガ': 'が', 'ギ': 'ぎ', 'グ': 'ぐ', 'ゲ': 'げ', 'ゴ': 'ご',
      'ザ': 'ざ', 'ジ': 'じ', 'ズ': 'ず', 'ゼ': 'ぜ', 'ゾ': 'ぞ',
      'ダ': 'だ', 'ヂ': 'ぢ', 'ヅ': 'づ', 'デ': 'で', 'ド': 'ど',
      'バ': 'ば', 'ビ': 'び', 'ブ': 'ぶ', 'ベ': 'べ', 'ボ': 'ぼ',
      'パ': 'ぱ', 'ピ': 'ぴ', 'プ': 'ぷ', 'ペ': 'ぺ', 'ポ': 'ぽ',
      'ヴ': 'ゔ',
      'ァ': 'ぁ', 'ィ': 'ぃ', 'ゥ': 'ぅ', 'ェ': 'ぇ', 'ォ': 'ぉ',
      'ャ': 'ゃ', 'ュ': 'ゅ', 'ョ': 'ょ',
      'ヮ': 'ゎ',
      'ヵ': 'か', 'ヶ': 'け',
      'ッ': 'っ',
      'ヰ': 'い', 'ヱ': 'え',
      'ヸ': 'ゐ', 'ヹ': 'ゑ', 'ヺ': 'を'
    };
  
    let hiragana = '';
    let i = 0;
    while (i < katakana.length) {
      const char = katakana[i];
      let hiraganaChar = katakanaMap[char] || char;
      const nextChar = katakana[i + 1];
  
      if (nextChar && katakanaMap[char + nextChar]) {
        hiraganaChar = katakanaMap[char + nextChar];
        i++;
      }
  
      hiragana += hiraganaChar;
      i++;
    }
  
    return hiragana;
}

function trimReading(surfaceForm, reading) {

    let preToken = "" ;
    
    for (let i=0; i<surfaceForm.length; i++) {
        if (i < reading.length) {
            if (surfaceForm[i] == reading[i]) {
                preToken += surfaceForm[i] ;
            } else {
                break ;
            }
        }
    }
    
    let postToken = "" ;
    let readingIndex = reading.length ;

    for (let i=surfaceForm.length; i>0; i--) {
        if (readingIndex > 0) {
            if (surfaceForm[i-1] == reading[readingIndex-1]) {
                postToken = surfaceForm[i-1] + postToken
            } else {
                break ;
            }
        }

        readingIndex-- ;
    }
    
    let surfaceBody = surfaceForm.substring(preToken.length) ;
    let readingBody = reading.substring(preToken.length) ;

    surfaceBody = surfaceBody.substring(0, surfaceBody.length - postToken.length) ;
    readingBody = readingBody.substring(0, readingBody.length - postToken.length) ;

    return preToken + "[" + surfaceBody + "|" + readingBody + "]" + postToken ;
}

module.exports = router;