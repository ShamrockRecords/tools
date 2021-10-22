var express = require('express');
let firebaseSession = require('../modules/firebase_session.js') ;
let admin = require('firebase-admin');
var router = express.Router() ;

const wrap = fn => (...args) => fn(...args).catch(args[2]) ;

router.get('/', wrap(async function(req, res, next) {
    let result = await firebaseSession.enter(req, res) ;

    if (result != 0) {
		if (result == 2) {
			res.render('verify', {});
			return ;
		}

        res.redirect('/signin');
        return ;
    }

	let currentUser = req.session.user ;

	let user ;

	try {
		user = await admin.auth().getUser(currentUser.uid) ;
	} catch (error) {
		
	}

    res.render('index', {user: user});		 
})) ;

router.get('/signout', wrap(async function(req, res, next) {
	delete req.session.errorMessage;

	await firebaseSession.signOut(req, res, () => {
		res.redirect('/') ;
	}) ;
})) ;

module.exports = router;