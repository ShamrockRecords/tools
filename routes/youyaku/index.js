var express = require('express');
var router = express.Router() ;
var fetch = require('node-fetch') ;
const access = require('../../modules/auth/paid_tool_access');
router.use(access.requireAdmin);

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) {
    res.render('tools/youyaku/index', {rootURL: process.env.ROOT_URL + "/youyaku", csrfToken: access.csrfToken(req)});
})) ;

router.post('/data', access.checkCSRF, access.limited, wrap(async function(req, res, next) {

    let command = req.body.command ;
    let lines = req.body.lines ;

    if (typeof command !== 'string' || command.length > 2000 || !Array.isArray(lines)
      || lines.length > 10000 || lines.some(line => typeof line !== 'string')
      || lines.reduce((count, line) => count + line.length, 0) > 50000) {
      return res.status(400).send('入力が不正か、長すぎます。');
    }
    let text = "" ;

    for (let key in lines) {
        text += lines[key]
    }

    res.setHeader('Content-Type', 'text/plain');
    res.end(await getSummary(text, command, req.app.locals.summaryFetch || fetch));
})) ;

async function getSummary(text, command, requester) {
    let authorization = process.env.OPEN_AI_KEY ;

    let body = {
        "model": "gpt-4o-mini",
        "messages": [
      {"role": "user", "content": command},
      {"role": "user", "content": text}
      ],
        "temperature": 0.2,
        "max_tokens": 2048
    } ;
    const param = {
        timeout: 30000,
        size: 1024 * 1024,
        method: "POST",
        headers: {"Authorization": "Bearer " + authorization, "Content-Type": "application/json"},
        body: JSON.stringify(body)
    }

    let data = "" ;

    try {
        data = await requester("https://api.openai.com/v1/chat/completions", param).then(response => response.json()) ;
        return data.choices[0].message.content ;
    } catch (e) {
        console.error('要約APIへの接続に失敗しました。') ;
        return "" ;
    }
}

module.exports = router;
