/* jshint esversion: 8 */
/* jshint node: true */

'use strict';

const express = require('express');
const logger = require('morgan');
const args = require('minimist')(process.argv.slice(2));
const config = require(args.c); // use arg '-c path/config.json' for config file
const https = require('https');
const fs = require('fs');
const { JWT, JWK } = require('jose');
const bodyParser = require('body-parser');
const { OAuth2Client } = require('google-auth-library');

const gOauthClient = new OAuth2Client(config.gauth_clientid);
const app = express();

const key = fs.readFileSync(config.keypath);
const cert = fs.readFileSync(config.certpath);
//const jwk = JWK.asKey({ kty: 'oct', k: config.secret });
const jwk = JWK.asKey(fs.readFileSync(config.rsakeypath));
const server = https.createServer({ key: key, cert: cert }, app);

// engine setup
app.use(logger('dev')); // TODO(mwfarb): switch to 'common'
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(function(req, res, next) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

function signMqttToken(user = null, exp = '1 hour', sub = null, pub = null) {
    var claims = { "sub": user };
    if (sub && sub.length > 0) {
        claims.subs = sub;
    }
    if (pub && pub.length > 0) {
        claims.publ = pub;
    }
    var iat = new Date(new Date() - 20000); // allow for clock skew between issuer and broker
    //return JWT.sign(claims, jwk, { "alg": "HS256", "expiresIn": exp, "now": iat });
    return JWT.sign(claims, jwk, { "algorithm": "RS256", "expiresIn": exp, "now": iat });
}

async function verifyGToken(token) {
    // validate Google id token before issuing mqtt-token
    const ticket = await gOauthClient.verifyIdToken({
        idToken: token,
        audience: config.gauth_clientid
    });
    return ticket.getPayload();
}

function verifyAnon(username) {
    // check user announced themselves an anonymous
    if (!username.startsWith("anonymous-")) {
        throw ('Anonymous users must prefix usernames with "anonymous-"');
    }
}

function generateMqttToken(req, jwt, type) {
    const realm = req.body.realm ? req.body.realm : "realm";
    const scene = req.body.scene;
    const userid = req.body.userid;
    const camid = req.body.camid;
    const ctrlid1 = req.body.ctrlid1;
    const ctrlid2 = req.body.ctrlid2;
    const auth_name = req.body.username;
    let subs = [];
    let pubs = [];
    switch (type) {
        // service-level scenarios
        case 'persistdb':
            // persistence service subs all scene, pubs status
            subs.push([`${realm}/s/#`, `${realm}/admin/s/#`]);
            pubs.push("service_status");
            break;
        case 'sensorthing':
            // realm/g/<session>/uwb or realm/g/<session>/vio (global data)
            subs.push(`${realm}/g/#`);
            pubs.push(`${realm}/g/#`);
            break;
        case 'sensorcamera':
            // realm/g/a/<cameras> (g=global, a=anchors)
            subs.push(`${realm}/g/a/#`);
            pubs.push(`${realm}/g/a/#`);
            break;

        // user-level scenarios
        case 'all':
            subs.push("#");
            pubs.push("#");
            break;
        case 'admin':
            // admin is normal scene pub/sub, plus admin tasks
            subs.push([`${realm}/admin/s/${scene}/#`, `${realm}/s/${scene}/#`]);
            pubs.push([`${realm}/admin/s/${scene}/#`, `${realm}/s/${scene}/#`]);
            break;
        case 'editor':
            // editor is normal scene pub/sub
            subs.push(`${realm}/s/${scene}/#`);
            pubs.push(`${realm}/s/${scene}/#`);
            break;
        case 'viewer':
            // TODO: this is a default temp set of perms, replace with arena-account ACL
            // user presence objects
            if (scene) {
                subs.push(`${realm}/s/${scene}/#`);
                subs.push(`${realm}/g/a/#`);
                if (camid) {
                    pubs.push(`${realm}/s/${scene}/${camid}/#`);
                    pubs.push(`${realm}/g/a/${camid}/#`);
                    pubs.push(`topic/vio/${camid}/#`);
                }
                if (ctrlid1) {
                    pubs.push(`${realm}/s/${scene}/${ctrlid1}/#`);
                }
                if (ctrlid2) {
                    pubs.push(`${realm}/s/${scene}/${ctrlid2}/#`);
                }
            } else {
                subs.push(`${realm}/s/#`);
                subs.push(`${realm}/g/a/#`);
                pubs.push(`${realm}/s/#`);
                pubs.push(`${realm}/g/a/#`);
            }
            // chat messages
            if (userid) {
                // receive private messages: Read
                subs.push(`${realm}/g/c/p/${userid}/#`);
                // receive open messages to everyone and/or scene: Read
                subs.push(`${realm}/g/c/o/#`);
                // send open messages (chat keepalive, messages to all/scene): Write
                pubs.push(`${realm}/g/c/o/${userid}`);
                // private messages to user: Write
                pubs.push(`${realm}/g/c/p/+/${userid}`);
            }
            // runtime
            subs.push(`${realm}/proc/#`);
            pubs.push(`${realm}/proc/#`);
            // network graph
            subs.push(`$NETWORK/#`);
            pubs.push(`$NETWORK/#`);
            break;
        default:
            break;
    }
    jwt = signMqttToken(auth_name, '1 day', subs, pubs);
    return { auth_name, jwt };
}

// main auth endpoint
app.post('/', async (req, res) => {
    console.log("Request:", req.body.id_auth, req.body.username);
    var auth_type = 'none';
    // first, verify the id-token
    switch (req.body.id_auth) {
        case "google":
            let identity = await verifyGToken(req.body.id_token).catch((error) => {
                console.error(error);
                res.status(403);
                res.json({ error: error });
                return;
            });
            auth_type = 'viewer';
            console.log('Verified Google user:', auth_type, req.body.username, identity.email);
            break;
        case "anonymous":
            try {
                verifyAnon(req.body.username);
            } catch (error) {
                console.error(error);
                res.status(403);
                res.json({ error: error });
                return;
            }
            auth_type = 'viewer';
            console.warn('Allowing anonymous user:', auth_type, req.body.username);
            break;
        default:
            var error = ("Invalid authorization provider name:", req.body.id_auth);
            console.error(error);
            res.json({ error: error });
            return;
    }

    // TODO(mwfarb): second, pull/create user record and associate id from token with it

    // third, generate mqtt-token with ACL-level permissions
    var auth_name, jwt;
    ({ auth_name, jwt } = generateMqttToken(req, jwt, auth_type));
    res.cookie('mqtt_token', jwt, { httpOnly: true, secure: true });
    res.json({ username: auth_name, token: jwt });
});

server.listen(config.port, () => {
    console.log(`ARENA MQTT-Auth app listening at port ${config.port}`);
    console.log('Press Ctrl+C to quit.');
});
