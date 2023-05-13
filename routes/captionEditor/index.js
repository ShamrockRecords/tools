var express = require('express');
var router = express.Router() ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

// handlers

router.get('/', wrap(async function(req, res, next) { 
    res.render('tools/captionEditor/index', {
        appTitle: res.__('字幕エディター for YouTube'),
        rootURL: process.env.ROOT_URL + "/jimakueditor",
        mediaType: "youtube",
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

        if (err != null) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(req.body));
            return ;
        }

        for (let key in req.body) {
            let line = req.body[key]
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
        res.end(JSON.stringify(req.body));
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
        result = await getUserWordsByAccessToken(req.body.token, req.body.account) ;
    } catch (e) {
        console.log(e) ;
    }

    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
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

async function getUserWordsByAccessToken(accessToken, account) {
	const headers = {
		'Accept': 'application/json',
		'Content-Type': 'application/json'
	};

	const param = {
		method: "POST",
		headers: headers,
		body: JSON.stringify({"accounts": [account], "token" : accessToken}),
	}

	return await fetch("https://words.udtalk.jp/api/get_user_words_by_access_token", param).then(response => response.json()) ;
}

module.exports = router;