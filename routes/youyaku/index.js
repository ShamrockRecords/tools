var express = require('express');
var router = express.Router() ;
var fetch = require('node-fetch') ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) {
    res.render('tools/youyaku/index', {rootURL: process.env.ROOT_URL + "/youyaku"});		 
})) ;

router.post('/data', wrap(async function(req, res, next) {
    
    if (!req.headers.referer.startsWith(process.env.ROOT_URL)) {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({}));
		return ;
	}
    
    let lines = req.body.lines ;
    let output = "" ;
    let count = 1 ;

    let text = "" ;

    for (let key in lines) {
        text += lines[key]
    }
    
    res.setHeader('Content-Type', 'text/plain');
    res.end(await getSummary(text));
})) ;

async function getSummary(text) {
    let authorization = process.env.OPEN_AI_KEY ;

    let body = {
        "model": "gpt-3.5-turbo",
        "messages": [
      {"role": "system", "content": "日本語で要約してください。"},
      {"role": "user", "content": text}
      ],
        "temperature": 0.2
    } ;
    const param = {
        method: "POST",
        headers: {"Authorization": "Bearer " + authorization, "Content-Type": "application/json"},
        body: JSON.stringify(body)
    }

    let data = "" ;

    try {
        data = await fetch("https://api.openai.com/v1/chat/completions", param).then(response => response.json()) ;

    } catch (e) {
        console.log(e) ;
    }

    return data.choices[0].message.content ;
}

module.exports = router;