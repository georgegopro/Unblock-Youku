#!/usr/bin/env node

/*
 * Allow you smoothly surf on many websites blocking non-mainland visitors.
 * Copyright (C) 2012 Bo Zhu http://zhuzhu.org
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */


var http = require('http');
var url = require('url');
var querystring = require('querystring');
var cluster = require('cluster');
var os = require('os');

var sogou = require('./shared/sogou');
var url_list = require('./shared/urls');
var shared_tools = require('./shared/tools');


function get_first_external_ip() {
    // only return the first external ip, which should be fine for usual cases
    var interfaces = os.networkInterfaces();
    var i, j;
    for (i in interfaces) {
        if (interfaces.hasOwnProperty(i)) {
            for (j = 0; j < interfaces[i].length; j++) {
                var addr = interfaces[i][j];
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }
    }
    return '127.0.0.1';  // no external ip, so bind internal ip
}


var server_addr, server_port, proxy_addr;
if (process.env.VMC_APP_PORT || process.env.VCAP_APP_PORT || process.env.PORT) {
    server_addr = '0.0.0.0';
    server_port = process.env.VMC_APP_PORT || process.env.VCAP_APP_PORT || process.env.PORT;
    proxy_addr = 'uku.im';
} else {
    // server_addr = '127.0.0.1';
    server_addr = '0.0.0.0';
    server_port = 8888;
    proxy_addr = get_first_external_ip() + ':' + server_port;
}
var pac_file_content = shared_tools.url2pac(url_list.url_list, proxy_addr);


// learnt from http://goo.gl/X8zmc
if (typeof String.prototype.startsWith !== 'function') {
    String.prototype.startsWith = function(str) {
        return this.slice(0, str.length) === str;
    };
}


function get_real_target(req_path) {
    var real_target = {};

    // the 'path' in proxy requests should always start with http
    if (req_path.startsWith('http')) {
        real_target = url.parse(req_path);
    } else {
        var real_url = querystring.parse(url.parse(req_path).query).url;
        if (real_url) {
            var buf = new Buffer(real_url, 'base64');
            real_url = buf.toString();
            real_target = url.parse(real_url);
        }
    }
    if (!real_target.port) {
        real_target.port = 80;
    }
    return real_target;
}


function is_valid_url(target_url) {
    var i;
    for (i = 0; i < url_list.regex_url_list.length; i++) {
        if (url_list.regex_url_list[i].test(target_url)) {
            return true;
        }
    }
    return false;
}


var my_date = new Date();

if (cluster.isMaster) {
    var i, num_CPUs = os.cpus().length;
    for (i = 0; i < num_CPUs; i++) {
        cluster.fork();
    }

    console.log('Please use this PAC file: http://' + proxy_addr + '/proxy.pac');

} else {
    http.createServer(function(request, response) {
        console.info(request.connection.remoteAddress + ': ' + request.method + ' ' + request.url);

        if (request.url === '/favicon.ico') {
            response.writeHead(404);
            response.end();
            return;
        }

        if (request.url === '/crossdomain.xml') {
            response.writeHead(200, {
                'Content-Type': 'text/xml'
            });
            response.end('<?xml version="1.0" encoding="UTF-8"?>\n' +
                '<cross-domain-policy><allow-access-from domain="*"/></cross-domain-policy>');
            return;
        }

        if (request.url === '/proxy.pac') {
            response.writeHead(200, {
                'Content-Type': 'application/x-ns-proxy-autoconfig'
            });
            response.end(pac_file_content);
            return;
        }

        var target = get_real_target(request.url);
        if (!target.host) {
            response.writeHead(403);
            response.end();
            return;
        }

        var req_options;
        if (is_valid_url(target.href)) {
            var sogou_auth = sogou.new_sogou_auth_str();
            var timestamp = Math.round(my_date.getTime() / 1000).toString(16);
            var sogou_tag = sogou.compute_sogou_tag(timestamp, target.hostname);

            request.headers['X-Sogou-Auth'] = sogou_auth;
            request.headers['X-Sogou-Timestamp'] = timestamp;
            request.headers['X-Sogou-Tag'] = sogou_tag;

            var random_ip = shared_tools.new_random_ip();
            request.headers['X-Forwarded-For'] = random_ip;

            request.headers.host = target.host;
            var proxy_server = sogou.new_sogou_proxy_addr();
            req_options = {
                hostname: proxy_server,
                path: target.href,
                method: request.method,
                headers: request.headers
            };
        } else {
            response.writeHead(403);
            response.end();
            return;
        }

        var proxy_req = http.request(req_options, function(res) {
            res.on('data', function(chunk) {
                response.write(chunk);
            });
            res.on('end', function() {
                response.end();
            });
            res.on('error', function(err) {
                console.error('Proxy Error: ' + err.message);
            });

            response.writeHead(res.statusCode, res.headers);
        });

        request.on('data', function(chunk) {
            proxy_req.write(chunk);
        });
        request.on('end', function() {
            proxy_req.end();
        });
        request.on('error', function(err) {
            console.error('Server Error: ' + err.message);
        });
    }).listen(server_port, server_addr);

    console.log('Listening on ' + server_addr + ':' + server_port);
}


process.on('uncaughtException', function(err) {
    console.error('Caught exception: ' + err);
});


