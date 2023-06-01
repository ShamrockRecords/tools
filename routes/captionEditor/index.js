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
                    path[key]["surface_form"] == " " ||
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

    let lines = req.body.lines ;

    try {
        for (let key in lines) {
            let line = lines[key] ;

            let result = await translate(line[2], req.body.from, req.body.to, process.env.GOOGLE_API_KEY) ;

            line[3] = line[2] ;
            line[2] = result.data.translations[0].translatedText ;
            line[5] = line[2] ;
        }
    } catch (e) {
        console.log(e) ;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(lines));
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

module.exports = router;