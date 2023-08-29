var superagent = require('superagent');

var apiEndpoint = 'http://127.0.0.1:9876';


superagent.get('http://127.0.0.1:9876/status')
    .accept('application/json')
    .then((results) => {
        console.log(results.body);
    })

superagent.post('http://127.0.0.1:9876/player/play')
    .accept('application/json')
    .then((results) => {
        console.log(results.body);
    })